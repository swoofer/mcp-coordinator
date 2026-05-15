import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for T39 OAuth E2E suite.
 *
 * - testDir = tests/e2e/ ; spec files use *.spec.ts (vitest uses *.test.ts
 *   from tests/, so the two suites don't overlap).
 * - workers=1 + fullyParallel=false: each test spawns its own coordinator
 *   subprocess and listens on a (newly-allocated) port; serialising avoids
 *   any chance of port contention or shared-DB drift between parallel
 *   coordinator children.
 * - Chromium only — V2 §B T39 explicitly scopes Firefox/WebKit out for v0.8.x.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    actionTimeout: 5_000,
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
