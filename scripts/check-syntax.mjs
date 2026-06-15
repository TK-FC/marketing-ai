// `npm run check`: syntax-check every JS module (node --check) and the inline UI script.
// The UI script is extracted from ui/index.html and checked separately, honouring the FC
// rule "node --check passes before presenting".

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;

function check(file) {
  try {
    execSync("node --check " + JSON.stringify(file), { stdio: "pipe" });
    console.log("  ok   " + file);
  } catch (e) {
    failures++;
    console.log("  FAIL " + file);
    console.log(String(e.stderr || e.message).trim());
  }
}

function jsFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f) => join(dir, f));
}

console.log("Checking JS modules:");
["src", "src/generated", "scripts", "eval"].forEach((d) => jsFilesIn(d).forEach(check));

console.log("Checking inline UI script(s):");
const html = readFileSync("ui/index.html", "utf8");
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
let idx = 0;
const tmp = mkdtempSync(join(tmpdir(), "fc-ui-"));
while ((m = re.exec(html)) !== null) {
  const body = m[1].trim();
  if (!body) continue;
  idx++;
  const f = join(tmp, "ui-script-" + idx + ".js");
  writeFileSync(f, body);
  check(f);
}

if (failures > 0) {
  console.log("\n" + failures + " file(s) failed the syntax check.");
  process.exit(1);
}
console.log("\nAll syntax checks passed.");
