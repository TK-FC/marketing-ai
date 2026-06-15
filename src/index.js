// Worker entry / router for the Foodie Coaches Marketing AI.
//
//   GET  /health     -> 200 + PROMPT_VERSION (for the FC internal dashboard cron)
//   GET  /           -> Kajabi referrer gate; serves the chat UI (token injected) or block page
//   POST /api/chat   -> verifies the page token (or EVAL_KEY), then streams a grounded answer
//
// The system prompt + KB live only in the generated bundle imported by chat.js. Nothing
// sensitive is ever sent to the browser: only the short-TTL gate token (a capability, not a
// secret) is injected into the page.

import { PROMPT_VERSION, PAGE_HTML } from "./generated/bundle.js";
import { pageAllowed, blockPageResponse, mintToken, verifyToken, frameAncestors } from "./gate.js";
import { handleChat } from "./chat.js";
import { STATE } from "./copy.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return json({ status: "ok", promptVersion: PROMPT_VERSION }, 200);
    }

    if (path === "/" || path === "") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!pageAllowed(request, env)) return blockPageResponse(env);
      const token = await mintToken(env);
      const boot = JSON.stringify({ token: token }).replace(/</g, "\\u003c");
      const html = PAGE_HTML.replace("__FC_BOOT_JSON__", boot);
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": frameAncestors(env),
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (path === "/api/chat") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // Eval mode: gated by the EVAL_KEY secret (unset in normal production). Bypasses the page
      // token and limits, returns the RAW model output (envelope included) so the eval runner can
      // assert routing against the deployed Worker. See eval/run-evals.mjs.
      const isEval = !!env.EVAL_KEY && request.headers.get("x-eval-key") === env.EVAL_KEY;
      if (!isEval) {
        const token = request.headers.get("x-fc-token");
        if (!(await verifyToken(env, token))) {
          return new Response("", {
            status: 401,
            headers: { "content-type": "text/plain; charset=utf-8", "x-fc-state": STATE.GATE },
          });
        }
      }
      return handleChat(request, env, ctx, isEval);
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
