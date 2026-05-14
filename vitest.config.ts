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
        "src/auth/oauth-login.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/device-flow.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/jwt-mint.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/membership-cache.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/allowlist.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/providers/github.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // "src/auth/service-tokens.ts":    { branches: 100 },
        "src/auth/cookies.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/request-id.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/audit-context.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/audit.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/audit-queue.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/org-settings.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/rate-limit.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/login-lockout.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/discovery.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/response-contract.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/observability/logger.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/health.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/observability/metrics.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/metrics.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/auth-routes.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/pages/device.html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/pages/device-confirm.html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/pages/success.html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
      },
    },
  },
});
