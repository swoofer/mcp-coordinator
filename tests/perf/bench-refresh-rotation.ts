/* eslint-disable no-console */
/**
 * T33 perf bench — refresh-token rotation hot path.
 *
 * Measures end-to-end latency of refreshTokenGrant() — the full HTTP
 * boundary including form body parse, JWT verify (HS256 + kid lookup +
 * clock-skew check), DB SELECT, idle-timeout check, allowlist re-check
 * skip (idp_access_token=NULL Phase 1 user), atomic UPDATE, mintTokenPair
 * (new JWT pair + INSERT successor), parent_jti UPDATE, and Tier 2 audit
 * emission.
 *
 * Setup:
 *   - In-memory better-sqlite3 with a temp file-backed DB (initDatabase
 *     requires a directory). We use a unique data-test-perf-* dir and
 *     rm-rf it at the end.
 *   - Single user, idp_access_token=NULL so the IdP membership re-check
 *     short-circuits (no IdP mocking required — see plan).
 *   - Loop: rotate -> use new refresh JWT as input for the next iteration.
 *
 * Output: human-readable summary + JSON_SUMMARY line as final stdout.
 */
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { refreshTokenGrant } from "../../src/auth/refresh-rotation.js";
import { mintTokenPair } from "../../src/auth/oauth-finalize.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { realClock } from "../../src/auth/clock.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuditQueue, resetAuditQueue } from "../../src/security/audit.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import type { ExchangeCodeResult, IdPProvider } from "../../src/auth/providers/types.js";

const ISSUER = "http://localhost:3000";
const SIGNING_SECRET = Buffer.alloc(32, 0x01);
const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);

interface CapturedRes {
  statusCode: number;
  body: string;
}

function mockResponse(): ServerResponse & { _captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: "" };
  const res = {
    _captured: captured,
    writeHead(status: number) {
      captured.statusCode = status;
      return res;
    },
    setHeader() { /* noop */ },
    getHeader() { return undefined; },
    end(payload?: string) {
      if (payload !== undefined) captured.body = payload;
    },
  };
  return res as unknown as ServerResponse & { _captured: CapturedRes };
}

function mockRequest(refreshToken: string): IncomingMessage {
  const body = new URLSearchParams({ refresh_token: refreshToken }).toString();
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  (stream as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  (stream as unknown as { headers: Record<string, string> }).headers = { "user-agent": "perf-bench/1.0" };
  return stream as unknown as IncomingMessage;
}

async function main(): Promise<void> {
  const N = parseInt(process.env.BENCH_N ?? "10000", 10);
  const WARMUP = Math.min(100, Math.floor(N / 100));

  // Unique tmp data dir so concurrent runs don't collide.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-rotation-"));
  initDatabase(dir);
  const db = getDb();
  initAuditQueue(db as unknown as import("better-sqlite3").Database);

  // Seed org + user. idp_access_token=NULL so refresh skips IdP membership
  // re-check (the cleanest realistic Phase 1 -> Phase 2 migrated user path).
  db.prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)").run("org-perf", "Perf", "perf");
  db.prepare(
    `INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id,
       idp_access_token, role, last_login_at, token_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("u-perf", "org-perf", "perf@example.com", "github", "gh-perf", null, "member", "0", 0);

  const stubProvider: IdPProvider = {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => { throw new Error("unused"); },
    listMemberships: async () => ["perf"],
  };

  const ctx: AuthHandlerContext = {
    db: db as unknown as import("better-sqlite3").Database,
    clock: realClock,
    githubProvider: stubProvider,
    rateLimiter: new RateLimiter(realClock),
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
    membershipCache: new MembershipCache(realClock),
  };

  // Mint the seed refresh JWT via the real mintTokenPair (so the row
  // lookup hits a real refresh_tokens row + fingerprint matches what
  // computeFingerprint produces for ip=127.0.0.1 / ua=perf-bench/1.0).
  const seed = await mintTokenPair(
    db as unknown as import("better-sqlite3").Database,
    realClock,
    {
      user: { user_id: "u-perf", primary_org_id: "org-perf", role: "member" },
      registry: ctx.signingKeys,
      issuer: ISSUER,
      fingerprint: null,
    },
  );
  let currentRefresh = seed.refreshJwt;

  // Warmup pass — JIT + prepared-statement caches.
  for (let i = 0; i < WARMUP; i++) {
    const req = mockRequest(currentRefresh);
    const res = mockResponse();
    await refreshTokenGrant(req, res, ctx);
    if (res._captured.statusCode !== 200) {
      throw new Error(`warmup failed iter=${i} status=${res._captured.statusCode} body=${res._captured.body}`);
    }
    currentRefresh = JSON.parse(res._captured.body).refresh_token;
  }

  // Timed pass.
  const latencies = new Float64Array(N);
  const totalStart = performance.now();
  for (let i = 0; i < N; i++) {
    const req = mockRequest(currentRefresh);
    const res = mockResponse();
    const start = performance.now();
    await refreshTokenGrant(req, res, ctx);
    const elapsed = performance.now() - start;
    latencies[i] = elapsed;
    if (res._captured.statusCode !== 200) {
      throw new Error(`rotation failed iter=${i} status=${res._captured.statusCode} body=${res._captured.body}`);
    }
    currentRefresh = JSON.parse(res._captured.body).refresh_token;
  }
  const totalMs = performance.now() - totalStart;

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(N * 0.50)]!;
  const p95 = sorted[Math.floor(N * 0.95)]!;
  const p99 = sorted[Math.floor(N * 0.99)]!;
  const throughput = (N / totalMs) * 1000;

  console.log("\nrefresh-rotation:");
  console.log(`  N=${N}, warmup=${WARMUP}, total=${totalMs.toFixed(1)}ms`);
  console.log(`  p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms, p99=${p99.toFixed(3)}ms`);
  console.log(`  throughput=${throughput.toFixed(1)} ops/sec`);

  const summary = {
    bench: "refresh-rotation",
    n: N,
    p50_ms: Number(p50.toFixed(3)),
    p95_ms: Number(p95.toFixed(3)),
    p99_ms: Number(p99.toFixed(3)),
    throughput_ops_per_sec: Number(throughput.toFixed(1)),
    total_ms: Number(totalMs.toFixed(1)),
  };
  console.log("JSON_SUMMARY: " + JSON.stringify(summary));

  resetAuditQueue();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
