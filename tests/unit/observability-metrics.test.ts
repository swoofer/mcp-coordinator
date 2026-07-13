import { describe, it, expect, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  registry,
  resetMetricsForTest,
  registerDefaultMetrics,
  authLoginAttemptsTotal,
  authLoginSuccessTotal,
  authLoginFailureTotal,
  authRefreshRotatedTotal,
  authRefreshChainRevokedTotal,
  authRefreshSuspiciousReplayTotal,
  authTokenRevokedTotal,
  authLogoutTotal,
  authDeviceCodeIssuedTotal,
  authDeviceApprovedTotal,
  authDeviceDeniedTotal,
  authServiceTokenIssuedTotal,
  authServiceTokenUsedTotal,
  authServiceTokenRevokedTotal,
  idpApiCallsTotal,
  idpCacheHitsTotal,
  idpCacheMissesTotal,
  idpStaleServedTotal,
  idpRateLimitRemaining,
  auditQueueDepth,
  sweeperCircuitOpen,
  sweeperConsecutiveFailures,
  sweeperLastRunTimestamp,
  auditDropsTotal,
  auditAfterCriticalOpFailuresTotal,
  sweeperRowsDeletedTotal,
  rateLimitBlockedTotal,
  loginLockoutTriggeredTotal,
  authRequestDurationSeconds,
} from "../../src/observability/metrics.js";
import { handleMetrics } from "../../src/http/metrics.js";

// ── Mock helpers ────────────────────────────────────────────────────────

interface MockResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) this.headers = { ...headers };
      return this;
    },
    end(payload) {
      this.body = payload ?? "";
    },
  };
  return res;
}

function mockReq(opts: { remoteAddress?: string; authorization?: string }): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) {
    headers["authorization"] = opts.authorization;
  }
  return {
    headers,
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as IncomingMessage;
}

beforeEach(() => {
  resetMetricsForTest();
});

// ── Registry behaviour ──────────────────────────────────────────────────

describe("observability/metrics: registry", () => {
  it("registry.metrics() resolves to a string", async () => {
    const out = await registry.metrics();
    expect(typeof out).toBe("string");
  });

  it("fresh registry does NOT include default Node metrics (collectDefault is opt-in)", async () => {
    // T37 declares registerDefaultMetrics as an explicit boot call. Until
    // it runs, the registry contains only the metrics declared in
    // src/observability/metrics.ts — no nodejs_eventloop_lag etc.
    const out = await registry.metrics();
    // Both prom-client default-metric names start with "nodejs_" or "process_".
    expect(out).not.toMatch(/^nodejs_eventloop_lag/m);
    expect(out).not.toMatch(/^process_cpu_user_seconds_total/m);
  });

  it("scrape output reflects incremented counters with labels", async () => {
    authLoginAttemptsTotal.inc({ outcome: "success", org_id: "org-1" });
    authLoginAttemptsTotal.inc({ outcome: "success", org_id: "org-1" });
    authLoginAttemptsTotal.inc({ outcome: "failure", org_id: "org-2" });
    const out = await registry.metrics();
    expect(out).toContain(
      'coordinator_auth_login_attempts_total{outcome="success",org_id="org-1"} 2',
    );
    expect(out).toContain(
      'coordinator_auth_login_attempts_total{outcome="failure",org_id="org-2"} 1',
    );
  });

  it("resetMetricsForTest() zeros all counters", async () => {
    authLoginAttemptsTotal.inc({ outcome: "success", org_id: "org-1" }, 5);
    auditDropsTotal.inc(3);
    resetMetricsForTest();
    const out = await registry.metrics();
    // After reset, the label series may no longer be emitted at all
    // (reset clears child label sets). Either no line OR a line with
    // value 0 is acceptable.
    expect(out).not.toMatch(/coordinator_auth_login_attempts_total\{[^}]*\}\s+[1-9]/);
    expect(out).not.toMatch(/coordinator_audit_drops_total\s+[1-9]/);
  });

  it("declared metrics emit their HELP/TYPE lines even when never incremented", async () => {
    const out = await registry.metrics();
    expect(out).toContain("# HELP coordinator_auth_login_attempts_total");
    expect(out).toContain("# TYPE coordinator_auth_login_attempts_total counter");
    expect(out).toContain("# HELP coordinator_audit_queue_depth");
    expect(out).toContain("# TYPE coordinator_audit_queue_depth gauge");
    expect(out).toContain("# TYPE coordinator_auth_request_duration_seconds histogram");
  });
});

