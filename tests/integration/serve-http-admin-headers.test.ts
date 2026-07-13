/**
 * T08 integration (v0.10.6 admin UI) — verifies that admin-page static assets
 * get hardened security headers (CSP, X-Frame-Options DENY, Cache-Control
 * no-store, Referrer-Policy, X-Content-Type-Options) AND DROP the wildcard
 * `Access-Control-Allow-Origin: *` that legacy /dashboard/index.html
 * still ships with. Round 1 CRITICAL finding (V3 PATCH 6 + 7 + frontend
 * Round 2 finding #1).
 *
 * Legacy (non-admin) dashboard assets originally shipped with NO security
 * headers at all (just Content-Type + ACAO: *). securite-surface-07 added a
 * SAFE baseline subset to that branch too — nosniff, X-Frame-Options: DENY,
 * Referrer-Policy — while deliberately withholding the strict CSP (index.html
 * has a large inline <script>; see src/serve-http.ts for the rationale and
 * tests/integration/serve-http-legacy-security-headers.test.ts for the
 * dedicated red/green coverage). `assertLegacyHeaders` below reflects that.
 *
 * Strategy: spin up the real HTTP server (mirrors tests/unit/working-files-http
 * pattern) and write temporary admin asset fixtures into dashboard/public/
 * for the duration of the suite. Fixtures are removed in afterAll regardless
 * of test outcome.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const DASHBOARD_DIR = path.join(REPO_ROOT, "dashboard", "public");

// Fixtures the test owns. Created in beforeAll, removed in afterAll.
// Each entry: [filename, body]. Filenames are admin-scoped per the spec
// regex (/^\/dashboard\/admin(?:-[a-z]+)?\.(?:html|js|css)$/) PLUS the
// 4 negative-match controls that must NOT trigger the admin header path.
// IMPORTANT: real admin pages now live at admin.html, admin.js, admin.css,
// admin-orgs.html, admin-users.html (created in T10/T11/T12). Test fixtures
// MUST use unique names that still match the CSP regex
// (/^\/dashboard\/admin(?:-[a-z]+)?\.(?:html|js|css)$/) — single hyphenated
// lowercase segment — without colliding with the real files.
const FIXTURES: Array<[string, string]> = [
  // Positive-match admin assets (unique names that still match the regex).
  ["admin-fixturetest.html", "<!doctype html><html><body>admin</body></html>"],
  ["admin-orgstest.html", "<!doctype html><html><body>orgs</body></html>"],
  ["admin-userstest.html", "<!doctype html><html><body>users</body></html>"],
  ["admin-fixturejs.js", "/* admin.js */"],
  ["admin-fixturecss.css", "/* admin.css */"],
  // Negative-match controls (must get legacy/non-admin headers).
  ["notadmin.html", "<!doctype html><html><body>not admin</body></html>"],
  ["admin.html.bak", "<!doctype html><html><body>backup</body></html>"],
  ["admin-x-y.html", "<!doctype html><html><body>x-y</body></html>"],
  // /dashboard/admin/orgs.html — needs an "admin" subdir. Created separately.
];

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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buf,
          }),
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
// Paths we created that must be removed in afterAll. Track explicitly so
// we never delete pre-existing dashboard assets (e.g. index.html).
const createdPaths: string[] = [];
let createdSubdir: string | null = null;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "admin-headers-"));
  port = await getFreePort();
  const mqttTcpPort = await getFreePort();

  // Materialise fixtures under dashboard/public/. Refuse to overwrite any
  // file that already exists — bail out loudly rather than corrupting source.
  for (const [name, body] of FIXTURES) {
    const fp = path.join(DASHBOARD_DIR, name);
    if (existsSync(fp)) {
      throw new Error(`T08 test fixture would overwrite existing file ${fp}; aborting`);
    }
    writeFileSync(fp, body, "utf-8");
    createdPaths.push(fp);
  }
  // /dashboard/admin/orgs.html — admin-subdir negative control.
  const adminSubdir = path.join(DASHBOARD_DIR, "admin");
  if (!existsSync(adminSubdir)) {
    // Use fs.mkdirSync via require to avoid an extra import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("fs").mkdirSync(adminSubdir, { recursive: true });
    createdSubdir = adminSubdir;
  }
  const subFile = path.join(adminSubdir, "orgs.html");
  if (existsSync(subFile)) {
    throw new Error(`T08 test fixture would overwrite existing file ${subFile}; aborting`);
  }
  writeFileSync(subFile, "<!doctype html><html><body>sub</body></html>", "utf-8");
  createdPaths.push(subFile);

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
  for (const fp of createdPaths) {
    try {
      unlinkSync(fp);
    } catch {
      // best-effort; another test run will catch leftovers via the
      // "would overwrite existing file" guard above.
    }
  }
  if (createdSubdir) {
    try {
      rmSync(createdSubdir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ----- Helpers ------------------------------------------------------------

const CSP_EXPECTED =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function assertAdminHeaders(r: Resp, urlPath: string): void {
  expect(r.status, `${urlPath} status`).toBe(200);
  expect(r.headers["content-security-policy"], `${urlPath} CSP`).toBe(CSP_EXPECTED);
  expect(r.headers["x-frame-options"], `${urlPath} XFO`).toBe("DENY");
  expect(r.headers["x-content-type-options"], `${urlPath} XCTO`).toBe("nosniff");
  expect(r.headers["referrer-policy"], `${urlPath} Referrer-Policy`).toBe("same-origin");
  expect(r.headers["cache-control"], `${urlPath} Cache-Control`).toBe("no-store");
  // CRITICAL: Round 1 finding — admin assets must NOT carry ACAO: *.
  expect(r.headers["access-control-allow-origin"], `${urlPath} must not have ACAO`).toBeUndefined();
}

function assertLegacyHeaders(r: Resp, urlPath: string): void {
  expect(r.status, `${urlPath} status`).toBe(200);
  // Legacy dashboard assets keep the wildcard CORS for backward compat.
  expect(r.headers["access-control-allow-origin"], `${urlPath} ACAO preserved`).toBe("*");
  // securite-surface-07 + architecture-14 follow-up: legacy assets get the
  // baseline (nosniff, frame-options, referrer-policy) AND, since the inline
  // script was extracted (#192) + onclick handlers converted, a strict
  // `script-src 'self'` CSP. It differs from the admin CSP only in style-src,
  // which keeps 'unsafe-inline' for the dashboard's remaining inline styles.
  expect(r.headers["x-content-type-options"], `${urlPath} must have nosniff`).toBe("nosniff");
  expect(r.headers["x-frame-options"], `${urlPath} must have XFO`).toBe("DENY");
  expect(r.headers["referrer-policy"], `${urlPath} must have Referrer-Policy`).toBe("same-origin");
  expect(r.headers["content-security-policy"], `${urlPath} dashboard CSP`).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  // Still NOT the admin-only no-store caching.
  expect(r.headers["cache-control"], `${urlPath} must not have Cache-Control`).toBeUndefined();
}

// ----- Positive tests: admin scope ----------------------------------------

describe("T08: admin-page static handler — admin scope gets hardened headers", () => {
  it("GET /dashboard/admin-fixturetest.html → admin headers, no ACAO", async () => {
    const r = await get(port, "/dashboard/admin-fixturetest.html");
    assertAdminHeaders(r, "/dashboard/admin-fixturetest.html");
    expect(r.headers["content-type"]).toBe("text/html");
  });

  it("GET /dashboard/admin-orgstest.html → admin headers (hyphen variant)", async () => {
    const r = await get(port, "/dashboard/admin-orgstest.html");
    assertAdminHeaders(r, "/dashboard/admin-orgstest.html");
  });

  it("GET /dashboard/admin-userstest.html → admin headers", async () => {
    const r = await get(port, "/dashboard/admin-userstest.html");
    assertAdminHeaders(r, "/dashboard/admin-userstest.html");
  });

  it("GET /dashboard/admin-fixturejs.js → admin headers (js MIME)", async () => {
    const r = await get(port, "/dashboard/admin-fixturejs.js");
    assertAdminHeaders(r, "/dashboard/admin-fixturejs.js");
    expect(r.headers["content-type"]).toBe("application/javascript");
  });

  it("GET /dashboard/admin-fixturecss.css → admin headers (css MIME)", async () => {
    const r = await get(port, "/dashboard/admin-fixturecss.css");
    assertAdminHeaders(r, "/dashboard/admin-fixturecss.css");
    expect(r.headers["content-type"]).toBe("text/css");
  });
});

// ----- Negative tests: legacy / non-admin paths ---------------------------

describe("T08: admin-page static handler — non-admin paths preserve legacy headers", () => {
  it("GET /dashboard/index.html → legacy ACAO preserved, no admin hardening", async () => {
    const r = await get(port, "/dashboard/index.html");
    assertLegacyHeaders(r, "/dashboard/index.html");
  });

  // 4-vector ACAO regex matrix — each MUST fall through to the legacy header set.
  it("GET /dashboard/notadmin.html → legacy (does not start with admin.)", async () => {
    const r = await get(port, "/dashboard/notadmin.html");
    assertLegacyHeaders(r, "/dashboard/notadmin.html");
  });

  it("GET /dashboard/admin.html.bak → legacy (extension mismatch)", async () => {
    const r = await get(port, "/dashboard/admin.html.bak");
    // .bak is not in contentTypes; it returns text/plain. Still served, but
    // with legacy header treatment — that's the security-relevant assertion.
    assertLegacyHeaders(r, "/dashboard/admin.html.bak");
  });

  it("GET /dashboard/admin-x-y.html → legacy (two hyphens, regex only allows one segment)", async () => {
    const r = await get(port, "/dashboard/admin-x-y.html");
    assertLegacyHeaders(r, "/dashboard/admin-x-y.html");
  });

  it("GET /dashboard/admin/orgs.html → legacy (subdir, not admin-orgs.html)", async () => {
    const r = await get(port, "/dashboard/admin/orgs.html");
    assertLegacyHeaders(r, "/dashboard/admin/orgs.html");
  });
});
