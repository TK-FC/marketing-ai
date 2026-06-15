// Eval runner: posts each golden question to a DEPLOYED endpoint in eval mode and asserts the
// response envelope. This is the regression net - run it on every prompt change, every KB file
// change, and every annual KB swap. No green, no ship.
//
// Usage:
//   BASE_URL=https://<preview-or-prod-host> EVAL_KEY=<the EVAL_KEY secret> node eval/run-evals.mjs
//   (add VERBOSE=1 to print each visible answer for the human voice/content spot-check)
//
// EVAL_KEY must be set as a Worker secret on the target deploy:  wrangler secret put EVAL_KEY

import { CASES } from "./eval-cases.js";
import { trySplit, parseHeader } from "../src/envelope.js";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const EVAL_KEY = process.env.EVAL_KEY || "";
const VERBOSE = process.env.VERBOSE === "1";

if (!BASE_URL || !EVAL_KEY) {
  console.error("Set BASE_URL and EVAL_KEY. e.g.\n  BASE_URL=https://marketing-ai.foodiecoaches.com EVAL_KEY=... node eval/run-evals.mjs");
  process.exit(2);
}

function assertCase(c, raw) {
  const errors = [];
  const split = trySplit(raw);
  if (!split) {
    errors.push("envelope: no separator found (parse failure)");
    return { errors, env: null, visible: raw };
  }
  const env = parseHeader(split.headerRaw);
  if (!env) {
    errors.push("envelope: header JSON did not parse/validate");
    return { errors, env: null, visible: split.visible };
  }
  if (env.route !== c.route) errors.push("route: expected " + c.route + ", got " + env.route);
  if (c.deferral && env.deferral !== c.deferral) errors.push("deferral: expected " + c.deferral + ", got " + env.deferral);
  for (const slug of c.required || []) {
    if (env.modules.indexOf(slug) < 0) errors.push("modules: missing required '" + slug + "' (got [" + env.modules.join(", ") + "])");
  }
  if (c.route === "oob" && env.modules.length > 0) {
    errors.push("modules: pure oob must be empty (got [" + env.modules.join(", ") + "])");
  }
  return { errors, env, visible: split.visible };
}

async function ask(question) {
  const res = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-eval-key": EVAL_KEY },
    body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + text.slice(0, 300));
  return text;
}

const run = async () => {
  console.log("Running " + CASES.length + " eval cases against " + BASE_URL + "\n");
  let passed = 0;
  const failures = [];

  for (const c of CASES) {
    let raw;
    try {
      raw = await ask(c.q);
    } catch (e) {
      failures.push({ id: c.id, errors: ["request failed: " + e.message] });
      console.log("FAIL " + c.id + "  request failed: " + e.message);
      continue;
    }
    const { errors, env, visible } = assertCase(c, raw);
    if (errors.length === 0) {
      passed++;
      const mods = env && env.modules.length ? " [" + env.modules.join(", ") + "]" : "";
      console.log("PASS " + c.id + "  " + env.route + "/" + env.deferral + mods);
    } else {
      failures.push({ id: c.id, errors, q: c.q });
      console.log("FAIL " + c.id + "  " + errors.join(" | "));
    }
    if (VERBOSE) {
      console.log("       Q: " + c.q);
      console.log("       A: " + String(visible).replace(/\n/g, "\n          ").slice(0, 600));
      if (c.content) console.log("       expect (spot-check): " + c.content);
      if (c.avoid) console.log("       avoid  (spot-check): " + c.avoid);
      console.log("");
    }
  }

  console.log("\n" + passed + "/" + CASES.length + " passed.");
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  " + f.id + ": " + f.errors.join(" | "));
    process.exit(1);
  }
  console.log("All hard assertions green. Spot-check the ✓/✗ content notes in 06-eval-set.md by hand.");
};

run().catch((e) => { console.error(e); process.exit(1); });
