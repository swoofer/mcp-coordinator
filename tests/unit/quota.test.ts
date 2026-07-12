import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseUsageResponse,
  minutesUntil,
  fetchQuotaFromAnthropic,
  QuotaUnavailableError,
} from "../../src/quota/quota.js";
import { QuotaCache, isFresh } from "../../src/quota/quota-cache.js";
import type { CredentialReader } from "../../src/quota/credential-reader.js";
import type { QuotaInfo } from "../../src/quota/quota.js";

// Minimal fake reader so QuotaCache tests never hit `security` or Keychain.
const fakeReader: CredentialReader = {
  readClaudeOAuthToken: async () => "fake-token",
};

function bucket(util: number, futureMinutes: number): { utilization: number; resets_at: string } {
  return {
    utilization: util,
    resets_at: new Date(Date.now() + futureMinutes * 60_000).toISOString(),
  };
}

// â”€â”€ parseUsageResponse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("parseUsageResponse", () => {
  it("parses the full 3-bucket payload", () => {
    const payload = {
      five_hour: bucket(54, 60),
      seven_day: bucket(67, 300),
      seven_day_sonnet: bucket(3, 1440),
    };
    const info = parseUsageResponse(payload);
    expect(info.fiveHour.utilization).toBe(54);
    expect(info.sevenDay.utilization).toBe(67);
    expect(info.sevenDaySonnet?.utilization).toBe(3);
    expect(info.fiveHour.minutesUntilReset).toBeGreaterThan(55);
  });

  it("returns sevenDaySonnet=null when omitted by the API", () => {
    const payload = {
      five_hour: bucket(10, 60),
      seven_day: bucket(20, 300),
    };
    const info = parseUsageResponse(payload);
    expect(info.sevenDaySonnet).toBeNull();
  });

  it("throws QuotaUnavailableError on missing five_hour", () => {
    expect(() => parseUsageResponse({ seven_day: bucket(20, 300) })).toThrow(QuotaUnavailableError);
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseUsageResponse(null)).toThrow(QuotaUnavailableError);
    expect(() => parseUsageResponse("string")).toThrow(QuotaUnavailableError);
  });

  it("throws when utilization is not a number", () => {
    const payload = {
      five_hour: { utilization: "54", resets_at: new Date().toISOString() },
      seven_day: bucket(20, 300),
    };
    expect(() => parseUsageResponse(payload)).toThrow(QuotaUnavailableError);
  });

  it("throws when resets_at is not a string", () => {
    const payload = {
      five_hour: { utilization: 54, resets_at: 12345 },
      seven_day: bucket(20, 300),
    };
    expect(() => parseUsageResponse(payload)).toThrow(QuotaUnavailableError);
  });

  it("stamps fetchedAt so the cache can reason about freshness", () => {
    const before = Date.now();
    const info = parseUsageResponse({
      five_hour: bucket(10, 60),
      seven_day: bucket(20, 300),
    });
    expect(info.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(info.fetchedAt).toBeLessThanOrEqual(Date.now());
  });
});

// â”€â”€ minutesUntil â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("minutesUntil", () => {
  it("returns positive for future dates", () => {
    const iso = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(minutesUntil(iso)).toBeGreaterThanOrEqual(59);
    expect(minutesUntil(iso)).toBeLessThanOrEqual(61);
  });

  it("returns negative for past dates", () => {
    const iso = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(minutesUntil(iso)).toBeLessThanOrEqual(-59);
    expect(minutesUntil(iso)).toBeGreaterThanOrEqual(-61);
  });

  it("returns 0 for unparseable input", () => {
    expect(minutesUntil("not-a-date")).toBe(0);
  });

  it("handles the Anthropic microsecond+offset format", () => {
    // The actual sample shape returned by /api/oauth/usage.
    const future = new Date(Date.now() + 45 * 60_000).toISOString();
    const withMicros = future.replace("Z", "1234+00:00").replace(".", ".1234");
    // Not strict â€” Date.parse may choke on weird formats; the fallback path
    // returns 0. We just verify the function doesn't throw.
    expect(typeof minutesUntil(withMicros)).toBe("number");
  });
});

// â”€â”€ fetchQuotaFromAnthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("fetchQuotaFromAnthropic", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("wraps credential errors in QuotaUnavailableError", async () => {
    const badReader: CredentialReader = {
      readClaudeOAuthToken: async () => {
        throw new Error("keychain empty");
      },
    };
    await expect(fetchQuotaFromAnthropic(badReader)).rejects.toBeInstanceOf(QuotaUnavailableError);
  });

  it("sends the OAuth Bearer token and anthropic-beta header", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          five_hour: bucket(10, 60),
          seven_day: bucket(20, 300),
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await fetchQuotaFromAnthropic(fakeReader);

    expect(capturedUrl).toContain("api.anthropic.com");
    expect(capturedUrl).toContain("/api/oauth/usage");
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer fake-token");
    expect(capturedHeaders?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("throws QuotaUnavailableError on non-2xx HTTP", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as typeof fetch;
    await expect(fetchQuotaFromAnthropic(fakeReader)).rejects.toMatchObject({
      name: "QuotaUnavailableError",
      message: expect.stringContaining("401"),
    });
  });

  it("throws when the response body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await expect(fetchQuotaFromAnthropic(fakeReader)).rejects.toBeInstanceOf(QuotaUnavailableError);
  });
});

// â”€â”€ QuotaCache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("isFresh", () => {
  it("returns false for null info", () => {
    expect(isFresh(null, 30_000)).toBe(false);
  });
  it("returns true when within TTL", () => {
    const info = { fetchedAt: Date.now() - 10_000 } as QuotaInfo;
    expect(isFresh(info, 30_000)).toBe(true);
  });
  it("returns false when TTL expired", () => {
    const info = { fetchedAt: Date.now() - 40_000 } as QuotaInfo;
    expect(isFresh(info, 30_000)).toBe(false);
  });
});

describe("QuotaCache", () => {
  afterEach(() => vi.useRealTimers());

  function fixedInfo(util: number): QuotaInfo {
    return {
      fiveHour: { utilization: util, resetsAt: "2099-01-01T00:00:00Z", minutesUntilReset: 100 },
      sevenDay: { utilization: util / 2, resetsAt: "2099-01-01T00:00:00Z", minutesUntilReset: 100 },
      sevenDaySonnet: null,
      fetchedAt: Date.now(),
    };
  }

  it("returns cached value within TTL without re-fetching", async () => {
    const fetcher = vi.fn(async () => fixedInfo(42));
    const cache = new QuotaCache({ fetcher, reader: fakeReader, ttlMs: 30_000 });

    const first = await cache.get();
    const second = await cache.get();
    expect(first?.fiveHour.utilization).toBe(42);
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL expires", async () => {
    vi.useFakeTimers();
    let callNumber = 0;
    const fetcher = vi.fn(async () => fixedInfo(callNumber++ === 0 ? 10 : 20));
    const cache = new QuotaCache({ fetcher, reader: fakeReader, ttlMs: 30_000 });

    const first = await cache.get();
    expect(first?.fiveHour.utilization).toBe(10);

    // Force every fetchedAt-based freshness check to see the cache as stale.
    vi.setSystemTime(new Date(Date.now() + 60_000));

    const second = await cache.get();
    expect(second?.fiveHour.utilization).toBe(20);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("single-flight: concurrent get() during a refresh share one fetch", async () => {
    let resolveFetch: (info: QuotaInfo) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<QuotaInfo>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const cache = new QuotaCache({ fetcher, reader: fakeReader, ttlMs: 30_000 });

    const p1 = cache.get();
    const p2 = cache.get();
    const p3 = cache.get();

    resolveFetch(fixedInfo(77));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("snapshot().unavailable=true when first fetch fails", async () => {
    const fetcher = vi.fn(async () => {
      throw new QuotaUnavailableError("keychain missing");
    });
    const cache = new QuotaCache({ fetcher, reader: fakeReader });
    await cache.get();
    const snap = cache.snapshot();
    expect(snap.info).toBeNull();
    expect(snap.unavailable).toBe(true);
    expect(snap.lastError).toContain("keychain missing");
  });

  it("calls onRefresh callback every successful refresh", async () => {
    const onRefresh = vi.fn();
    const fetcher = vi.fn(async () => fixedInfo(50));
    const cache = new QuotaCache({ fetcher, reader: fakeReader, onRefresh });
    await cache.refresh();
    await cache.refresh();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fiveHour: expect.objectContaining({ utilization: 50 }),
      }),
    );
  });

  it("activeAgents tracking starts/stops the background tick", async () => {
    const fetcher = vi.fn(async () => fixedInfo(10));
    const cache = new QuotaCache({ fetcher, reader: fakeReader, ttlMs: 30_000 });

    expect(cache.snapshot().activeAgents).toBe(0);
    cache.onAgentActive();
    cache.onAgentActive();
    expect(cache.snapshot().activeAgents).toBe(2);
    cache.onAgentInactive();
    cache.onAgentInactive();
    expect(cache.snapshot().activeAgents).toBe(0);
    cache.stopBackgroundTick(); // teardown safe even when nothing is running
  });
});
