import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { registerPlaintextReminder } from "../../src/boot-encryption.js";
import type { Logger } from "../../src/observability/logger.js";

/**
 * T06c: tests for registerPlaintextReminder — verifies the startup-warn +
 * 24h recurring-reminder behavior, key-present no-op, idempotent teardown,
 * and no interval leaks across multiple register/teardown cycles.
 *
 * Uses vi.useFakeTimers so we can advance the (24h) interval deterministically.
 */

interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLogger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
}

const TWENTY_FOUR_HOURS_MS = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registerPlaintextReminder", () => {
  it("production + no key: logs error at startup + every 24h", () => {
    const logger = makeLogger();
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    const stop = registerPlaintextReminder({ env, logger: logger as unknown as Logger }, null);
    try {
      // 1 immediate startup error.
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(0);

      // +24h → 1 reminder, total 2.
      vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS);
      expect(logger.error).toHaveBeenCalledTimes(2);

      // +another 24h → 1 more reminder, total 3.
      vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS);
      expect(logger.error).toHaveBeenCalledTimes(3);

      // warn channel never touched.
      expect(logger.warn).toHaveBeenCalledTimes(0);
    } finally {
      stop();
    }
  });

  it("development (NODE_ENV unset) + no key: logs warn at startup + every 24h", () => {
    const logger = makeLogger();
    const env: NodeJS.ProcessEnv = {}; // NODE_ENV unset → warn branch
    const stop = registerPlaintextReminder({ env, logger: logger as unknown as Logger }, null);
    try {
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(0);

      vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS);
      expect(logger.warn).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS);
      expect(logger.warn).toHaveBeenCalledTimes(3);

      expect(logger.error).toHaveBeenCalledTimes(0);
    } finally {
      stop();
    }
  });

  it("with key present: no reminder registered; no logs over 7 days", () => {
    const logger = makeLogger();
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    const key = randomBytes(32);
    const stop = registerPlaintextReminder({ env, logger: logger as unknown as Logger }, key);

    // No startup log, no reminder scheduled.
    expect(logger.error).toHaveBeenCalledTimes(0);
    expect(logger.warn).toHaveBeenCalledTimes(0);

    // Advance 7 days; still zero calls.
    vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS * 7);
    expect(logger.error).toHaveBeenCalledTimes(0);
    expect(logger.warn).toHaveBeenCalledTimes(0);

    // Teardown must be a safe no-op.
    expect(() => stop()).not.toThrow();
  });

  it("teardown stops further reminders", () => {
    const logger = makeLogger();
    const env: NodeJS.ProcessEnv = {};
    const stop = registerPlaintextReminder({ env, logger: logger as unknown as Logger }, null);
    expect(logger.warn).toHaveBeenCalledTimes(1); // startup

    // Tear down before any reminder fires.
    stop();

    // Advance 24h × 3 — no further log calls.
    vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS * 3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it("teardown is idempotent: calling twice does not throw", () => {
    const logger = makeLogger();
    const env: NodeJS.ProcessEnv = {};
    const stop = registerPlaintextReminder({ env, logger: logger as unknown as Logger }, null);
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
  });

  it("multiple register/teardown cycles do not leak intervals", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const env: NodeJS.ProcessEnv = {};
    const loggerA = makeLogger();
    const loggerB = makeLogger();

    const stopA = registerPlaintextReminder({ env, logger: loggerA as unknown as Logger }, null);
    stopA();

    const stopB = registerPlaintextReminder({ env, logger: loggerB as unknown as Logger }, null);
    stopB();

    // Two registrations → two setInterval calls and two clearInterval calls.
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);

    // Advancing time after both teardowns must not log anything new.
    const aWarnAfterTeardown = loggerA.warn.mock.calls.length;
    const bWarnAfterTeardown = loggerB.warn.mock.calls.length;
    vi.advanceTimersByTime(TWENTY_FOUR_HOURS_MS * 5);
    expect(loggerA.warn).toHaveBeenCalledTimes(aWarnAfterTeardown);
    expect(loggerB.warn).toHaveBeenCalledTimes(bWarnAfterTeardown);

    // Idempotent re-teardown does NOT trigger another clearInterval.
    stopA();
    stopB();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });
});
