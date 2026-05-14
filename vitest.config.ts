import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "dist/**"],
      // Phase 2 security-critical files require 100% branch coverage
      // per spec §15.6 + V4 + V2 patches §C.3. Per-file thresholds are
      // commented out until the files land — uncomment as each task ships:
      thresholds: {
        // "src/auth/refresh-rotation.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/csrf.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/token-epoch.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/oauth-state.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // "src/auth/jwt-mint.ts":          { branches: 100 },
        // "src/auth/membership-cache.ts":  { branches: 100 },
        // "src/auth/service-tokens.ts":    { branches: 100 },
        "src/auth/cookies.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
      },
    },
  },
});
