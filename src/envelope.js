// The response envelope: the model emits one compact JSON line, then a separator line of
// three or more hyphens, then the member-visible answer. The Worker buffers the head of the
// stream until it finds the separator, validates the JSON, and strips everything through it.
//
//   {"route":"in_scope","modules":["content-that-sells"],"deferral":"none"}
//   ---
//   <visible answer>
//
// Evals assert the parsed envelope (route / modules / deferral), never the visible copy.

export const ROUTES = ["in_scope", "partial", "oob"];
export const DEFERRALS = ["none", "monday_call", "coach", "people_assistant"];
export const MODULE_SLUGS = [
  "kickoff-2025",
  "cohesive-branding",
  "know-your-crowd",
  "socials-makeover",
  "website-google-crash-course",
  "content-that-sells",
  "power-of-analytics",
  "contagious-content",
  "loyalty-programs",
];

// Buffer past this many bytes without a separator => declare an envelope parse failure.
export const MAX_HEADER_BYTES = 600;

// newline, then 3+ dashes, optional trailing whitespace, then newline.
const SEP = /\r?\n-{3,}[ \t]*\r?\n/;

// Returns { headerRaw, visible } once the separator is present in the buffer, else null.
export function trySplit(buffer) {
  const m = SEP.exec(buffer);
  if (!m) return null;
  return { headerRaw: buffer.slice(0, m.index), visible: buffer.slice(m.index + m[0].length) };
}

// Validate + normalise the JSON header. Returns { route, modules, deferral } or null if invalid.
export function parseHeader(headerRaw) {
  if (!headerRaw) return null;
  let obj = null;
  try {
    obj = JSON.parse(headerRaw.trim());
  } catch (_) {
    // tolerate stray characters around the JSON object
    const s = headerRaw.indexOf("{");
    const e = headerRaw.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try { obj = JSON.parse(headerRaw.slice(s, e + 1)); } catch (_) { return null; }
    } else {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const route = ROUTES.indexOf(obj.route) >= 0 ? obj.route : null;
  if (!route) return null;
  const deferral = DEFERRALS.indexOf(obj.deferral) >= 0 ? obj.deferral : "none";
  let modules = Array.isArray(obj.modules) ? obj.modules.filter((m) => MODULE_SLUGS.indexOf(m) >= 0) : [];
  modules = modules.filter((m, i) => modules.indexOf(m) === i); // de-dupe
  if (route === "oob") modules = []; // a pure oob answer names no modules
  return { route, modules, deferral };
}
