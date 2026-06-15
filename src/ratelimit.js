// Durable rate limiting + monthly cost ceiling.
//
// - Burst (10/min per IP): Cloudflare Rate Limiting binding (env.BURST). Durable, per-location.
// - Daily cap (40/day per IP): KV counter. Eventual consistency is fine for an abuse cap.
// - Monthly cost ceiling: KV counter of spend in micro-dollars (USD * 1e6) to avoid float drift.
//
// Everything fails OPEN: if KV or the binding is unavailable we answer anyway and log the miss
// to `wrangler tail`. Availability beats strictness for a member tool (02-stack.md).

function dayKey(ip) {
  return "d:" + ip + ":" + new Date().toISOString().slice(0, 10); // UTC date
}
function monthKey() {
  return "c:" + new Date().toISOString().slice(0, 7); // UTC YYYY-MM
}

export async function burstOk(env, ip) {
  try {
    if (!env.BURST) {
      console.log("ratelimit: BURST binding missing, failing open");
      return true;
    }
    const { success } = await env.BURST.limit({ key: "burst:" + ip });
    return success !== false;
  } catch (e) {
    console.log("ratelimit: burst check failed open:", e && e.message);
    return true;
  }
}

export async function getDailyCount(env, ip) {
  try {
    if (!env.RL) return 0;
    const v = await env.RL.get(dayKey(ip));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch (e) {
    console.log("ratelimit: daily read failed open:", e && e.message);
    return 0;
  }
}

export async function dailyLimitReached(env, ip) {
  const limit = parseInt(env.RATE_LIMIT_DAILY || "40", 10);
  const count = await getDailyCount(env, ip);
  return count >= (Number.isFinite(limit) ? limit : 40);
}

// Only called after a successful, completed answer.
export async function incrDaily(env, ip) {
  try {
    if (!env.RL) return;
    const k = dayKey(ip);
    const cur = await env.RL.get(k);
    const next = (cur ? parseInt(cur, 10) || 0 : 0) + 1;
    await env.RL.put(k, String(next), { expirationTtl: 172800 }); // 2 days
  } catch (e) {
    console.log("ratelimit: daily incr failed:", e && e.message);
  }
}

export async function getMonthlyMicros(env) {
  try {
    if (!env.RL) return 0;
    const v = await env.RL.get(monthKey());
    return v ? parseInt(v, 10) || 0 : 0;
  } catch (e) {
    console.log("ratelimit: cost read failed open:", e && e.message);
    return 0;
  }
}

export async function monthlyCeilingReached(env) {
  const ceiling = Math.round(parseFloat(env.MONTHLY_CEILING_USD || "100") * 1e6);
  const cur = await getMonthlyMicros(env);
  return cur >= ceiling;
}

export async function addMonthlyCost(env, micros) {
  try {
    if (!env.RL || !micros) return;
    const k = monthKey();
    const cur = await env.RL.get(k);
    const prev = cur ? parseInt(cur, 10) || 0 : 0;
    const next = prev + Math.round(micros);
    await env.RL.put(k, String(next), { expirationTtl: 3456000 }); // 40 days
    const alert = Math.round(parseFloat(env.MONTHLY_ALERT_USD || "50") * 1e6);
    if (prev < alert && next >= alert) {
      console.log(
        "COST ALERT: " + monthKey() + " monthly spend crossed $" +
        (alert / 1e6).toFixed(2) + " (now ~$" + (next / 1e6).toFixed(4) + ")"
      );
    }
  } catch (e) {
    console.log("ratelimit: cost incr failed:", e && e.message);
  }
}

// Claude Sonnet 4.6 pricing, USD per million tokens. Update here if pricing changes.
const PRICE = { input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 };

// Returns spend for one call in micro-dollars, from the Anthropic usage object.
export function estimateCostMicros(usage) {
  if (!usage) return 0;
  const inTok = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const usd = (inTok * PRICE.input + out * PRICE.output + cw * PRICE.cacheWrite5m + cr * PRICE.cacheRead) / 1e6;
  return Math.round(usd * 1e6);
}
