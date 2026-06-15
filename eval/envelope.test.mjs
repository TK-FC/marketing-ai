// Offline unit test for the envelope parser (no network). Run: node eval/envelope.test.mjs
// This is the riskiest pure logic in the Worker; the live eval set covers behaviour end-to-end.

import { trySplit, parseHeader } from "../src/envelope.js";

let failures = 0;
function ok(name, cond) {
  if (cond) { console.log("  ok   " + name); }
  else { failures++; console.log("  FAIL " + name); }
}
function eq(name, a, b) { ok(name + " (" + JSON.stringify(a) + ")", JSON.stringify(a) === JSON.stringify(b)); }

// Full parse: in_scope
{
  const raw = '{"route":"in_scope","modules":["content-that-sells"],"deferral":"none"}\n---\nPost with purpose.\n\n→ FC Class: Content that Sells';
  const s = trySplit(raw);
  ok("in_scope: separator found", !!s);
  const env = parseHeader(s.headerRaw);
  eq("in_scope: route", env.route, "in_scope");
  eq("in_scope: modules", env.modules, ["content-that-sells"]);
  eq("in_scope: deferral", env.deferral, "none");
  ok("in_scope: visible stripped of header", s.visible.indexOf("route") < 0 && s.visible.indexOf("Post with purpose") === 0);
}

// oob must have empty modules even if the model puts some in
{
  const raw = '{"route":"oob","modules":["content-that-sells"],"deferral":"monday_call"}\n---\nThat one sits outside the program content.';
  const env = parseHeader(trySplit(raw).headerRaw);
  eq("oob: route", env.route, "oob");
  eq("oob: modules forced empty", env.modules, []);
  eq("oob: deferral", env.deferral, "monday_call");
}

// partial + coach
{
  const raw = '{"route":"partial","modules":["know-your-crowd"],"deferral":"coach"}\n---\nMarketing lens... then coach.';
  const env = parseHeader(trySplit(raw).headerRaw);
  eq("partial: route", env.route, "partial");
  eq("partial: deferral", env.deferral, "coach");
}

// invalid route => null
{
  const env = parseHeader('{"route":"banana","modules":[],"deferral":"none"}');
  ok("invalid route => null", env === null);
}

// invalid module slugs filtered, dupes removed
{
  const env = parseHeader('{"route":"in_scope","modules":["content-that-sells","made-up","content-that-sells","power-of-analytics"],"deferral":"none"}');
  eq("modules filtered + de-duped", env.modules, ["content-that-sells", "power-of-analytics"]);
}

// unknown deferral falls back to none
{
  const env = parseHeader('{"route":"in_scope","modules":["cohesive-branding"],"deferral":"weird"}');
  eq("unknown deferral => none", env.deferral, "none");
}

// no separator yet => keep buffering
{
  ok("no separator => null", trySplit('{"route":"in_scope"') === null);
}

// tolerant: extra dashes and trailing spaces on the separator line
{
  const raw = '{"route":"in_scope","modules":["socials-makeover"],"deferral":"none"}\n-----   \nText';
  const s = trySplit(raw);
  ok("tolerant separator: found", !!s);
  eq("tolerant separator: visible", s.visible, "Text");
}

// tolerant: stray prose before the JSON object still parses
{
  const env = parseHeader('here is the envelope: {"route":"partial","modules":["socials-makeover"],"deferral":"monday_call"} ok');
  eq("stray-wrapped JSON: route", env.route, "partial");
}

// CRLF separator
{
  const raw = '{"route":"in_scope","modules":["power-of-analytics"],"deferral":"none"}\r\n---\r\nAnswer';
  const s = trySplit(raw);
  ok("CRLF separator found", !!s);
  eq("CRLF visible", s.visible, "Answer");
}

console.log("");
if (failures) { console.log(failures + " assertion(s) failed."); process.exit(1); }
console.log("All envelope parser tests passed.");
