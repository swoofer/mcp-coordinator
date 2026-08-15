import { Command } from "commander";
import { existingPidFilePath } from "./pid-file.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createConnection } from "net";
import { request } from "http";
import { getConfigDir, loadConfig } from "./config.js";
import { tcpReachable } from "./tcp-probe.js";
import { assertSecretEntropy } from "../src/auth/entropy.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  // Phase 2 probes distinguish warn from fail. Phase 1 uses ok=true/false only.
  severity?: "ok" | "warn" | "fail";
}

/**
 * Modules the daemon cannot boot without.
 *
 * issue #282: a concurrent package-manager run can rewrite node_modules while
 * a node process is starting, leaving a link missing. The daemon then dies on
 * a raw `cjs/loader` stack trace that names a package nobody declared —
 * `@babel/runtime`, four levels below `mqtt`.
 *
 * We **import** rather than `require.resolve` on purpose. Resolution only
 * proves the top-level entry exists; the breakage is always deeper, and only
 * surfaces when the module graph is actually executed. `mqtt` is the canary:
 * it pulls worker-timers -> worker-timers-broker -> broker-factory ->
 * @babel/runtime, and that last link is the one that goes missing.
 */
const CRITICAL_MODULES = ["@modelcontextprotocol/server", "better-sqlite3", "mqtt"] as const;

const MODULE_MISSING_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * Verify the dependency tree actually loads.
 *
 * Runs before every other probe: when the tree is broken, every downstream
 * check fails for the wrong reason and the hints point at the wrong fix
 * ("start the server" when the server physically cannot start).
 */
export async function checkDependencyTree(
  modules: readonly string[] = CRITICAL_MODULES,
): Promise<CheckResult> {
  const broken: { module: string; missing: string }[] = [];
  const other: { module: string; message: string }[] = [];

  for (const name of modules) {
    try {
      await import(name);
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { message: string };
      const isMissing =
        MODULE_MISSING_CODES.has(err.code ?? "") || /Cannot find module/.test(err.message ?? "");
      if (isMissing) {
        // Surface the package that is actually absent, which is rarely the one
        // we asked for. That name is the whole diagnostic value here.
        // Node phrases it two ways: "Cannot find module 'x'" from the CJS
        // loader (the #282 case, thrown deep inside a transitive require) and
        // "Cannot find package 'x' imported from y" from the ESM loader.
        const m = /Cannot find (?:module|package) '([^']+)'/.exec(err.message ?? "");
        broken.push({ module: name, missing: m?.[1] ?? "unknown" });
      } else {
        other.push({ module: name, message: err.message ?? String(e) });
      }
    }
  }

  if (broken.length > 0) {
    const detail = broken.map((b) => `${b.module} -> missing '${b.missing}'`).join("; ");
    return {
      name: "deps",
      ok: false,
      severity: "fail",
      detail: `dependency tree incomplete: ${detail}`,
      hint:
        "Run: pnpm install --frozen-lockfile (restores the tree without touching the lockfile). " +
        "A concurrent install or agent run can rewrite node_modules mid-flight — see issue #282.",
    };
  }

  if (other.length > 0) {
    const detail = other.map((o) => `${o.module}: ${o.message}`).join("; ");
    return {
      name: "deps",
      ok: false,
      severity: "fail",
      detail: `dependency loaded but failed: ${detail}`,
      hint:
        "A package is present but unusable — typically a native binding built for another " +
        "Node version. Run: pnpm rebuild better-sqlite3",
    };
  }

  return {
    name: "deps",
    ok: true,
    severity: "ok",
    detail: `${modules.length} critical modules load (${modules.join(", ")})`,
  };
}

async function httpGet(
  host: string,
  port: number,
  path: string,
  timeoutMs = 1500,
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolveP) => {
    const req = request({ host, port, path, method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolveP({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8").slice(0, 200),
        });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolveP(null);
    });
    req.on("error", () => resolveP(null));
    req.end();
  });
}

async function mcpInitialize(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolveP) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-coordinator-doctor", version: "1.0.0" },
      },
    });
    const req = request(
      {
        host,
        port,
        path: "/mcp",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          // streaming MCP responses prefix with `data: { ... }`
          resolveP(res.statusCode === 200 && body.includes('"protocolVersion"'));
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolveP(false);
    });
    req.on("error", () => resolveP(false));
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// Phase 2 probes (T42). Each returns a CheckResult with `severity` populated.
// They use globalThis.fetch (Node 20+) so tests can stub it cleanly.
// ============================================================================

