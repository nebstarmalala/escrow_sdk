// Fails if shared/partner-openapi.yaml no longer matches the hash recorded in
// shared/SPEC.md.
//
// The spec here is a copy of the backend's frozen contract. A copy that nobody
// checks is a copy that quietly diverges, and the divergence surfaces as a
// merchant's request being rejected in production rather than as a red build.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "../../../shared/partner-openapi.yaml");
const docPath = resolve(here, "../../../shared/SPEC.md");

const actual = createHash("sha256").update(readFileSync(specPath)).digest("hex");

const doc = readFileSync(docPath, "utf8");
const match = doc.match(/`([0-9a-f]{64})`/);
if (!match) {
  console.error("SPEC.md does not record a sha256. Add one.");
  process.exit(1);
}
const expected = match[1];

if (actual !== expected) {
  console.error(
    [
      "shared/partner-openapi.yaml does not match the hash in shared/SPEC.md.",
      "",
      `  recorded: ${expected}`,
      `  actual:   ${actual}`,
      "",
      "If you intentionally took in an additive spec change, update SPEC.md",
      "(commit, version, hash) and regenerate types in BOTH packages.",
      "If you did not, the copy has drifted - restore it from the backend repo.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`spec ok (${actual.slice(0, 12)}…)`);
