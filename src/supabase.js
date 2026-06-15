// Out-of-bounds question log: one insert into the `oob_questions` table via Supabase's REST
// endpoint, using the service-role key (a Worker secret, never in the browser).
//
// Fire-and-forget: callers wrap this in ctx.waitUntil so logging never delays or blocks the
// answer. It never throws to the caller; failures are logged to `wrangler tail` only.
//
// We log only: question, route, deferral, modules, prompt_version. No IPs, no member
// identifiers, no conversation history (per the locked privacy posture).

export async function logOob(env, row) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.log("supabase: not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), skipping log");
      return;
    }
    const endpoint = env.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/oob_questions";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        question: row.question,
        route: row.route,
        deferral: row.deferral,
        modules: Array.isArray(row.modules) ? row.modules : [],
        prompt_version: row.prompt_version,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.log("supabase: insert failed " + res.status + " " + t.slice(0, 300));
    }
  } catch (e) {
    console.log("supabase: insert error:", e && e.message);
  }
}
