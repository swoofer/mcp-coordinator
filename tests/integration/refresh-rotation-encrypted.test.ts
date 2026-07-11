import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { SignJWT } from "jose";
import { refreshTokenGrant } from "../../src/auth/refresh-rotation.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";
import { IdPTokenRevoked } from "../../src/auth/providers/errors.js";
import { findAuditRows } from "../helpers/audit.js";
import { makeTestEncryption, selectIdpToken } from "../helpers/encryption.js";
import * as auditModule from "../../src/security/audit.js";
import { readTokenEpoch } from "../../src/auth/token-epoch.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { randomBytes } from "node:crypto";

/**
 * T09 — refresh-rotation IdP-token decrypt/encrypt round-trip + error mapping.
 *
 * Asserts:
 *   1. enc:v1: row + correct key → decrypt OK, IdP refresh path encrypts new tokens.
 *   2. Plaintext row + correct key (lazy migration) → no error; UPDATE re-encrypts.
 *   3. enc:v1: row + WRONG key → DEKUnwrapFailed → bumpTokenEpoch + 401 + audits.
 *   4. enc:v99: (UnknownCipherVersion) → same mapped path.
 *   5. Plaintext attacker-overwrite of an enc:v1: column → passthrough → IdP 401 → existing path.
 */

const DIR = "data-test-refresh-rotation-encrypted";

const SIGNING_SECRET = Buffer.alloc(32, 0x01);
const ISSUER = "http://localhost:3000";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);

interface MockResponse {
  statusCode: number | null;
  headers: Record<string, string | string[]>;
  body: string | null;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | string[] | undefined;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) this.headers = { ...this.headers, ...headers };
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    end(payload) {
      this.body = payload ?? null;
    },
  };
  return res;
}

function mockRequest(body: Record<string, string>): IncomingMessage {
  const encoded = new URLSearchParams(body).toString();
  const stream = Readable.from([Buffer.from(encoded, "utf8")]);
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "10.0.0.1",
  };
  (stream as unknown as { headers: Record<string, string> }).headers = {
    "user-agent": "test/1.0",
  };
  return stream as unknown as IncomingMessage;
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

interface ProviderOpts {
  /** First listMemberships call result. */
  list?: () => Promise<string[]>;
  /** If set, refreshIdpToken returns this. */
  refresh?: () => Promise<{ accessToken: string; refreshToken?: string }>;
}

function makeProvider(opts: ProviderOpts = {}): IdPProvider {
  return {
    name: "github-app",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("unused");
    },
    listMemberships: opts.list ?? (async () => ["acme"]),
    refreshIdpToken: opts.refresh,
  } as IdPProvider;
}

function makeCtx(
  encryptionProvider: AuthHandlerContext["encryptionProvider"],
  providerOpts: ProviderOpts = {},
  ctxOverrides: Partial<AuthHandlerContext> = {},
): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(makeProvider(providerOpts)),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
    membershipCache,
    encryptionProvider,
    ...ctxOverrides,
  };
}

function seedOrg(orgId = "org-acme", allowlist = "acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", allowlist);
}

function seedUser(opts: {
  id?: string;
  orgId?: string;
  idpAccessToken: string | null;
  idpRefreshToken?: string | null;
  idpProvider?: string;
  tokenEpoch?: number;
} = { idpAccessToken: null }): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id,
          idp_access_token, idp_refresh_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id ?? "u-alice",
      opts.orgId ?? "org-acme",
      "alice@example.com",
      opts.idpProvider ?? "github-app",
      "gh-100",
      opts.idpAccessToken,
      opts.idpRefreshToken ?? null,
      "member",
      "0",
      opts.tokenEpoch ?? 0,
    );
}

