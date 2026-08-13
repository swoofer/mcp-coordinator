/**
 * securite-surface-05 — POST /api/auth/register is Phase 1 and NOT
 * authenticated (agent_name + registration_secret only). Without a rate
 * limit an attacker can mass-register agents: brute-force
 * registration_secret, or (with a valid/leaked secret) mint an unbounded
 * number of JWTs. This proves the per-IP token-bucket limiter wired in
 * src/serve-http.ts (registerRateLimiter, REGISTER_RATE_LIMIT_CONFIG)
 * actually rejects requests past the configured budget with 429 +
 * Retry-After, and that legitimate registration under the budget still
 * works end-to-end (mints a usable token).
 *
 * serve-http.ts reads COORDINATOR_AUTH_ENABLED / _JWT_SECRET /
 * _REGISTRATION_SECRET / _ADMIN_SECRET / _REGISTER_RATE_LIMIT_PER /
 * _REGISTER_RATE_LIMIT_WINDOW_SECONDS into MODULE-LEVEL consts evaluated
 * once at import time (unlike COORDINATOR_OAUTH_ENABLED, which bootPhase2
 * reads live inside startServer()). So this file sets all required env
 * vars BEFORE the first dynamic `import()` of serve-http.js, and never
 * statically imports it — each vitest test file gets its own fresh module
 * registry, so this is the only way to bake in a small rate-limit budget
 * (3 req / 60s) for a fast, deterministic test instead of the 10 req/60s
 * production default.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { startServer as StartServerFn, ServerHandle } from "../../src/serve-http.js";

const STRONG_JWT_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY9elk5cQ==";
const REGISTRATION_SECRET = "register-rate-limit-test-registration-secret";
const ADMIN_SECRET = "register-rate-limit-test-admin-secret";
const RATE_LIMIT_PER = "3";
const RATE_LIMIT_WINDOW_SECONDS = "60";

const ENV_KEYS = [
  "COORDINATOR_AUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_REGISTRATION_SECRET",
  "COORDINATOR_ADMIN_SECRET",
  "COORDINATOR_REGISTER_RATE_LIMIT_PER",
  "COORDINATOR_REGISTER_RATE_LIMIT_WINDOW_SECONDS",
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let startServer: typeof StartServerFn;

beforeAll(async () => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  process.env.COORDINATOR_AUTH_ENABLED = "true";
  process.env.COORDINATOR_JWT_SECRET = STRONG_JWT_SECRET;
  process.env.COORDINATOR_REGISTRATION_SECRET = REGISTRATION_SECRET;
  process.env.COORDINATOR_ADMIN_SECRET = ADMIN_SECRET;
  process.env.COORDINATOR_REGISTER_RATE_LIMIT_PER = RATE_LIMIT_PER;
  process.env.COORDINATOR_REGISTER_RATE_LIMIT_WINDOW_SECONDS = RATE_LIMIT_WINDOW_SECONDS;

  // Dynamic import — see file header. Must happen AFTER the env vars above
  // are set, since serve-http.ts reads them into module-level consts once,
  // at import time.
  ({ startServer } = await import("../../src/serve-http.js"));
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

let handle: ServerHandle | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  if (handle) {
    await handle.stop().catch(() => undefined);
    handle = undefined;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

interface RegisterResp {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: () => unknown;
}

function postRegister(
  port: number,
  body: { agent_name?: string; registration_secret?: string },
): Promise<RegisterResp> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/auth/register",
        method: "POST",
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            json: () => JSON.parse(buf),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(bodyStr);
    req.end();
  });
}

async function bootServer(prefix: string): Promise<{ port: number }> {
  dataDir = mkdtempSync(path.join(tmpdir(), prefix));
  // Port 0 = bound-once, OS-assigned. Probing for a free port and re-binding
  // it left a window for a parallel vitest worker to steal it (EADDRINUSE).
  handle = await startServer({
    port: 0,
    dataDir,
    mqttTcpPort: 0,
    registerSignalHandlers: false,
  });
  return { port: handle.port };
}

describe("POST /api/auth/register — per-IP rate limit (securite-surface-05)", () => {
  it("R1/R3: allows requests up to the configured budget, then 429 + Retry-After beyond it", async () => {
    const { port } = await bootServer("register-rl-basic-");

    // Budget is 3 req/60s (env override above). The first 3 succeed...
    for (let i = 0; i < 3; i++) {
      const res = await postRegister(port, {
        agent_name: `agent-${i}`,
        registration_secret: REGISTRATION_SECRET,
      });
      expect(res.status).toBe(200);
    }

    // ...the 4th is rejected with 429 + a numeric Retry-After header.
    const blocked = await postRegister(port, {
      agent_name: "agent-4th",
      registration_secret: REGISTRATION_SECRET,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("R5 adversarial: a request strictly under the budget is NEVER rate-limited and mints a usable token", async () => {
    const { port } = await bootServer("register-rl-under-budget-");

    // Only 2 requests against a budget of 3 — must never see 429, and the
    // response must be a real, well-formed registration (not just "not
    // 429" — proves the limiter didn't also break normal register).
    for (let i = 0; i < 2; i++) {
      const res = await postRegister(port, {
        agent_name: `agent-under-${i}`,
        registration_secret: REGISTRATION_SECRET,
      });
      expect(res.status).toBe(200);
      const body = res.json() as { agent_id: string; token: string; role: string };
      expect(body.agent_id).toBeDefined();
      expect(typeof body.token).toBe("string");
      expect(body.token.split(".")).toHaveLength(3); // JWT shape
      expect(body.role).toBe("agent");
    }
  });

  it("counts FAILED (invalid-secret) attempts against the same budget, not just successful ones", async () => {
    const { port } = await bootServer("register-rl-failed-counts-");

    // 3 failed attempts (wrong secret) exhaust the budget just like
    // successful ones would — the check happens before credential
    // validation, so an attacker brute-forcing the secret can't get
    // unlimited guesses.
    for (let i = 0; i < 3; i++) {
      const res = await postRegister(port, {
        agent_name: `bad-${i}`,
        registration_secret: "totally-wrong-secret",
      });
      expect(res.status).toBe(401);
    }

    // 4th request — even with the CORRECT secret this time — is 429, not
    // 401 or 200, proving the budget is shared across pass/fail attempts.
    const res = await postRegister(port, {
      agent_name: "agent-should-be-blocked",
      registration_secret: REGISTRATION_SECRET,
    });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
