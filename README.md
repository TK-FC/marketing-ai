# Marketing AI (working name)

A member-facing AI chatbot that answers hospitality marketing questions **strictly** from the Foodie Coaches marketing knowledge base (the "Crushing Your Marketing in 2025" Tuesday Teach series + the Contagious Content class). It is grounded by context-stuffing the full 9-file KB into a cached system prompt. There is no retrieval layer. It runs as a single Cloudflare Worker, embedded in the Kajabi member portal.

It never invents marketing advice. Every grounded answer names its source class. Anything outside the KB is routed to the Monday Marketing call, the member's FC coach (ops/costing), or the People Assistant AI / Thursday People Call (people questions). Out-of-bounds and partial questions are logged (question text only) to feed the Monday call agenda.

> Name and domain are provisional (`marketing-assistant-ai.foodiecoaches.com`). Renaming before launch = update the route in `wrangler.toml`, the DNS record, and the iframe `src` in `kajabi-embed.html`, then redeploy. Confirm the final name with Sam at deploy time.

---

## How it works (one screen)

```
Kajabi page  ──iframe──▶  Worker GET /            ──gate ok──▶  serves chat UI + a short-TTL signed token
                          Worker POST /api/chat    ──token ok─▶  Anthropic (Sonnet 4.6, cached system+KB, streaming)
                                                                  │ strips the route envelope, relays the answer
                                                                  │ ctx.waitUntil → Supabase oob_questions  (oob/partial only)
                                                                  └ KV: daily per-IP count + monthly $ counter
                          Worker GET /health       ───────────▶  200 + PROMPT_VERSION  (dashboard cron)
```

The model emits a machine-readable envelope as the first line of every answer:

```
{"route":"in_scope","modules":["content-that-sells"],"deferral":"none"}
---
<the member-visible answer>
```

The Worker parses and strips it before the browser sees anything. Evals assert the envelope; the OOB log is written from it.

---

## Repo layout

```
marketing-ai/
├─ wrangler.toml            # config, routes, KV + ratelimit bindings, [build] hook, [vars]
├─ package.json             # scripts: build, dev, deploy, tail, eval, check
├─ prompt/
│  ├─ 00-system-frame.md    # identity, voice, grounding invariants, canonical copy, referral map, envelope spec
│  └─ manifest.json         # kbManifest + promptRev + KB file order/slugs (bump on any prompt/KB change)
├─ kb/                      # the 9 KB files (00..08) that ship in the prompt bundle
├─ scripts/
│  ├─ build-prompt.mjs      # concatenates frame + KB + page HTML -> src/generated/bundle.js, bakes PROMPT_VERSION
│  └─ check-syntax.mjs      # node --check every JS module + the inline UI script
├─ src/
│  ├─ index.js              # router: /health, / (gate + page), /api/chat
│  ├─ gate.js               # Kajabi referrer gate + short-TTL signed token
│  ├─ ratelimit.js          # durable daily (KV) + burst (binding) + monthly $ ceiling (KV)
│  ├─ chat.js               # Anthropic streaming, envelope strip, OOB log, cost accounting, eval mode
│  ├─ envelope.js           # envelope parse/validate (unit-tested, reused by the eval runner)
│  ├─ supabase.js           # oob_questions insert (service-role, fire-and-forget)
│  ├─ copy.js               # canonical Worker-side copy (limit/ceiling/error) + state flags
│  └─ generated/bundle.js   # GENERATED at build (gitignored) - SYSTEM_PROMPT, PROMPT_VERSION, PAGE_HTML
├─ ui/index.html            # the chat UI (FC brand). Built into the bundle. FC logo SVG slot marked inside.
├─ eval/
│  ├─ eval-cases.js         # the 29 golden cases, machine-readable
│  ├─ run-evals.mjs         # posts each case to a deployed endpoint (eval mode) and asserts routing
│  └─ envelope.test.mjs     # offline unit test of the envelope parser
├─ sql/001_oob_questions.sql# the OOB log table (run in the Supabase web SQL editor)
└─ kajabi-embed.html        # the iframe snippet to paste into the Kajabi page
```

---

## Deploy (run from your terminal, in this order)

`wrangler`, `supabase`, and `gh` are already authed in your terminal. Cloudflare DNS and the Supabase project are created in the web dashboards (not CLI), as noted.

### 0. Install + sanity check
```bash
cd marketing-ai
npm install
npm run build      # writes src/generated/bundle.js and prints PROMPT_VERSION
npm run check      # node --check every module + the UI script
node eval/envelope.test.mjs   # offline parser test (no network)
```

### 1. Create the GitHub repo and push
```bash
git init && git add -A && git commit -m "Initial build: Marketing AI"   # the repo arrives uncommitted; this creates the initial commit
gh repo create foodiecoaches/marketing-ai --private --source=. --remote=origin --push
```

### 2. Create the Supabase project (web UI)
Create a **new** Supabase project for this tool. From its dashboard grab the **Project URL** and the **service-role key** (Project Settings → API).

### 3. Create the OOB log table (Supabase web SQL editor)
Paste and run `sql/001_oob_questions.sql`. Plain SQL only (the web editor does not support psql meta-commands).

