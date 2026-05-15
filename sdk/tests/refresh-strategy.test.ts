import { describe, expect, it } from "vitest";
import { NoOpRefresh, ProactiveRefresh } from "../src/index.js";
import type { TokenSet } from "../src/types.js";

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function tokensExpiringInS(seconds: number): TokenSet {
  return {
    accessToken: "at",
    refreshToken: "rt",
    accessExpiresAt: nowS() + seconds,
  };
}

describe("ProactiveRefresh", () => {
  it("returns positive number when accessExpiresAt is far enough in the future", () => {
    const strategy = new ProactiveRefresh(120, 30, () => 0.5); // zero jitter
    const delay = strategy.nextRefreshDelayMs(tokensExpiringInS(3600));
    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThan(0);
  });

  it("returns null when accessExpiresAt is in the past", () => {
    const strategy = new ProactiveRefresh(120, 30, () => 0.5);
    const delay = strategy.nextRefreshDelayMs(tokensExpiringInS(-100));
    expect(delay).toBeNull();
  });

  it("default lead 120s + expiry in 200s + zero jitter -> delay ~ 80s", () => {
    const strategy = new ProactiveRefresh(120, 30, () => 0.5); // rng=0.5 -> jitter=0
    const delay = strategy.nextRefreshDelayMs(tokensExpiringInS(200));
    expect(delay).not.toBeNull();
    // Allow +/- 2s tolerance for clock drift in the test.
    expect(delay! / 1000).toBeGreaterThan(78);
    expect(delay! / 1000).toBeLessThan(82);
  });

  it("jitter introduces variance across calls with different rng values", () => {
    const tokens = tokensExpiringInS(3600);
    // rng=0 -> jitter = -30s; rng=1 -> jitter = +30s
    const lowJitter = new ProactiveRefresh(120, 30, () => 0).nextRefreshDelayMs(tokens);
    const highJitter = new ProactiveRefresh(120, 30, () => 1).nextRefreshDelayMs(tokens);
    expect(lowJitter).not.toBeNull();
    expect(highJitter).not.toBeNull();
    // High should be ~60s more than low (jitter range = 60s).
    const diff = (highJitter! - lowJitter!) / 1000;
    expect(diff).toBeGreaterThan(55);
    expect(diff).toBeLessThan(65);
  });

  it("custom leadSeconds is honored", () => {
    const strategy = new ProactiveRefresh(300, 0, () => 0.5);
    const delay = strategy.nextRefreshDelayMs(tokensExpiringInS(400));
    expect(delay).not.toBeNull();
    // 400 - 300 = 100s; allow +/- 2s tolerance.
    expect(delay! / 1000).toBeGreaterThan(98);
    expect(delay! / 1000).toBeLessThan(102);
  });

  it("jitterSeconds = 0 produces deterministic delay (rng-agnostic)", () => {
    const tokens = tokensExpiringInS(500);
    const a = new ProactiveRefresh(120, 0, () => 0).nextRefreshDelayMs(tokens);
    const b = new ProactiveRefresh(120, 0, () => 1).nextRefreshDelayMs(tokens);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Should differ by less than 1s (just clock noise during test).
    expect(Math.abs(a! - b!)).toBeLessThan(1000);
  });

  it("rng = 0.5 produces zero jitter (centered)", () => {
    const tokens = tokensExpiringInS(500);
    const zeroJitter = new ProactiveRefresh(120, 30, () => 0.5).nextRefreshDelayMs(tokens);
    const noJitter = new ProactiveRefresh(120, 0, () => 0.5).nextRefreshDelayMs(tokens);
    expect(zeroJitter).not.toBeNull();
    expect(noJitter).not.toBeNull();
    expect(Math.abs(zeroJitter! - noJitter!)).toBeLessThan(1000);
  });
});

describe("NoOpRefresh", () => {
  it("always returns null", () => {
    const strategy = new NoOpRefresh();
    expect(strategy.nextRefreshDelayMs(tokensExpiringInS(3600))).toBeNull();
    expect(strategy.nextRefreshDelayMs(tokensExpiringInS(-100))).toBeNull();
    expect(strategy.nextRefreshDelayMs(tokensExpiringInS(0))).toBeNull();
  });
});