type FetchLike = typeof fetch;

/**
 * Strip a trailing slash from a URL. Matches buildDiscoveryDoc's behaviour so
 * issuer comparisons are stable across `http://x` vs `http://x/`.
 */
function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/**
 * Probe 1: HEAD ${publicUrl}/healthz. Validates the URL is well-formed and
 * that the deployment we *think* is at PUBLIC_URL actually answers.
 */
export async function probePublicUrl(
  publicUrl: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  if (!publicUrl) {
    return {
      name: "phase2.public_url",
      ok: false,
      severity: "fail",
      detail: "COORDINATOR_PUBLIC_URL not set",
      hint: "Set COORDINATOR_PUBLIC_URL=https://your.coordinator.example",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return {
      name: "phase2.public_url",
      ok: false,
      severity: "fail",
      detail: `malformed URL: ${publicUrl}`,
      hint: "Must be a full URL with http/https scheme",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      name: "phase2.public_url",
      ok: false,
      severity: "fail",
      detail: `unsupported scheme: ${parsed.protocol}`,
      hint: "Only http:// and https:// are supported",
    };
  }
  const base = stripTrailingSlash(publicUrl);
  try {
    const res = await fetchImpl(`${base}/healthz`, { method: "HEAD" });
    if (res.status === 200) {
      return {
        name: "phase2.public_url",
        ok: true,
        severity: "ok",
        detail: `HEAD ${base}/healthz -> 200`,
      };
    }
    return {
      name: "phase2.public_url",
      ok: false,
      severity: "warn",
      detail: `HEAD ${base}/healthz -> ${res.status} (expected 200)`,
      hint: "URL is valid but /healthz did not return 200 — confirm this is the running coordinator",
    };
  } catch (e) {
    return {
      name: "phase2.public_url",
      ok: false,
      severity: "warn",
      detail: `HEAD ${base}/healthz failed: ${(e as Error).message}`,
      hint: "URL parses but is unreachable — possibly the running coordinator is on a different host",
    };
  }
}

interface DiscoveryDoc {
  issuer?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/**
 * Probe 2: GET /.well-known/oauth-authorization-server. Verifies issuer
 * matches publicUrl + V4 FIX 12 (auth methods = ["none"]) + S256-only.
 */
export async function probeDiscoveryDoc(
  publicUrl: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  if (!publicUrl) {
    return {
      name: "phase2.discovery_doc",
      ok: false,
      severity: "fail",
      detail: "COORDINATOR_PUBLIC_URL not set",
    };
  }
  const base = stripTrailingSlash(publicUrl);
  const target = `${base}/.well-known/oauth-authorization-server`;
  let body: string;
  try {
    const res = await fetchImpl(target, { method: "GET" });
    if (!res.ok) {
      return {
        name: "phase2.discovery_doc",
        ok: false,
        severity: "fail",
        detail: `${target} -> HTTP ${res.status}`,
        hint: "Discovery endpoint must return 200 OK with JSON body",
      };
    }
    body = await res.text();
  } catch (e) {
    return {
      name: "phase2.discovery_doc",
      ok: false,
      severity: "fail",
      detail: `${target} unreachable: ${(e as Error).message}`,
      hint: "Coordinator not serving discovery endpoint",
    };
  }
  let doc: DiscoveryDoc;
  try {
    doc = JSON.parse(body) as DiscoveryDoc;
  } catch {
    return {
      name: "phase2.discovery_doc",
      ok: false,
      severity: "fail",
      detail: `discovery body is not valid JSON`,
      hint: "Body returned by /.well-known/oauth-authorization-server is malformed",
    };
  }

  if (doc.issuer !== base) {
    return {
      name: "phase2.discovery_doc",
      ok: false,
      severity: "warn",
      detail: `issuer=${doc.issuer ?? "<missing>"} but PUBLIC_URL=${base}`,
      hint: "Issuer drift — env vs deployment mismatch; tokens may reject when validated by clients",
    };
  }
  const auth = doc.token_endpoint_auth_methods_supported;
  if (!Array.isArray(auth) || auth.length !== 1 || auth[0] !== "none") {
    return {
      name: "phase2.discovery_doc",
      ok: false,
      severity: "fail",
      detail: `token_endpoint_auth_methods_supported=${JSON.stringify(auth)} (expected ["none"], V4 FIX 12)`,
      hint: "Discovery doc must advertise public clients only — see V4 FIX 12",
    };
  }
  const pkce = doc.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || pkce.length !== 1 || pkce[0] !== "S256") {
    return {
      name: "phase2.discovery_doc",
      ok: false,
      severity: "fail",
      detail: `code_challenge_methods_supported=${JSON.stringify(pkce)} (expected ["S256"])`,
      hint: "PKCE 'plain' is rejected — only S256 is supported",
    };
  }
  return {
    name: "phase2.discovery_doc",
    ok: true,
    severity: "ok",
    detail: `issuer + ["none"] + ["S256"] all correct`,
  };
}

/**
 * Probe 3: verify GitHub OAuth client creds. If creds are set, smoke-test
 * against the GitHub token endpoint with a fake code: a valid client_id
 * + secret yields `bad_verification_code`; bad creds yield
 * `incorrect_client_credentials`.
 */
export async function probeGitHubCreds(
  clientId: string | undefined,
  clientSecret: string | undefined,
  fetchImpl: FetchLike = fetch,
  smoke: boolean = true,
): Promise<CheckResult> {
  if (!clientId || !clientSecret) {
    // GitHub OAuth App is optional since feat/optional-github-provider. Only
    // half-config (exactly one of the pair) is a problem; both-absent is a
    // legitimate Google-only / OIDC-only deployment.
    if (clientId || clientSecret) {
      return {
        name: "phase2.github_creds",
        ok: false,
        severity: "warn",
        detail: "COORDINATOR_GITHUB_CLIENT_ID/SECRET half-configured (set both or neither)",
        hint: "Set both COORDINATOR_GITHUB_CLIENT_ID and COORDINATOR_GITHUB_CLIENT_SECRET, or unset both",
      };
    }
    return {
      name: "phase2.github_creds",
      ok: true,
      severity: "ok",
      detail: "GitHub OAuth App not configured (optional)",
    };
  }
  if (!smoke) {
    return {
      name: "phase2.github_creds",
      ok: true,
      severity: "ok",
      detail: "credentials present (smoke skipped)",
    };
  }
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: "doctor-fake-code-for-smoke-test",
    });
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(text) as { error?: string };
    } catch {
      // GitHub may return form-encoded on rare errors; do a substring check
      if (text.includes("bad_verification_code")) parsed = { error: "bad_verification_code" };
      else if (text.includes("incorrect_client_credentials"))
        parsed = { error: "incorrect_client_credentials" };
    }
    if (parsed.error === "bad_verification_code") {
      return {
        name: "phase2.github_creds",
        ok: true,
        severity: "ok",
        detail: "credentials accepted by GitHub (smoke: bad_verification_code as expected)",
      };
    }
    if (parsed.error === "incorrect_client_credentials") {
      return {
        name: "phase2.github_creds",
        ok: false,
        severity: "warn",
        detail: "GitHub rejected client credentials (incorrect_client_credentials)",
        hint: "CLIENT_ID/SECRET pair is wrong — re-issue OAuth app credentials",
      };
    }
    return {
      name: "phase2.github_creds",
      ok: false,
      severity: "warn",
      detail: `unexpected GitHub response: ${parsed.error ?? text.slice(0, 80)}`,
      hint: "Inconclusive smoke — check GitHub OAuth app status manually",
    };
  } catch (e) {
    return {
      name: "phase2.github_creds",
      ok: false,
      severity: "warn",
      detail: `GitHub smoke failed: ${(e as Error).message}`,
      hint: "Network unreachable or GitHub down — creds may still be valid",
    };
  }
}

