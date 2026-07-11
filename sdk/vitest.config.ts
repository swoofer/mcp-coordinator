import { defineConfig } from "vitest/config";

// Local, self-contained vitest config for the SDK package. Without this file,
// vitest walks up from `sdk/` and picks up the repo-root `vitest.config.ts`,
// which imports `vitest`/`vitest/config` from the ROOT node_modules — absent
// in a clean CI checkout where only `sdk/node_modules` is installed (see
// `sdk-test` job in .github/workflows). This config keeps the SDK's test
// suite fully independent of the root workspace.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