// ── Metric shape ────────────────────────────────────────────────────────

describe("observability/metrics: metric shape", () => {
  it("authLoginAttemptsTotal is a Counter with labels [outcome, org_id]", () => {
    const m = authLoginAttemptsTotal as unknown as {
      type: string;
      labelNames: string[];
    };
    expect(m.type).toBe("counter");
    expect([...m.labelNames].sort()).toEqual(["org_id", "outcome"]);
  });

  it("idpCacheHitsTotal is a Counter with no labels", () => {
    const m = idpCacheHitsTotal as unknown as {
      type: string;
      labelNames: string[];
    };
    expect(m.type).toBe("counter");
    expect(m.labelNames).toEqual([]);
  });

  it("auditQueueDepth is a Gauge", () => {
    const m = auditQueueDepth as unknown as { type: string };
    expect(m.type).toBe("gauge");
  });

  it("sweeperCircuitOpen is a Gauge — set(0) and set(1) are both observable", async () => {
    const m = sweeperCircuitOpen as unknown as { type: string };
    expect(m.type).toBe("gauge");
    sweeperCircuitOpen.set(1);
    let out = await registry.metrics();
    expect(out).toMatch(/coordinator_sweeper_circuit_open\s+1/);
    sweeperCircuitOpen.set(0);
    out = await registry.metrics();
    expect(out).toMatch(/coordinator_sweeper_circuit_open\s+0/);
  });

  it("authRequestDurationSeconds is a Histogram with the configured bucket count", () => {
    const m = authRequestDurationSeconds as unknown as {
      type: string;
      upperBounds?: number[];
      buckets?: number[];
    };
    expect(m.type).toBe("histogram");
    const bounds = m.upperBounds ?? m.buckets ?? [];
    // 11 explicit buckets: [.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5]
    expect(bounds).toEqual([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]);
  });

  it("all declared metric handles are non-null and registered", () => {
    // Smoke check that the export surface is complete — if any of these
    // are undefined, the import * at the top of the test file would have
    // pulled in `undefined` and downstream tests would crash. Listing
    // explicitly here gives a clearer failure if a future refactor drops
    // a metric.
    const all = [
      authLoginAttemptsTotal,
      authLoginSuccessTotal,
      authLoginFailureTotal,
      authRefreshRotatedTotal,
      authRefreshChainRevokedTotal,
      authRefreshSuspiciousReplayTotal,
      authTokenRevokedTotal,
      authLogoutTotal,
      authDeviceCodeIssuedTotal,
      authDeviceApprovedTotal,
      authDeviceDeniedTotal,
      authServiceTokenIssuedTotal,
      authServiceTokenUsedTotal,
      authServiceTokenRevokedTotal,
      idpApiCallsTotal,
      idpCacheHitsTotal,
      idpCacheMissesTotal,
      idpStaleServedTotal,
      idpRateLimitRemaining,
      auditQueueDepth,
      sweeperCircuitOpen,
      sweeperConsecutiveFailures,
      sweeperLastRunTimestamp,
      auditDropsTotal,
      auditAfterCriticalOpFailuresTotal,
      sweeperRowsDeletedTotal,
      rateLimitBlockedTotal,
      loginLockoutTriggeredTotal,
      authRequestDurationSeconds,
    ];
    for (const m of all) {
      expect(m).toBeDefined();
    }
    expect(all.length).toBeGreaterThanOrEqual(25);
  });
});

// ── Handler: access control ─────────────────────────────────────────────

