// Chat API: build the message window, run the limit checks, call the Anthropic Messages API
// (streaming, cached system block), strip the response envelope while relaying the visible
// answer, then account for usage and log out-of-bounds questions.

import { SYSTEM_PROMPT, PROMPT_VERSION } from "./generated/bundle.js";
import { trySplit, parseHeader, MAX_HEADER_BYTES } from "./envelope.js";
import { COPY, STATE } from "./copy.js";
import {
  burstOk,
  dailyLimitReached,
  monthlyCeilingReached,
  incrDaily,
  addMonthlyCost,
  estimateCostMicros,
} from "./ratelimit.js";
import { logOob } from "./supabase.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export async function handleChat(request, env, ctx, isEval) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return textState(STATE.BAD_INPUT, "", 400);
  }

  const built = buildMessages(payload, env);
  if (!built.ok) return textState(STATE.BAD_INPUT, "", 400);

  // Eval mode: no limits, no logging, no streaming. Return the raw model output (envelope +
  // answer) so the runner can assert routing against this exact deployed Worker.
  if (isEval) return handleEval(env, built.messages);

  // 1) Burst limit (durable, per IP). Does not consume the daily count or call the provider.
  if (!(await burstOk(env, ip))) return textState(STATE.BURST, "", 429);

  // 2) Daily cap. Canonical copy, input disabled client-side until the window resets.
  if (await dailyLimitReached(env, ip)) return textState(STATE.DAILY_LIMIT, COPY.dailyLimit, 200);

  // 3) Monthly cost ceiling. Returned without calling the provider.
  if (await monthlyCeilingReached(env)) return textState(STATE.MONTHLY_CEILING, COPY.monthlyCeiling, 200);

  // 4) Call Anthropic. A failure here does NOT consume the daily count.
  let res;
  try {
    res = await callAnthropic(env, built.messages, true);
  } catch (e) {
    console.log("chat: provider fetch threw:", e && e.message);
    return textState(STATE.ERROR, COPY.providerError, 200);
  }
  if (!res || !res.ok || !res.body) {
    const t = res ? await res.text().catch(() => "") : "";
    console.log("chat: provider non-2xx " + (res && res.status) + " " + String(t).slice(0, 300));
    return textState(STATE.ERROR, COPY.providerError, 200);
  }

  // 5) Stream the visible answer. The pump runs in the background; the Response returns now.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  pump(res, writer, env, ctx, built.question, ip);

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-fc-state": STATE.OK,
      "x-prompt-version": PROMPT_VERSION,
    },
  });
}

function textState(state, body, status) {
  return new Response(body || "", {
    status: status || 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-fc-state": state,
    },
  });
}

function callAnthropic(env, messages, stream) {
  const body = {
    model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    max_tokens: parseInt(env.MAX_TOKENS || "1000", 10),
    stream: stream !== false,
    // Single cached system block: the frame + full KB. ~90% cheaper on a warm cache.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: messages,
  };
  return fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

// Eval path: non-streamed call, raw model text returned verbatim (envelope not stripped).
async function handleEval(env, messages) {
  let res;
  try {
    res = await callAnthropic(env, messages, false);
  } catch (e) {
    return new Response("eval_provider_error: " + (e && e.message), { status: 502 });
  }
  if (!res || !res.ok) {
    const t = res ? await res.text().catch(() => "") : "";
    return new Response("eval_provider_non2xx " + (res && res.status) + " " + String(t).slice(0, 500), { status: 502 });
  }
  const data = await res.json().catch(() => null);
  const text = (data && data.content && data.content[0] && data.content[0].text) || "";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-fc-eval": "1" },
  });
}

// Sanitise the client's history into a clean, alternating, user-led window of the last N turns.
function buildMessages(payload, env) {
  const maxChars = parseInt(env.MAX_INPUT_CHARS || "2000", 10);
  const turns = parseInt(env.HISTORY_TURNS || "8", 10);
  const raw = payload && Array.isArray(payload.messages) ? payload.messages : null;
  if (!raw || raw.length === 0) return { ok: false };

  const clean = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (!content.trim()) continue;
    clean.push({ role: m.role, content: content });
  }
  if (clean.length === 0) return { ok: false };

  const last = clean[clean.length - 1];
  if (last.role !== "user") return { ok: false };
  const question = last.content.trim();
  if (!question || question.length > maxChars) return { ok: false };

  let windowed = clean.slice(-turns);
  while (windowed.length && windowed[0].role !== "user") windowed = windowed.slice(1);

  // Collapse any accidental consecutive same-role messages (the API expects alternation).
  const msgs = [];
  for (const m of windowed) {
    if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1] = m;
    else msgs.push(m);
  }
  if (msgs.length === 0 || msgs[0].role !== "user" || msgs[msgs.length - 1].role !== "user") {
    return { ok: false };
  }
  return { ok: true, messages: msgs, question: question };
}