/**
 * Probe 3b: Google OAuth credentials. Mirrors probeGitHubCreds — both-absent
 * is a legitimate (non-Google) deployment, half-config is a warning, and a
 * configured pair is smoke-tested against Google's token endpoint with a fake
 * code: a valid client returns `invalid_grant` (code is bad, creds are fine),
 * a bad client returns `invalid_client`.
 */
export async function probeGoogleCreds(
  clientId: string | undefined,
  clientSecret: string | undefined,
  fetchImpl: FetchLike = fetch,
  smoke: boolean = true,
): Promise<CheckResult> {
  if (!clientId || !clientSecret) {
    if (clientId || clientSecret) {
      return {
        name: "phase2.google_creds",
        ok: false,
        severity: "warn",
        detail: "COORDINATOR_GOOGLE_CLIENT_ID/SECRET half-configured (set both or neither)",
        hint: "Set both COORDINATOR_GOOGLE_CLIENT_ID and COORDINATOR_GOOGLE_CLIENT_SECRET, or unset both",
      };
    }
    return {
      name: "phase2.google_creds",
      ok: true,
      severity: "ok",
      detail: "Google OAuth not configured (optional)",
    };
  }
  if (!smoke) {
    return {
      name: "phase2.google_creds",
      ok: true,
      severity: "ok",
      detail: "credentials present (smoke skipped)",
    };
  }
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: "doctor-fake-code-for-smoke-test",
      grant_type: "authorization_code",
      redirect_uri: "http://localhost",
    });
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(text) as { error?: string };
    } catch {
      /* non-JSON body — leave parsed empty, handled below */
    }
    if (parsed.error === "invalid_grant") {
      return {
        name: "phase2.google_creds",
        ok: true,
        severity: "ok",
        detail: "credentials accepted by Google (smoke: invalid_grant as expected)",
      };
    }
    if (parsed.error === "invalid_client") {
      return {
        name: "phase2.google_creds",
        ok: false,
        severity: "warn",
        detail: "Google rejected client credentials (invalid_client)",
        hint: "CLIENT_ID/SECRET pair is wrong — re-check the GCP OAuth client",
      };
    }
    return {
      name: "phase2.google_creds",
      ok: false,
      severity: "warn",
      detail: `unexpected Google response: ${parsed.error ?? text.slice(0, 80)}`,
      hint: "Inconclusive smoke — check the GCP OAuth client manually",
    };
  } catch (e) {
    return {
      name: "phase2.google_creds",
      ok: false,
      severity: "warn",
      detail: `Google smoke failed: ${(e as Error).message}`,
      hint: "Network unreachable or Google down — creds may still be valid",
    };
  }
}