function seedRefreshRow(jti: string, opts: { userId?: string; orgId?: string; familyId?: string } = {}): void {
  const familyId = opts.familyId ?? "fam-root";
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${jti}`,
      opts.userId ?? "u-alice",
      opts.orgId ?? "org-acme",
      jti,
      familyId,
      null,
      null,
      String(clock.now() + 30 * 86400),
      String(clock.now()),
      null,
    );
}

async function mintRefresh(jti: string): Promise<string> {
  const builder = new SignJWT({
    sub: "u-alice",
    active_org_id: "org-acme",
    family_id: "fam-root",
    typ: "refresh",
  })
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setIssuedAt(clock.now())
    .setExpirationTime(clock.now() + 30 * 86400)
    .setJti(jti);
  return builder.sign(new Uint8Array(SIGNING_SECRET));
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

beforeEach(() => {
  vi.restoreAllMocks();
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM user_orgs");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
  getDb().exec("DELETE FROM oauth_state");
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. enc:v1: row + correct key → full round-trip
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — encrypted IdP tokens (T09)", () => {
  it("enc:v1: row + correct key → decrypt, refresh IdP, re-encrypt new tokens", async () => {
    const enc = makeTestEncryption();
    seedOrg();
    // Seed encrypted IdP tokens.
    const encAccess = enc.provider.encrypt("stale-access", {
      org_id: "org-acme",
      column: "idp_access_token",
      user_id: "u-alice",
    });
    const encRefresh = enc.provider.encrypt("stored-refresh", {
      org_id: "org-acme",
      column: "idp_refresh_token",
      user_id: "u-alice",
    });
    expect(encAccess.startsWith("enc:v1:")).toBe(true);
    expect(encRefresh.startsWith("enc:v1:")).toBe(true);

    seedUser({ idpAccessToken: encAccess, idpRefreshToken: encRefresh });
    const token = await mintRefresh("jti-enc-roundtrip");
    seedRefreshRow("jti-enc-roundtrip");

    // First listMemberships throws so refresh path runs.
    let listCalls = 0;
    const ctx = makeCtx(enc.provider, {
      list: async () => {
        listCalls += 1;
        if (listCalls === 1) throw new IdPTokenRevoked();
        return ["acme"];
      },
      refresh: async () => ({
        accessToken: "ghu-new",
        refreshToken: "ghr-rotated",
      }),
    });

    const res = mockResponse();
    await refreshTokenGrant(mockRequest({ refresh_token: token }), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(200);

    // Stored values must be enc:v1: prefixed.
    const row = getDb()
      .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = ?")
      .get("u-alice") as { idp_access_token: string; idp_refresh_token: string };
    expect(row.idp_access_token.startsWith("enc:v1:")).toBe(true);
    expect(row.idp_refresh_token.startsWith("enc:v1:")).toBe(true);

    // Decrypt round-trip matches what refreshIdpToken returned.
    const access = selectIdpToken(
      getDb() as unknown as Parameters<typeof selectIdpToken>[0],
      "u-alice",
      "idp_access_token",
      enc.provider,
    );
    const refresh = selectIdpToken(
      getDb() as unknown as Parameters<typeof selectIdpToken>[0],
      "u-alice",
      "idp_refresh_token",
      enc.provider,
    );
    expect(access).toBe("ghu-new");
    expect(refresh).toBe("ghr-rotated");
  });

  // -------------------------------------------------------------------------
  // 2. Plaintext row + correct key (lazy migration)
  // -------------------------------------------------------------------------
  it("plaintext row + correct key → no error; rotated tokens re-encrypted", async () => {
    const enc = makeTestEncryption();
    seedOrg();
    // Plaintext, no enc:v prefix.
    seedUser({
      idpAccessToken: "legacy-plaintext-access",
      idpRefreshToken: "legacy-plaintext-refresh",
    });
    const token = await mintRefresh("jti-lazy-migrate");
    seedRefreshRow("jti-lazy-migrate");

    let listCalls = 0;
    const ctx = makeCtx(enc.provider, {
      list: async () => {
        listCalls += 1;
        if (listCalls === 1) throw new IdPTokenRevoked();
        return ["acme"];
      },
      refresh: async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }),
    });

    const res = mockResponse();
    await refreshTokenGrant(mockRequest({ refresh_token: token }), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(200);

    const row = getDb()
      .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = ?")
      .get("u-alice") as { idp_access_token: string; idp_refresh_token: string };
    expect(row.idp_access_token.startsWith("enc:v1:")).toBe(true);
    expect(row.idp_refresh_token.startsWith("enc:v1:")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. enc:v1: + WRONG key → DEKUnwrapFailed mapped path
  // -------------------------------------------------------------------------
  it("enc:v1: row + WRONG key → bumpTokenEpoch + 401 + decrypt-failed and token-revoked audits", async () => {
    // Encrypt with the original key.
    const original = makeTestEncryption();
    seedOrg();
    const encAccess = original.provider.encrypt("real-access", {
      org_id: "org-acme",
      column: "idp_access_token",
      user_id: "u-alice",
    });
    seedUser({ idpAccessToken: encAccess, idpRefreshToken: null });
    const token = await mintRefresh("jti-wrong-key");
    seedRefreshRow("jti-wrong-key");

    // Build provider with a DIFFERENT key — decrypt will fail with DEKUnwrapFailed.
    const wrongProvider = new EnvelopeEncryption(randomBytes(32));
    const ctx = makeCtx(wrongProvider);

    const auditSpy = vi.spyOn(auditModule, "audit");

    const epochBefore = readTokenEpoch(getDb() as unknown as Parameters<typeof readTokenEpoch>[0], "u-alice");
    const res = mockResponse();
    await refreshTokenGrant(mockRequest({ refresh_token: token }), res as unknown as ServerResponse, ctx);

    // HTTP shape mirrors existing IdPTokenRevoked path (401 + Bearer header).
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["WWW-Authenticate"])).toMatch(/Bearer realm="coordinator"/);
    expect(String(res.headers["WWW-Authenticate"])).toMatch(/error="invalid_token"/);
    const body = JSON.parse(res.body!) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/identity provider/i);

    // Both audits emitted via spy (encryption.decrypt.failed + auth.idp.token_revoked).
    const decryptCalls = auditSpy.mock.calls.filter((c) => c[0] === "encryption.decrypt.failed");
    expect(decryptCalls).toHaveLength(1);
    const decryptMeta = decryptCalls[0]![1]?.metadata as Record<string, unknown>;
    expect(decryptMeta.error_class).toBe("DEKUnwrapFailed");
    expect(typeof decryptMeta.user_id_hash).toBe("string");
    expect((decryptMeta.user_id_hash as string).length).toBe(16);

    const revokedAudits = findAuditRows("auth.idp.token_revoked");
    expect(revokedAudits).toHaveLength(1);
    const revokedMeta = JSON.parse(revokedAudits[0]!.metadata_json as string);
    expect(revokedMeta.user_id).toBe("u-alice");
    expect(revokedMeta.phase).toBe("refresh_decrypt_failed");

    // token_epoch bumped by at least 1 (actual value is MAX(wall, current+1)).
    const epochAfter = readTokenEpoch(getDb() as unknown as Parameters<typeof readTokenEpoch>[0], "u-alice");
    expect(epochAfter).toBeGreaterThan(epochBefore);
  });

  // -------------------------------------------------------------------------
  // 4. enc:v99: UnknownCipherVersion → same mapped path
  // -------------------------------------------------------------------------
  it("enc:v99: (unknown version) row → same mapped re-auth path", async () => {
    const enc = makeTestEncryption();
    seedOrg();
    // Synthetic unknown-version blob — never parsed beyond prefix detection.
    seedUser({ idpAccessToken: "enc:v99:bogusdata", idpRefreshToken: null });
    const token = await mintRefresh("jti-unknown-ver");
    seedRefreshRow("jti-unknown-ver");

    const ctx = makeCtx(enc.provider);
    const auditSpy = vi.spyOn(auditModule, "audit");

    const epochBefore = readTokenEpoch(getDb() as unknown as Parameters<typeof readTokenEpoch>[0], "u-alice");
    const res = mockResponse();
    await refreshTokenGrant(mockRequest({ refresh_token: token }), res as unknown as ServerResponse, ctx);

    expect(res.statusCode).toBe(401);
    const decryptCalls = auditSpy.mock.calls.filter((c) => c[0] === "encryption.decrypt.failed");
    expect(decryptCalls).toHaveLength(1);
    expect((decryptCalls[0]![1]?.metadata as Record<string, unknown>).error_class).toBe("UnknownCipherVersion");

    const revokedAudits = findAuditRows("auth.idp.token_revoked");
    expect(revokedAudits).toHaveLength(1);
    const meta = JSON.parse(revokedAudits[0]!.metadata_json as string);
    expect(meta.phase).toBe("refresh_decrypt_failed");

    const epochAfter = readTokenEpoch(getDb() as unknown as Parameters<typeof readTokenEpoch>[0], "u-alice");
    expect(epochAfter).toBeGreaterThan(epochBefore);
  });

  // -------------------------------------------------------------------------
  // 5. Attacker-overwrite plaintext (silent downgrade) → IdP 401 path
  // -------------------------------------------------------------------------
  it("attacker overwrites enc:v1: with arbitrary plaintext → passthrough → IdP 401 → existing revoked path", async () => {
    const enc = makeTestEncryption();
    seedOrg();
    // "stolen-token" is plaintext (no enc:v prefix) — passes through decrypt
    // as-is, gets handed to the IdP which then rejects it.
    seedUser({ idpAccessToken: "stolen-token", idpRefreshToken: null });
    const token = await mintRefresh("jti-attacker");
    seedRefreshRow("jti-attacker");

    const auditSpy = vi.spyOn(auditModule, "audit");

    const ctx = makeCtx(enc.provider, {
      list: async (..._args: unknown[]) => {
        throw new IdPTokenRevoked();
      },
    });

    const res = mockResponse();
    await refreshTokenGrant(mockRequest({ refresh_token: token }), res as unknown as ServerResponse, ctx);

    expect(res.statusCode).toBe(401);

    // Crucially: NO encryption.decrypt.failed audit (plaintext path didn't throw).
    const decryptCalls = auditSpy.mock.calls.filter((c) => c[0] === "encryption.decrypt.failed");
    expect(decryptCalls).toHaveLength(0);

    // The existing IdPTokenRevoked path emitted with phase=refresh_membership_check.
    const revokedAudits = findAuditRows("auth.idp.token_revoked");
    expect(revokedAudits).toHaveLength(1);
    const meta = JSON.parse(revokedAudits[0]!.metadata_json as string);
    expect(meta.phase).toBe("refresh_membership_check");
  });
});
