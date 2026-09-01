// Regenerates types into a temp file and fails if the committed output differs.
//
// The generated types are committed rather than built on install, so a merchant
// reading node_modules sees real types and nobody needs a Java toolchain to
// consume the package. The tradeoff is that the committed file can fall behind
// the spec. This is the guard for that: the backend already fails CI on router
// vs spec drift, and this is the same check pointed the other way.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(here, "../../../shared/partner-openapi.yaml");
const committed = resolve(here, "../src/types/generated.ts");
const scratch = join(tmpdir(), `escrow-sdk-generated-${process.pid}.ts`);

// Invoke the generator's JS entrypoint through the current node binary rather
// than through `npx`. Node refuses to spawn a .cmd shim without a shell since
// the 20.12 CVE fix, and reaching for `shell: true` to get around that would
// hand the OS shell a path we would then have to quote correctly on two
// platforms. There is no shim here to break.
const cli = resolve(here, "../node_modules/openapi-typescript/bin/cli.js");

try {
  execFileSync(
    process.execPath,
    [cli, spec, "-o", scratch, "--root-types", "--default-non-nullable", "false"],
    { stdio: "inherit" },
  );

  const fresh = readFileSync(scratch, "utf8");
  const onDisk = readFileSync(committed, "utf8");

  if (normalize(fresh) !== normalize(onDisk)) {
    console.error(
      [
        "src/types/generated.ts is out of date with shared/partner-openapi.yaml.",
        "",
        "Run:  npm run generate",
        "and commit the result.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("generated types ok");
} finally {
  rmSync(scratch, { force: true });
}

// Line endings differ between a Windows checkout and Linux CI; that is not
// drift.
function normalize(s) {
  return s.replace(/\r\n/g, "\n").trimEnd();
}
