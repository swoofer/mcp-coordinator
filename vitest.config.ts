import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Include both `.test.ts` (the main suite) and `*-self-test.ts` (harness
    // wiring proofs that live alongside the helpers they exercise). Self-test
    // files use the explicit suffix so they're easy to spot in `git ls-files`
    // but still picked up by the runner.
    include: ["tests/**/*.test.ts", "tests/**/*-self-test.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "src/**/*.ts",
        "tests/helpers/encryption.ts",
        "tests/helpers/admin-session.ts",
        "cli/lib/**/*.ts",
        "cli/encryption/**/*.ts",
        // T09: admin-UI shared frontend modules. Plain ES so v8 can
        // instrument them directly — no transform required.
        "dashboard/public/admin-common.js",
        "dashboard/public/admin-strings.js",
      ],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "dist/**"],
      // Phase 2 security-critical files require 100% branch coverage
      // per spec §15.6 + V4 + V2 patches §C.3. Per-file thresholds are
      // commented out until the files land — uncomment as each task ships:
      thresholds: {
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/auth/refresh-rotation.ts": { branches: 95.65, lines: 98.95, statements: 98.97, functions: 100 },
        "src/auth/csrf.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/token-epoch.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/oauth-state.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/auth/oauth-login.ts": { branches: 85.71, lines: 92.1, statements: 92.1, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/auth/oauth-callback.ts": { branches: 84.72, lines: 94.81, statements: 94.16, functions: 87.5 },
        "src/auth/audit-helpers.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/device-flow.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/jwt-mint.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/oauth-finalize.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/auth/oauth-token.ts": { branches: 75.8, lines: 92.56, statements: 91.93, functions: 91.66 },
        "src/auth/logout.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/userinfo.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/membership-cache.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/allowlist.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/auth/providers/github.ts": { branches: 100, lines: 97.82, statements: 97.82, functions: 85.71 },
        "src/auth/service-tokens.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/admin/handle-service-tokens.ts": { branches: 93.33, lines: 100, statements: 100, functions: 100 },
        "src/admin/validate.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/cookies.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/request-id.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/audit-context.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/audit.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/security/audit-queue.ts": { branches: 95.45, lines: 100, statements: 100, functions: 100 },
        "src/auth/html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/org-settings.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/rate-limit.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/login-lockout.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/discovery.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/response-contract.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/observability/logger.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/health.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/observability/metrics.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/observability/encryption-status.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/metrics.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/http/auth-routes.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/pages/device.html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/pages/device-confirm.html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/auth/pages/success.html.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/sweeper/index.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/audit-events.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "src/boot.ts": { branches: 98.11, lines: 100, statements: 100, functions: 100 },
        // T01 V2 PATCH 10: pre-stubbed per-file thresholds for the 11
        // forthcoming Phase 3 encryption files. Entries are commented
        // out until each file lands — uncomment per task as it ships.
        "src/security/encryption.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/encrypt-nullable.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/envelope-encryption.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/master-key.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "tests/helpers/encryption.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "tests/helpers/admin-session.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/boot-encryption.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/security/audit-pseudonym.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "cli/lib/pid-lock.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "cli/encryption/index.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "cli/encryption/migrate.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "cli/encryption/verify.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "cli/encryption/fingerprint.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T07): "src/security/key-rotation.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T08): "src/security/dek-cache.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T09): "src/security/kek-provider.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T10): "src/security/encrypted-columns.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T11): "src/security/encryption-metrics.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T12): "src/security/encryption-audit.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // ---- v0.10.6 admin-UI (T03 V2 PATCH 6): pre-stubbed per-file thresholds ----
        // T03 ships the boot guard + UNIQUE INDEX migration; threshold enforced now.
        "src/boot-orgs-uniqueness.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // The following entries are pre-stubbed (commented) so that the PRs that
        // land each admin file can simply uncomment its line — no merge conflict
        // on the shared `coverage.thresholds` block. Mirrors the v0.10.5 T01
        // pre-stubbing pattern (encryption files above).
        // TODO(T04): "src/admin/validate.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        "src/admin/handle-admin-orgs.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(T06): "src/admin/handle-admin-users.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(TH):  "tests/helpers/admin-session.ts": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // T09: shared frontend modules for the admin pages.
        "dashboard/public/admin-strings.js": { branches: 100, lines: 100, statements: 100, functions: 100 },
        // TODO(coverage-ratchet): remonter à 100 — cf. audit tests-01
        "dashboard/public/admin-common.js": { branches: 97.43, lines: 98.03, statements: 97.29, functions: 81.81 },
        // T11 admin-orgs.js: intentionally NOT pinned to a per-file
        // threshold. The module is glue code (DOM event wiring +
        // fetchJSON calls) whose behavior surface would require a full
        // jsdom harness to exercise meaningfully — jsdom is not in
        // devDependencies (see admin-common.test.ts comment). The smoke
        // test (admin-orgs-html.test.ts) covers the HTML invariants;
        // T09 helpers carry the logic that's worth pinning. Mirrors
        // admin.js + admin-users.js policy.
      },
    },
  },
});