interface SqlitePragmaDb {
  pragma(sql: string, opts?: { simple?: boolean }): unknown;
  prepare(sql: string): { get(): unknown };
  close?(): void;
}

interface SqliteOpener {
  (dbPath: string): SqlitePragmaDb;
}

function defaultSqliteOpener(dbPath: string): SqlitePragmaDb {
  // require() keeps the optional native dep out of the import graph when
  // tests inject a fake.
  const Database = require("better-sqlite3");
  return new Database(dbPath, { readonly: false, fileMustExist: true }) as SqlitePragmaDb;
}

/**
 * Probe 4: PRAGMA journal_mode/foreign_keys/busy_timeout/user_version and
 * sqlite_version sanity. Any mismatch is FAIL.
 */
export async function probeSqlite(
  dbPath: string,
  opener: SqliteOpener = defaultSqliteOpener,
): Promise<CheckResult> {
  let db: SqlitePragmaDb;
  try {
    db = opener(dbPath);
  } catch (e) {
    return {
      name: "phase2.sqlite",
      ok: false,
      severity: "fail",
      detail: `cannot open DB: ${(e as Error).message}`,
      hint: `Verify ${dbPath} exists and is readable`,
    };
  }
  try {
    const journalMode = String(db.pragma("journal_mode", { simple: true }) ?? "").toLowerCase();
    const fkRaw = db.pragma("foreign_keys", { simple: true });
    const fk = String(fkRaw);
    const busyTimeout = Number(db.pragma("busy_timeout", { simple: true }) ?? 0);
    const userVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
    const sqliteVerStr = String(
      (db.prepare("SELECT sqlite_version() AS v").get() as { v?: string } | undefined)?.v ??
        "0.0.0",
    );
    const [major, minor] = sqliteVerStr.split(".").map((x) => parseInt(x, 10));
    const sqliteVerOk = major > 3 || (major === 3 && minor >= 25);

    const problems: string[] = [];
    if (journalMode !== "wal") problems.push(`journal_mode=${journalMode} (expected wal)`);
    if (fk !== "1") problems.push(`foreign_keys=${fk} (expected 1)`);
    if (busyTimeout < 5000) problems.push(`busy_timeout=${busyTimeout} (expected >=5000)`);
    if (userVersion < 8)
      problems.push(`user_version=${userVersion} (expected >=8, Phase 2 migration)`);
    if (!sqliteVerOk) problems.push(`sqlite_version=${sqliteVerStr} (expected >=3.25)`);

    if (problems.length > 0) {
      return {
        name: "phase2.sqlite",
        ok: false,
        severity: "fail",
        detail: problems.join("; "),
        hint: "Re-run migrations or upgrade sqlite",
      };
    }
    return {
      name: "phase2.sqlite",
      ok: true,
      severity: "ok",
      detail: `journal=wal, fk=on, busy=${busyTimeout}ms, user_version=${userVersion}, sqlite=${sqliteVerStr}`,
    };
  } finally {
    try {
      db.close?.();
    } catch {}
  }
}

