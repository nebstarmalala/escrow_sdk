import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The contract suite starts real http.Server instances on ephemeral ports.
    // They are cheap, but they are not free to run in parallel with each other
    // inside one file, so isolation stays per-file rather than per-test.
    pool: "forks",
  },
});