### 4. Point the Worker at Supabase
Edit `wrangler.toml` → `[vars] SUPABASE_URL` to your project URL.

### 5. Create the KV namespace and paste the ids
```bash
wrangler kv namespace create RL
wrangler kv namespace create RL --preview
```
Paste the returned `id` and `preview_id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 6. Set the secrets (never in code or wrangler.toml)
```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GATE_SIGNING_SECRET        # any long random string: openssl rand -hex 32
# Optional, only to run the eval set against this deploy:
wrangler secret put EVAL_KEY                    # any random string; the runner sends it
```

### 7. Create the DNS record (launchaccounting Cloudflare dashboard, web UI)
In the `foodiecoaches.com` zone, add a **proxied** record for `marketing-ai` so the subdomain exists before first deploy. The route in `wrangler.toml` binds the Worker to it.

### 8. Deploy
```bash
wrangler deploy    # the [build] hook regenerates the bundle first, so PROMPT_VERSION always matches what ships
```

### 9. Embed in Kajabi
Paste `kajabi-embed.html` into a Custom Code / HTML block on the member page.

### 10. Smoke test on a phone, inside Kajabi (not the bare Worker URL)
Run the 8-step smoke test in `../handoff/04-acceptance.md`. "wrangler deploy succeeded" is **not** done. Done = the real flow works in the Kajabi iframe on a phone.

---

## The eval gate (run on every prompt/KB change - no green, no ship)

The runner posts the 29 golden questions to a deployed endpoint in **eval mode** (raw envelope returned) and asserts `route`, `deferral`, and required `modules`.

```bash
# Set EVAL_KEY as a secret on the target deploy first (step 6). Use a preview or production host.
BASE_URL=https://marketing-assistant-ai.foodiecoaches.com EVAL_KEY=<your EVAL_KEY> npm run eval
# add VERBOSE=1 to print each answer for the human voice / content spot-check
```

Hard assertions are scripted. The ✓/✗ content notes in `../handoff/06-eval-set.md` are spot-checked by hand at launch. A response whose envelope cannot be parsed is an automatic failure.

---

## Local development
```bash
cp .dev.vars.example .dev.vars     # fill in ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, GATE_SIGNING_SECRET
npm run dev                        # builds the bundle, then wrangler dev (KV + ratelimit simulated locally)
```
The gate also passes for `Sec-Fetch-Dest: iframe`, so to test the page locally open it framed, or temporarily hit `/health`. To exercise routing locally, set `EVAL_KEY` in `.dev.vars` and run the eval runner against `http://localhost:8787`.

---

## KB / prompt versioning (the regression-safe swap)

The KB rides in the system prompt, so **every KB edit is a prompt change.**

1. Edit `prompt/00-system-frame.md` and/or files in `kb/`.
2. Bump `prompt/manifest.json` (`promptRev` for frame changes, `kbManifest` for a KB swap). The content hash in `PROMPT_VERSION` also changes automatically.
3. `npm run build` → deploy to a **preview**.
4. `npm run eval` against the preview → must be green.
5. Only then deploy to production.

Annual series swap: replace/add KB files, major-bump `kbManifest`, extend `eval/eval-cases.js` + `../handoff/06-eval-set.md` with traps for the new content, review the referral map for changed class names, re-run the full set, ship on green.

If Taylor supplies the engagement-rate method: patch `kb/07-analytics-and-measurement.md`, bump the version, change E23's expectation to `in_scope`, re-run.

---

## Operating notes

- **Debugging:** `npm run tail` (`wrangler tail`). Server errors never reach the browser Network tab. The chat handler logs route, token usage, cache reads, and a per-call cost estimate.
- **Cost ceiling:** monthly spend accumulates in KV (micro-dollars). Alert is logged in `wrangler tail` at $50; hard stop at $100 returns the at-capacity copy without calling the provider. Raise via `[vars] MONTHLY_CEILING_USD`.
- **Rate limits:** `[vars] RATE_LIMIT_DAILY` (default 40/day per IP); burst is 10/60s in `[[ratelimits]]`. Temporarily lower `RATE_LIMIT_DAILY` to verify the daily path, then restore and redeploy.
- **Privacy:** no conversation storage; chat history lives only in the browser session (last 8 turns sent to the model). The only persisted data is `oob_questions`: question text, route, deferral, modules, prompt_version. No IPs, no member identifiers. Member-facing copy makes no storage claims either way.
- **Secrets:** `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GATE_SIGNING_SECRET` (and optional `EVAL_KEY`) are Worker secrets only. Nothing sensitive is in `wrangler.toml`, the bundle, or the served page.
- **FC logo:** `ui/index.html` uses a text wordmark with a clearly-marked slot. Drop in the official FC logo SVG from `fc-html-brand-full.md` when available (verbatim).

## Phase 2 (deferred, by design - see `../handoff/01-spec.md`)
OOB-log review surface · referral lines as Kajabi deep links · per-answer thumbs feedback · dynamic follow-up chips · image/profile critique · copy/share button · usage analytics view.
