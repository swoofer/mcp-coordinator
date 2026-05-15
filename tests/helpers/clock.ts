import type { Clock } from "../../src/auth/clock.js";

/**
 * Deterministic clock for tests. Mirrors the per-file FakeClass scattered in
 * tests/unit/rate-limit.test.ts, login-lockout.test.ts, etc.; consolidating
 * here so future suites stop reimplementing it.
 *
 * Units: UNIX seconds (matches src/auth/clock.ts realClock contract).
 */
export class FakeClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(seconds: number): void {
    this.current += seconds;
  }
  set(seconds: number): void {
    this.current = seconds;
  }
}
