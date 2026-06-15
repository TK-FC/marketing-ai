// Kajabi referrer gate (page route) + short-TTL signed token the chat API requires.
//
// Why a token: the iframe's fetches to /api/chat are same-origin to the Worker, so the API
// route can't see the Kajabi Referer. The gated page mints a signed, short-lived token; the
// API verifies it. This stops trivial direct curls of the API. It is light protection by
// design (acknowledged in 02-stack.md); durable rate limiting is the real backstop.
//
// GATE_SIGNING_SECRET is a Worker secret. The minted token is NOT a secret (it is a
// capability the browser is meant to hold), so injecting it into the page is fine.

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintToken(env) {
  const ttl = parseInt(env.GATE_TOKEN_TTL_SECONDS || "28800", 10);
  const exp = Math.floor(Date.now() / 1000) + (Number.isFinite(ttl) ? ttl : 28800);
  const sig = await hmac(env.GATE_SIGNING_SECRET, String(exp));
  return exp + "." + sig;
}

export async function verifyToken(env, token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(env.GATE_SIGNING_SECRET, exp);
  return timingSafeEqual(sig, expected);
}

// Allow the page when the Referer origin is the Kajabi host, or (Referer stripped) when the
// browser tells us this is an iframe load. Otherwise we serve the friendly block page.
export function pageAllowed(request, env) {
  const ref = request.headers.get("Referer");
  if (ref) {
    try {
      if (new URL(ref).origin === env.KAJABI_ORIGIN) return true;
    } catch (_) {
      // malformed Referer: fall through to the iframe signal
    }
  }
  if (request.headers.get("Sec-Fetch-Dest") === "iframe") return true;
  return false;
}

// Frame-ancestors lets the tool load inside the Kajabi iframe but blocks other sites embedding it.
export function frameAncestors(env) {
  const origin = env.KAJABI_ORIGIN || "https://foodie-coaches-program.mykajabi.com";
  return "frame-ancestors " + origin + " https://*.mykajabi.com;";
}

export function blockPageResponse(env) {
  const url = env.KAJABI_PAGE_URL || env.KAJABI_ORIGIN || "#";
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Foodie Coaches</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@500;600;700&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap" rel="stylesheet">' +
    '<style>' +
    ':root{--gold:#F2A900;--black:#0D0D0D;--cream:#FAF7F2;--text:#2A2420;--muted:#8C8075;--border:rgba(13,13,13,0.08)}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:var(--cream);background-image:radial-gradient(40rem 40rem at 100% 0,rgba(242,169,0,0.10),transparent),radial-gradient(40rem 40rem at 0 100%,rgba(242,169,0,0.08),transparent);' +
    'font-family:"DM Sans",system-ui,sans-serif;color:var(--text);padding:1.5rem;line-height:1.55}' +
    '.card{max-width:30rem;text-align:left}' +
    '.rule{height:3px;width:48px;background:var(--gold);margin:0 0 1.25rem}' +
    'h1{font-family:"Khand",sans-serif;font-weight:700;font-size:2rem;line-height:1.1;margin:0 0 .75rem;color:var(--black)}' +
    'p{font-weight:300;font-size:1.05rem;margin:0 0 1.5rem;color:var(--text)}' +
    'a.btn{display:inline-block;background:var(--gold);color:var(--black);text-decoration:none;' +
    'font-family:"DM Sans",sans-serif;font-weight:500;padding:.7rem 1.25rem;border-radius:10px;' +
    'box-shadow:0 6px 18px rgba(242,169,0,0.28)}' +
    '.brand{font-family:"Khand",sans-serif;font-weight:600;letter-spacing:.02em;color:var(--muted);text-transform:uppercase;font-size:.8rem;margin:0 0 1.5rem}' +
    '</style></head><body><div class="card">' +
    '<div class="brand">Foodie Coaches</div>' +
    '<div class="rule"></div>' +
    '<h1>This tool lives inside your member portal</h1>' +
    '<p>This tool lives inside the Foodie Coaches member portal. Head to your program page and open it from there.</p>' +
    '<a class="btn" href="' + escapeAttr(url) + '">Open the program page</a>' +
    '</div></body></html>';
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": frameAncestors(env),
    },
  });
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
