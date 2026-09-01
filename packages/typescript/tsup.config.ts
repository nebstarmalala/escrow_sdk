import { defineConfig } from "tsup";

// Dual ESM + CJS on purpose.
//
// A large share of merchant backends - Express and NestJS especially - are
// still CommonJS, and an ESM-only package hands them ERR_REQUIRE_ESM at
// require() time with no workaround short of rewriting their app. The dual
// build costs one config block; being unusable costs the integration.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  // Zero runtime dependencies: nothing to bundle, nothing to exclude. If this
  // ever needs a `noExternal`, something has gone wrong.
  treeshake: true,
});