// Read the Anthropic SSE stream, strip the envelope, relay the visible answer, then account.
async function pump(res, writer, env, ctx, question, ip) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  let sseBuf = "";
  let headBuf = "";
  let headerDone = false;
  let parseFailed = false;
  let envelope = null;
  let completed = false;
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  const emit = async (text) => {
    if (text) await writer.write(encoder.encode(text));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = sseBuf.indexOf("\n")) >= 0) {
        const line = sseBuf.slice(0, nl).replace(/\r$/, "");
        sseBuf = sseBuf.slice(nl + 1);
        if (line.indexOf("data:") !== 0) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let evt;
        try { evt = JSON.parse(data); } catch (_) { continue; }

        if (evt.type === "message_start" && evt.message && evt.message.usage) {
          const u = evt.message.usage;
          usage.input_tokens = u.input_tokens || 0;
          usage.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
          usage.cache_read_input_tokens = u.cache_read_input_tokens || 0;
          usage.output_tokens = u.output_tokens || 0;
        } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          const text = evt.delta.text || "";
          if (headerDone) {
            await emit(text);
          } else {
            headBuf += text;
            const split = trySplit(headBuf);
            if (split) {
              envelope = parseHeader(split.headerRaw);
              parseFailed = !envelope;
              headerDone = true;
              if (parseFailed) console.log("chat: envelope_parse_failure (header JSON invalid)");
              await emit(split.visible);
            } else if (headBuf.length > MAX_HEADER_BYTES) {
              parseFailed = true;
              headerDone = true;
              console.log("chat: envelope_parse_failure (no separator within " + MAX_HEADER_BYTES + " bytes)");
              await emit(headBuf);
            }
          }
        } else if (evt.type === "message_delta") {
          if (evt.usage && typeof evt.usage.output_tokens === "number") usage.output_tokens = evt.usage.output_tokens;
        } else if (evt.type === "message_stop") {
          completed = true;
        } else if (evt.type === "error") {
          console.log("chat: provider stream error:", JSON.stringify(evt.error || {}).slice(0, 300));
          throw new Error("provider_stream_error");
        }
      }
    }
    // Stream ended before a separator ever arrived (very short answer): flush what we have.
    if (!headerDone && headBuf) {
      parseFailed = true;
      headerDone = true;
      console.log("chat: envelope_parse_failure (stream ended before separator)");
      await emit(headBuf);
    }
  } catch (e) {
    if (!headerDone && headBuf) { try { await emit(headBuf); } catch (_) {} }
    console.log("chat: stream pump error:", e && e.message);
    completed = false;
  }

  // Side effects run only on a clean completion. The answer bytes are already delivered.
  if (completed) {
    await incrDaily(env, ip);
    const micros = estimateCostMicros(usage);
    await addMonthlyCost(env, micros);
    console.log(
      "chat: ok route=" + (envelope ? envelope.route : "parse_fail") +
      " modules=" + (envelope ? envelope.modules.join("|") : "") +
      " deferral=" + (envelope ? envelope.deferral : "") +
      " in=" + usage.input_tokens +
      " cache_read=" + usage.cache_read_input_tokens +
      " cache_write=" + usage.cache_creation_input_tokens +
      " out=" + usage.output_tokens +
      " ~$" + (micros / 1e6).toFixed(4) +
      " v=" + PROMPT_VERSION
    );
    if (envelope && !parseFailed && (envelope.route === "oob" || envelope.route === "partial")) {
      ctx.waitUntil(
        logOob(env, {
          question: question,
          route: envelope.route,
          deferral: envelope.deferral,
          modules: envelope.modules,
          prompt_version: PROMPT_VERSION,
        })
      );
    }
  }

  try { await writer.close(); } catch (_) {}
}
