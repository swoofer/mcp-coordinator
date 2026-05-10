import { describe, it, expect } from "vitest";
import { canResetDb } from "../../src/reset-guard.js";

describe("canResetDb (B4 fix)", () => {
  it("allows when NODE_ENV=test (auth disabled)", () => {
    expect(canResetDb({ NODE_ENV: "test" }, false)).toBe(true);
  });

  it("allows when COORDINATOR_ALLOW_RESET=true (auth disabled)", () => {
    expect(canResetDb({ COORDINATOR_ALLOW_RESET: "true" }, false)).toBe(true);
  });

  it("allows when AUTH_ENABLED (admin enforcement happens upstream)", () => {
    expect(canResetDb({}, true)).toBe(true);
    expect(canResetDb({ NODE_ENV: "production" }, true)).toBe(true);
  });

  it("rejects in production when auth is OFF and no override is set", () => {
    expect(canResetDb({ NODE_ENV: "production" }, false)).toBe(false);
  });

  it("rejects when NODE_ENV is unset and no override is set", () => {
    expect(canResetDb({}, false)).toBe(false);
  });

  it("rejects when COORDINATOR_ALLOW_RESET is anything other than 'true'", () => {
    expect(canResetDb({ COORDINATOR_ALLOW_RESET: "1" }, false)).toBe(false);
    expect(canResetDb({ COORDINATOR_ALLOW_RESET: "yes" }, false)).toBe(false);
    expect(canResetDb({ COORDINATOR_ALLOW_RESET: "TRUE" }, false)).toBe(false);
  });

  it("rejects when NODE_ENV is staging or dev (not test)", () => {
    expect(canResetDb({ NODE_ENV: "staging" }, false)).toBe(false);
    expect(canResetDb({ NODE_ENV: "development" }, false)).toBe(false);
  });
});