describe("http/metrics: handleMetrics access control", () => {
  it("returns 200 + Prometheus text for IPv4 loopback (default localhostOnly)", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "127.0.0.1" }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/plain");
    expect(res.body).toContain("# HELP coordinator_auth_login_attempts_total");
  });

  it("returns 200 for IPv6 loopback ::1", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "::1" }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 for IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", async () => {
    const res = mockResponse();
    await handleMetrics(
      mockReq({ remoteAddress: "::ffff:127.0.0.1" }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for non-loopback with no Bearer", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "10.0.0.5" }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      code: "FORBIDDEN",
      message: "Access denied",
      request_id: null,
    });
  });

  it("returns 200 for non-loopback with matching Bearer", async () => {
    const res = mockResponse();
    await handleMetrics(
      mockReq({
        remoteAddress: "10.0.0.5",
        authorization: "Bearer my-secret-token",
      }),
      res as unknown as ServerResponse,
      { bearerToken: "my-secret-token" },
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for non-loopback with WRONG (same-length) Bearer", async () => {
    const res = mockResponse();
    await handleMetrics(
      mockReq({
        remoteAddress: "10.0.0.5",
        authorization: "Bearer my-secret-tokeN", // last char differs
      }),
      res as unknown as ServerResponse,
      { bearerToken: "my-secret-token" },
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for non-loopback with wrong-length Bearer (no throw — length pre-check)", async () => {
    const res = mockResponse();
    // crypto.timingSafeEqual throws on length mismatch; the handler must
    // gate it behind a length check. We assert no throw + 403.
    await expect(
      handleMetrics(
        mockReq({
          remoteAddress: "10.0.0.5",
          authorization: "Bearer short",
        }),
        res as unknown as ServerResponse,
        { bearerToken: "my-secret-token" },
      ),
    ).resolves.toBeUndefined();
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for non-loopback with Authorization that does NOT start with 'Bearer '", async () => {
    const res = mockResponse();
    await handleMetrics(
      mockReq({
        remoteAddress: "10.0.0.5",
        authorization: "Basic dXNlcjpwYXNz",
      }),
      res as unknown as ServerResponse,
      { bearerToken: "my-secret-token" },
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for non-loopback with no Authorization header but bearerToken configured", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "10.0.0.5" }), res as unknown as ServerResponse, {
      bearerToken: "my-secret-token",
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when localhostOnly=false and no bearerToken (no rule grants access)", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "127.0.0.1" }), res as unknown as ServerResponse, {
      localhostOnly: false,
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when remoteAddress is undefined (no socket info)", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: undefined }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
  });

  it("Content-Type matches registry.contentType on 200", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "127.0.0.1" }), res as unknown as ServerResponse);
    expect(res.headers["Content-Type"]).toBe(registry.contentType);
    expect(registry.contentType).toContain("text/plain");
    expect(registry.contentType).toContain("version=0.0.4");
  });

  it("body is non-empty even when no metrics have been incremented", async () => {
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "127.0.0.1" }), res as unknown as ServerResponse);
    expect(res.body.length).toBeGreaterThan(0);
    // HELP lines are always emitted for declared metrics.
    expect(res.body).toContain("# HELP");
    expect(res.body).toContain("# TYPE");
  });

  it("loopback rule still applies when bearerToken is set but request is from loopback with no header", async () => {
    // (localhostOnly && fromLoopback) || bearerOk — loopback path
    // succeeds independently of the bearer being set.
    const res = mockResponse();
    await handleMetrics(mockReq({ remoteAddress: "127.0.0.1" }), res as unknown as ServerResponse, {
      bearerToken: "my-secret-token",
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── registerDefaultMetrics() — runs last to avoid polluting other tests ──

describe("observability/metrics: registerDefaultMetrics()", () => {
  it("adds default Node process metrics to the registry when called", async () => {
    // Sanity precondition: before the call, no nodejs_* metric is present.
    const before = await registry.metrics();
    expect(before).not.toMatch(/^# HELP nodejs_/m);

    registerDefaultMetrics();
    const after = await registry.metrics();
    // prom-client emits one of nodejs_eventloop_lag_seconds or
    // process_cpu_user_seconds_total. Asserting on either is enough.
    expect(after).toMatch(/^# HELP (nodejs_|process_)/m);
  });
});