/**
 * Probe 5: invokes assertSecretEntropy on the configured JWT secret. The
 * entropy module already produces specific failure messages.
 */
export async function probeJwtSecretEntropy(secret: string | undefined): Promise<CheckResult> {
  if (!secret) {
    return {
      name: "phase2.jwt_secret_entropy",
      ok: false,
      severity: "fail",
      detail: "COORDINATOR_JWT_SECRET not set",
      hint: "Generate with: openssl rand -base64 32",
    };
  }
  try {
    assertSecretEntropy(Buffer.from(secret, "utf8"), 128);
    return {
      name: "phase2.jwt_secret_entropy",
      ok: true,
      severity: "ok",
      detail: "secret passes entropy gate (>=128 bits)",
    };
  } catch (e) {
    return {
      name: "phase2.jwt_secret_entropy",
      ok: false,
      severity: "fail",
      detail: (e as Error).message,
      hint: "Regenerate JWT secret with sufficient entropy (e.g. openssl rand -base64 32)",
    };
  }
}

interface HealthReady {
  checks?: {
    audit_queue?: { depth?: number; threshold_percent?: number };
    sweeper?: { ok?: boolean; circuit_open?: boolean };
  };
}

/**
 * Probe 6: scrape /health/ready and check audit queue depth.
 */
export async function probeAuditQueueDepth(
  publicUrl: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  if (!publicUrl) {
    return {
      name: "phase2.audit_queue",
      ok: false,
      severity: "fail",
      detail: "COORDINATOR_PUBLIC_URL not set",
    };
  }
  const base = stripTrailingSlash(publicUrl);
  let doc: HealthReady;
  try {
    const res = await fetchImpl(`${base}/health/ready`, { method: "GET" });
    const text = await res.text();
    doc = JSON.parse(text) as HealthReady;
  } catch (e) {
    return {
      name: "phase2.audit_queue",
      ok: false,
      severity: "fail",
      detail: `/health/ready unreachable: ${(e as Error).message}`,
      hint: "Coordinator must expose /health/ready in Phase 2",
    };
  }
  const q = doc.checks?.audit_queue;
  if (!q || typeof q.depth !== "number" || typeof q.threshold_percent !== "number") {
    return {
      name: "phase2.audit_queue",
      ok: false,
      severity: "warn",
      detail: "audit_queue check missing from /health/ready payload",
      hint: "Coordinator version may predate audit-queue health reporting",
    };
  }
  if (q.depth >= q.threshold_percent) {
    return {
      name: "phase2.audit_queue",
      ok: false,
      severity: "warn",
      detail: `audit_queue depth=${q.depth} >= threshold ${q.threshold_percent}`,
      hint: "Audit pipeline is backing up — investigate writer throughput",
    };
  }
  return {
    name: "phase2.audit_queue",
    ok: true,
    severity: "ok",
    detail: `audit_queue depth=${q.depth} < ${q.threshold_percent}`,
  };
}

/**
 * Probe 7: scrape /health/ready and check sweeper circuit.
 */
export async function probeSweeperStatus(
  publicUrl: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  if (!publicUrl) {
    return {
      name: "phase2.sweeper",
      ok: false,
      severity: "fail",
      detail: "COORDINATOR_PUBLIC_URL not set",
    };
  }
  const base = stripTrailingSlash(publicUrl);
  let doc: HealthReady;
  try {
    const res = await fetchImpl(`${base}/health/ready`, { method: "GET" });
    const text = await res.text();
    doc = JSON.parse(text) as HealthReady;
  } catch (e) {
    return {
      name: "phase2.sweeper",
      ok: false,
      severity: "warn",
      detail: `/health/ready unreachable: ${(e as Error).message}`,
      hint: "Cannot determine sweeper status without /health/ready",
    };
  }
  const s = doc.checks?.sweeper;
  if (!s) {
    return {
      name: "phase2.sweeper",
      ok: false,
      severity: "warn",
      detail: "sweeper check missing from /health/ready payload",
    };
  }
  if (s.ok === true && s.circuit_open !== true) {
    return {
      name: "phase2.sweeper",
      ok: true,
      severity: "ok",
      detail: "sweeper circuit closed",
    };
  }
  return {
    name: "phase2.sweeper",
    ok: false,
    severity: "fail",
    detail: `sweeper circuit open${s.circuit_open === true ? "" : " (ok=false)"}`,
    hint: "Sweeper failed too many times — investigate timeout-sweeper logs",
  };
}

