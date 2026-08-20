import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { initAuth, authenticateRequest, initPhase2Auth, resetPhase2Auth } from "../../src/auth.js";
import { mintAccessJWT } from "../../src/auth/jwt-mint.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";

/**
 * issue #313 — ServiceTokenScope is validated at minting
 * (src/auth/service-tokens.ts) and signed into the JWT, and the verifier then
 * dropped it on the floor. Nothing downstream could see it, so a
 * `--scope read` token wrote, deleted and published exactly like an
 * `--scope admin` one. A guardrail that exists at one end of the wire and
 * nowhere else.
 *
 * This carries the claim through verification. It is NOT enforcement, and
 * saying so matters: nothing reads AuthClaims.scope yet, and WHERE to enforce
 * is the open half of the issue — /mcp is a single endpoint and authentication
 * runs before the JSON-RPC body is read, so the tool name is not visible at
 * the gate. That is a decision, and it is not this change.
 *
 * What this buys: the claim is observable, which every option in that decision
 * needs first.
 */

const DIR = "data-test-scope-claim";
const PHASE1_SECRET = "a".repeat(64);
const SIGNING_SECRET = "b".repeat(64);
const ISSUER = "https://coordinator.example.com";
const registry = buildJwtKeyRegistry(Buffer.from(SIGNING_SECRET, "utf8"));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function bearer(token: string): IncomingMessage {
  return {
    headers: { authorization: "Bearer " + token },
    url: "/api/something",
    method: "GET",
  } as unknown as IncomingMessage;
}

function seed(): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run("org-acme", "Acme", "acme");
  getDb()
    .prepare(
      `INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id, role, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("u-svc", "org-acme", "svc@example.com", "github", "gh-svc", "member", 0);
}

/**
 * Mint a real service token carrying the given scope.
 *
 * service_account=true makes the verifier DB-validate the jti against a
 * refresh_tokens row whose family_id starts with "service:" (T25, so an admin
 * force-revoke wins immediately), so the row has to exist or the token is
 * rejected long before the scope is read.
 */
let jtiSeq = 0;
async function tokenWithScope(scope: unknown): Promise<string> {
  jtiSeq += 1;
  const jti = "svc-jti-" + jtiSeq;
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    )
    .run("id-" + jti, "u-svc", "org-acme", jti, "service:ci", String(now + 3600), String(now));

  return await mintAccessJWT({
    claims: {
      sub: "u-svc",
      active_org_id: "org-acme",
      role: "service",
      service_account: true,
      ...(scope === undefined ? {} : { scope }),
    } as never,
    jti,
    registry,
    issuer: ISSUER,
    ttlSeconds: 3600,
  });
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

beforeEach(() => {
  getDb().exec(
    "DELETE FROM audit_log; DELETE FROM refresh_tokens; DELETE FROM users; DELETE FROM orgs;",
  );
  resetPhase2Auth();
  initPhase2Auth({
    db: getDb() as unknown as Database.Database,
    signingKeys: registry,
    publicUrl: ISSUER,
  });
  seed();
});

afterAll(() => {
  resetPhase2Auth();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("the minted service-token scope survives verification (#313)", () => {
  for (const scope of ["read", "write", "admin"] as const) {
    it('carries scope="' + scope + '" onto the verified claims', async () => {
      const result = await authenticateRequest(bearer(await tokenWithScope(scope)), {
        authEnabled: true,
      });
      expect(result.ok, "token was rejected — harness problem, not a scope problem").toBe(true);
      if (result.ok) expect(result.claims.scope).toBe(scope);
    });
  }

  it("a token minted without a scope has none", async () => {
    // Every Phase 1 agent token and every cookie session is in this case.
    const result = await authenticateRequest(bearer(await tokenWithScope(undefined)), {
      authEnabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.scope).toBeUndefined();
  });

  it("an unrecognised scope becomes undefined rather than propagating", async () => {
    // The value arrives inside a signed token, so it is not attacker-chosen
    // today — but the verifier must not widen the type on a claim it does not
    // recognise. That is how a typo becomes a permission later.
    const result = await authenticateRequest(bearer(await tokenWithScope("superuser")), {
      authEnabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.scope).toBeUndefined();
  });

  it("the three scopes still match the minting enum", () => {
    // If the enum grows a fourth value, the narrowing in the verifier silently
    // drops it — this is the test that notices.
    const line = read("src/auth/service-tokens.ts")
      .split("\n")
      .find((l) => l.includes("export type ServiceTokenScope"));
    expect(line, "ServiceTokenScope declaration moved").toBeDefined();
    expect([...line!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "admin",
      "read",
      "write",
    ]);
  });

  it("carrying the claim is not enforcement, and nothing pretends otherwise", () => {
    // The whole point of #313 is that a validated-then-discarded value reads
    // like a guardrail. Adding a reader without a decision would repeat the
    // mistake in the other direction: an enforcement point nobody chose.
    for (const file of [
      "src/tools/consultation-tools.ts",
      "src/tools/agents-tools.ts",
      "src/http/handle-rest.ts",
    ]) {
      expect(
        read(file),
        file + " now branches on claims.scope — that is #313's open decision",
      ).not.toContain("claims.scope");
    }
  });
});
