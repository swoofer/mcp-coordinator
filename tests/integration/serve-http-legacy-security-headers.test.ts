/**
 * securite-surface-07 — the admin static handler (`isAdminAsset` branch in
 * src/serve-http.ts) already ships hardened headers (CSP, X-Frame-Options:
 * DENY, Referrer-Policy, Cache-Control: no-store, X-Content-Type-Options).
 * The legacy dashboard branch (everything under /dashboard/ that is NOT an
 * admin-scoped asset — e.g. index.html) and the JSON `json()`
 * helper (src/http/utils.ts) shipped NO security headers at all: only
 * Content-Type (+ Access-Control-Allow-Origin: * for the dashboard).
 *
 * Fix baseline for the legacy surface, WITHOUT a strict CSP (index.html is a
 * ~63KB monolith with inline <script> — script-src 'self' would break it;
 * see audit findings tests-05 / architecture-14 for the tracked follow-up to
 * extract that script):
 *   - dashboard legacy assets: X-Content-Type-Options: nosniff,
 *     X-Frame-Options: DENY (nothing in this repo iframes the dashboard —
 *     verified via repo-wide grep), Referrer-Policy: same-origin. ACAO: *
 *     is preserved for backward compat.
 *   - JSON API responses (via the shared `json()` helper): X-Content-Type-Options: nosniff.
 *
 * Strategy: spin up the real HTTP server (mirrors
 * tests/integration/serve-http-admin-headers.test.ts) and hit real routes —
 * no mocking of res.writeHead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import http from "http";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(p: number, urlPath: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: p, path: urlPath, method: "GET" },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let handle: ServerHandle;
let dataDir: string;
let port: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "legacy-sec-headers-"));
  port = await getFreePort();
  const mqttTcpPort = await getFreePort();
  handle = await startServer({
    port,
    dataDir,
    mqttTcpPort,
    registerSignalHandlers: false,
  });
});

afterAll(async () => {
  try {
    await handle?.stop();
  } catch {
    // best-effort
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("securite-surface-07: legacy dashboard gets baseline security headers", () => {
  it("GET /dashboard/index.html → 200, content intact, baseline headers present", async () => {
    const r = await get(port, "/dashboard/index.html");
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(1000); // content not truncated/broken
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("same-origin");
    // Backward-compat: ACAO preserved for legacy dashboard clients.
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    // architecture-14 follow-up: the inline <script> was extracted (#192) and
    // the onclick handlers converted, so index.html now carries a strict
    // `script-src 'self'` CSP (style-src keeps 'unsafe-inline' for the
    // remaining inline styles).
    expect(r.headers["content-security-policy"]).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  it("GET /dashboard/ (index redirect route) → same baseline headers", async () => {
    const r = await get(port, "/dashboard/");
    expect(r.status).toBe(200);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("same-origin");
  });
});

describe("securite-surface-07: JSON API responses get X-Content-Type-Options: nosniff", () => {
  it("GET /health → 200 JSON, nosniff present", async () => {
    const r = await get(port, "/health");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("GET /readyz → JSON (200 or 503), nosniff present either way", async () => {
    const r = await get(port, "/readyz");
    expect([200, 503]).toContain(r.status);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});