interface AuditOpener {
  (dbPath: string): {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all?(...params: unknown[]): unknown[];
    };
    close?(): void;
  };
}

function defaultAuditOpener(dbPath: string): ReturnType<AuditOpener> {
  const Database = require("better-sqlite3");
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

// Actions emitted only by Phase 2 (auth/oauth/device-flow/etc.). Presence of
// any of these in the last 24h means the coordinator has issued Phase 2
// traffic.
const PHASE2_ACTIONS = [
  "auth.login.success",
  "auth.login.failure",
  "auth.refresh",
  "auth.token_revoke",
  "auth.logout",
  "config.boot",
  "device.approve",
  "service_token.issue",
];

/**
 * Probe 8: confirm at least one Phase 2 audit event exists in the last 24h.
 * If only Phase 1 events exist, the coordinator hasn't issued Phase 2
 * tokens yet (warn — typical on first boot).
 */
export async function probePhase2AuditEvents(
  dbPath: string,
  opener: AuditOpener = defaultAuditOpener,
): Promise<CheckResult> {
  let db: ReturnType<AuditOpener>;
  try {
    db = opener(dbPath);
  } catch (e) {
    return {
      name: "phase2.audit_events",
      ok: false,
      severity: "fail",
      detail: `cannot open DB: ${(e as Error).message}`,
    };
  }
  try {
    const placeholders = PHASE2_ACTIONS.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log
         WHERE action IN (${placeholders})
           AND datetime(created_at) >= datetime('now', '-1 day')`,
    );
    const row = stmt.get(...PHASE2_ACTIONS) as { n?: number } | undefined;
    const n = row?.n ?? 0;
    if (n > 0) {
      return {
        name: "phase2.audit_events",
        ok: true,
        severity: "ok",
        detail: `${n} Phase 2 audit event(s) in last 24h`,
      };
    }
    return {
      name: "phase2.audit_events",
      ok: false,
      severity: "warn",
      detail: "no Phase 2 audit events in last 24h",
      hint: "Expected if Phase 2 was just enabled and no clients have authenticated yet",
    };
  } catch (e) {
    return {
      name: "phase2.audit_events",
      ok: false,
      severity: "fail",
      detail: `audit_log query failed: ${(e as Error).message}`,
      hint: "audit_log table may be missing or schema-incompatible",
    };
  } finally {
    try {
      db.close?.();
    } catch {}
  }
}

export interface Phase2Env {
  publicUrl?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  jwtSecret?: string;
  dbPath: string;
}

/**
 * What to tell an operator when nothing is listening on the HTTP port.
 *
 * issue #273: this used to be one string — "Start the server" — regardless of
 * state. When a daemon had already been started and died during boot, doctor
 * printed that advice directly under a green pid-file line, i.e. it told you to
 * start the server whose PID it had just shown you. Starting it again just
 * repeats the failure; the daemon's own error is in the log.
 */
export function serverUnreachableHint(
  port: number,
  pidFromFile: number | null,
  pidAlive: boolean,
): string {
  if (pidFromFile !== null && pidAlive) {
    return (
      `PID ${pidFromFile} is alive but nothing is listening on ${port} — the daemon is stuck, ` +
      `or bound to a different port. Check ~/.mcp-coordinator/logs/server.log.`
    );
  }
  if (pidFromFile !== null) {
    return (
      `A daemon was started and is gone — it died during boot. Its error is at the end of ` +
      `~/.mcp-coordinator/logs/server.log (a busy port and a sandbox-refused bind both land there).`
    );
  }
  return `Start the server: mcp-coordinator server start --daemon (or check the configured port)`;
}
/**
 * Runs probes 1-8 in parallel and returns the result array.
 */
export async function runPhase2Probes(env: Phase2Env): Promise<CheckResult[]> {
  return Promise.all([
    probePublicUrl(env.publicUrl),
    probeDiscoveryDoc(env.publicUrl),
    probeGitHubCreds(env.githubClientId, env.githubClientSecret),
    probeGoogleCreds(env.googleClientId, env.googleClientSecret),
    probeSqlite(env.dbPath),
    probeJwtSecretEntropy(env.jwtSecret),
    probeAuditQueueDepth(env.publicUrl),
    probeSweeperStatus(env.publicUrl),
    probePhase2AuditEvents(env.dbPath),
  ]);
}

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Run a health check: config, server liveness, MCP endpoint, MQTT broker, dashboard",
    )
    .option("--host <host>", "Hostname to probe", "127.0.0.1")
    .option("--port <port>", "HTTP port", "")
    .option("--mqtt-port <port>", "MQTT TCP port", "")
    .option("--phase2", "Force-run Phase 2 OAuth/audit probes regardless of env", false)
    .action(async (opts: { host: string; port: string; mqttPort: string; phase2: boolean }) => {
      const results: CheckResult[] = [];
      const host = opts.host;

      // 0. Dependency tree (issue #282). First on purpose: if the tree is
      // incomplete the daemon physically cannot boot, and every probe below
      // would report "unreachable" with a hint telling the user to start a
      // server that cannot start.
      results.push(await checkDependencyTree());

      // 1. Config dir
      const configDir = getConfigDir();
      results.push({
        name: "config-dir",
        ok: existsSync(configDir),
        detail: existsSync(configDir) ? configDir : `missing — run 'mcp-coordinator init'`,
        hint: existsSync(configDir) ? undefined : "Run: mcp-coordinator init",
      });

      // 2. config.json
      const configFile = join(configDir, "config.json");
      let parsedConfig: ReturnType<typeof loadConfig> | null = null;
      if (existsSync(configFile)) {
        try {
          parsedConfig = loadConfig();
          results.push({
            name: "config.json",
            ok: true,
            detail: `valid — port ${parsedConfig.server.port}, data_dir ${parsedConfig.server.data_dir}`,
          });
        } catch (e) {
          results.push({
            name: "config.json",
            ok: false,
            detail: `invalid: ${(e as Error).message}`,
            hint: "Re-run 'mcp-coordinator init' to restore defaults",
          });
        }
      } else {
        results.push({
          name: "config.json",
          ok: false,
          detail: "missing — defaults will be used",
          hint: "Run: mcp-coordinator init",
        });
      }

      const port = parseInt(opts.port || String(parsedConfig?.server.port ?? 3100), 10);
      const mqttPort = parseInt(
        opts.mqttPort || process.env.COORDINATOR_MQTT_TCP_PORT || "1883",
        10,
      );

      // 3. Server PID file
      const pidPath = existingPidFilePath(configDir, port);
      let pidFromFile: number | null = null;
      let pidAlive = false;
      if (existsSync(pidPath)) {
        try {
          pidFromFile = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
          // issue #273: a parseable PID is not a running process. `server
          // status` has always probed with signal 0; doctor reported [OK] on
          // the file alone, so a daemon that died during boot showed pid-file
          // green directly above tcp-<port> red.
          const validPid = !isNaN(pidFromFile) && pidFromFile > 0;
          if (validPid) {
            try {
              process.kill(pidFromFile, 0);
              pidAlive = true;
            } catch {
              pidAlive = false;
            }
          }
          results.push({
            name: "pid-file",
            ok: validPid && pidAlive,
            detail: validPid
              ? pidAlive
                ? `PID ${pidFromFile} is running (check 'tcp-${port}' below to confirm it is actually listening)`
                : `PID ${pidFromFile} recorded, but no such process — stale file`
              : "unparseable PID",
            hint:
              validPid && !pidAlive
                ? "The daemon died. Its own error is at the end of ~/.mcp-coordinator/logs/server.log; clear the file with 'mcp-coordinator server stop'."
                : undefined,
          });
        } catch {
          results.push({
            name: "pid-file",
            ok: false,
            detail: "exists but unreadable",
            hint: "Stale state — run 'mcp-coordinator server stop' or delete ~/.mcp-coordinator/server.pid",
          });
        }
      } else {
        results.push({
          name: "pid-file",
          ok: false,
          detail: "absent (server not running in daemon mode)",
          hint: "Start the server: mcp-coordinator server start --daemon",
        });
      }

      // 4. HTTP TCP reachable
      const httpUp = await tcpReachable(host, port);
      results.push({
        name: `tcp-${port}`,
        ok: httpUp,
        detail: httpUp ? `${host}:${port} accepts connections` : `${host}:${port} unreachable`,
        hint: httpUp ? undefined : serverUnreachableHint(port, pidFromFile, pidAlive),
      });

      // 5. /health endpoint
      if (httpUp) {
        const health = await httpGet(host, port, "/health");
        results.push({
          name: "/health",
          ok: !!health && health.status === 200,
          detail: health ? `HTTP ${health.status}: ${health.body}` : "no response",
          hint:
            !!health && health.status === 200
              ? undefined
              : "Server is reachable but /health failed; check server logs",
        });

        // 6. /mcp initialize
        const mcpOk = await mcpInitialize(host, port);
        results.push({
          name: "/mcp initialize",
          ok: mcpOk,
          detail: mcpOk ? "JSON-RPC 2.0 initialize succeeded" : "no valid MCP response",
          hint: mcpOk
            ? undefined
            : "MCP HTTP transport not responding; check server logs and version compatibility",
        });

        // 7. Dashboard
        const dash = await httpGet(host, port, "/dashboard/");
        results.push({
          name: "/dashboard",
          ok: !!dash && dash.status === 200,
          detail: dash ? `HTTP ${dash.status}` : "no response",
          hint:
            !!dash && dash.status === 200
              ? undefined
              : "Dashboard files not found; verify package install or rerun init",
        });
      }

      // 8. MQTT broker
      const mqttUp = await tcpReachable(host, mqttPort);
      results.push({
        name: `mqtt-${mqttPort}`,
        ok: mqttUp,
        detail: mqttUp
          ? `${host}:${mqttPort} accepts connections`
          : `${host}:${mqttPort} unreachable`,
        hint: mqttUp
          ? undefined
          : `MQTT broker not listening on port ${mqttPort}; check COORDINATOR_MQTT_TCP_PORT and server logs`,
      });

      // ---- Phase 2 probes (T42) ----
      const phase2Enabled =
        opts.phase2 === true || process.env.COORDINATOR_OAUTH_ENABLED === "true";
      let phase2Results: CheckResult[] = [];
      if (phase2Enabled) {
        const dbPath = join(
          parsedConfig?.server.data_dir ?? join(configDir, "data"),
          "coordinator.db",
        );
        phase2Results = await runPhase2Probes({
          publicUrl: process.env.COORDINATOR_PUBLIC_URL,
          githubClientId: process.env.COORDINATOR_GITHUB_CLIENT_ID,
          githubClientSecret: process.env.COORDINATOR_GITHUB_CLIENT_SECRET,
          googleClientId: process.env.COORDINATOR_GOOGLE_CLIENT_ID,
          googleClientSecret: process.env.COORDINATOR_GOOGLE_CLIENT_SECRET,
          jwtSecret: process.env.COORDINATOR_JWT_SECRET,
          dbPath,
        });
      }

      // Print Phase 1
      let anyFail = false;
      let anyWarn = false;
      console.log("");
      for (const r of results) {
        const prefix = r.ok ? "[ OK ]" : "[FAIL]";
        console.log(`${prefix}  ${r.name.padEnd(20)} ${r.detail}`);
        if (!r.ok) {
          anyFail = true;
          if (r.hint) console.log(`        hint: ${r.hint}`);
        }
      }

      // Print Phase 2
      if (phase2Enabled) {
        console.log("");
        console.log("-- Phase 2 probes (COORDINATOR_OAUTH_ENABLED=true) --");
        for (const r of phase2Results) {
          const sev = r.severity ?? (r.ok ? "ok" : "fail");
          const prefix = sev === "ok" ? "[ OK ]" : sev === "warn" ? "[WARN]" : "[FAIL]";
          const hintStr = r.hint ? ` (${r.hint})` : "";
          console.log(`${prefix}  ${r.name.padEnd(28)} ${r.detail}${sev === "ok" ? "" : hintStr}`);
          if (sev === "warn") anyWarn = true;
          if (sev === "fail") anyFail = true;
        }
      }

      console.log("");
      if (!anyFail && !anyWarn) {
        console.log("All checks passed. Coordinator is healthy.");
        return;
      }
      if (anyFail) {
        console.log("Some checks failed. See hints above.");
        process.exit(2);
      }
      console.log("Checks passed with warnings. See hints above.");
      process.exit(1);
    });
}
