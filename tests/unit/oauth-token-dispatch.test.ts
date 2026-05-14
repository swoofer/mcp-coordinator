import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { SignJWT } from "jose";
import { handleOAuthToken } from "../../src/auth/oauth-token.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";
import {
  IdPTokenRevoked,
  IdPTransientError,
} from "../../src/auth/providers/errors.js";
import { findAuditRows } from "../helpers/audit.js";
import { hashIdpUserId } from "../../src/auth/audit-helpers.js";

/**
 * T18 — POST /api/auth/oauth/token unified grant dispatcher.
 *
 * Covers all three RFC 6749 §6 grant-types plus the dispatcher pre-flight:
 *   - Dispatch validation (missing/unknown grant_type)
 *   - authorization_code: missing params, IdP errors, allowlist, happy path
 *   - urn:ietf:params:oauth:grant-type:device_code: poll states + happy path
 *   - refresh_token: delegate-to-T19 sanity check (full coverage in T19 suite)
 */

const DIR = "data-test-oauth-token-dispatch";

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

function mockRequest(
  body: Record<string, string>,
  opts: { ip?: string; userAgent?: string } = {},
): IncomingMessage {
  const encoded = new URLSearchParams(body).toString();
  const stream = Readable.from([Buffer.from(encoded, "utf8")]);
  (stream as unknown as { socket: { remoteAddress: string | undefined } }).socket = {
    remoteAddress: opts.ip,
  };
  (stream as unknown as { headers: Record<string, string> }).headers = {
    "user-agent": opts.userAgent ?? "test-agent/1.0",
  };
  return stream as unknown as IncomingMessage;
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

interface ProviderOverrides {
  exchangeCode?: (code: string, redirectUri: string, codeVerifier?: string) => Promise<ExchangeCodeResult>;
  listMemberships?: (accessToken: string) => Promise<string[]>;
}

function makeProvider(overrides: ProviderOverrides = {}): IdPProvider {
  return {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode:
      overrides.exchangeCode ??
      (async (): Promise<ExchangeCodeResult> => {
        throw new Error("exchangeCode not stubbed for this test");
      }),
    listMemberships:
      overrides.listMemberships ?? (async (): Promise<string[]> => ["acme"]),
  } as IdPProvider;
}

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    githubProvider: makeProvider(),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
    membershipCache,
    ...overrides,
  };
}

function seedOrg(orgId = "org-acme", allowlist = "acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", allowlist);
}

function seedUser(
  opts: {
    id?: string;
    orgId?: string;
    role?: "admin" | "member" | "service";
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id ?? "u-alice",
      opts.orgId ?? "org-acme",
      "alice@example.com",
      "github",
      "gh-100",
      "idp-tok",
      opts.role ?? "member",
      "0",
      0,
    );
}

interface DeviceRowOpts {
  deviceCode: string;
  userCode?: string;
  nonce?: string;
  approvedUserId?: string | null;
  deniedAt?: number | null;
  expiresAt?: number;
  lastPolledAt?: number | null;
  interval?: number;
  orgId?: string | null;
}

function seedDeviceRow(opts: DeviceRowOpts): void {
  getDb()
    .prepare(
      `INSERT INTO device_auth_requests
         (device_code, user_code, nonce, approved_user_id, denied_at,
          expires_at, last_polled_at, interval, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.deviceCode,
      opts.userCode ?? `UC-${opts.deviceCode}`,
      opts.nonce ?? `nonce-${opts.deviceCode}`,
      opts.approvedUserId ?? null,
      opts.deniedAt ?? null,
      String(opts.expiresAt ?? clock.now() + 600),
      opts.lastPolledAt ?? null,
      opts.interval ?? 5,
      opts.orgId ?? null,
    );
}

async function mintRefresh(opts: {
  sub?: string;
  orgId?: string;
  familyId?: string;
  jti?: string;
} = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "u-alice",
    active_org_id: opts.orgId ?? "org-acme",
    family_id: opts.familyId ?? "fam-root",
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setIssuedAt(clock.now())
    .setExpirationTime(clock.now() + 30 * 86400)
    .setJti(opts.jti ?? "jti-current")
    .sign(new Uint8Array(SIGNING_SECRET));
}

function seedRefreshRow(opts: {
  jti: string;
  userId?: string;
  orgId?: string;
  familyId?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      `id-${opts.jti}`,
      opts.userId ?? "u-alice",
      opts.orgId ?? "org-acme",
      opts.jti,
      opts.familyId ?? "fam-root",
      String(clock.now() + 30 * 86400),
      String(clock.now()),
    );
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM device_auth_requests");
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

// ===========================================================================
// Dispatch validation (3 cases)
// ===========================================================================
describe("handleOAuthToken — dispatch validation", () => {
  it("missing grant_type → 400 invalid_request", async () => {
    const req = mockRequest({ foo: "bar" });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/grant_type/i);
  });

  it("unknown grant_type → 400 unsupported_grant_type", async () => {
    const req = mockRequest({ grant_type: "client_credentials" });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("unsupported_grant_type");
    expect(body.error_description).toMatch(/client_credentials/);
  });

  it("empty body → 400 invalid_request (no grant_type)", async () => {
    const req = mockRequest({});
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_request");
  });

  it("stream error during body parse → still routes to invalid_request", async () => {
    // .catch(() => ({})) in the dispatcher turns a parse failure into an
    // empty body, which trips the missing-grant_type branch.
    const stream = new Readable({
      read() {
        process.nextTick(() => this.emit("error", new Error("boom")));
      },
    });
    (stream as unknown as { headers: Record<string, string> }).headers = {};
    const res = mockResponse();
    await handleOAuthToken(
      stream as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_request");
  });
});

// ===========================================================================
// authorization_code grant (5 cases)
// ===========================================================================
describe("handleOAuthToken — grant_type=authorization_code", () => {
  it("missing code → 400 invalid_request", async () => {
    const req = mockRequest({
      grant_type: "authorization_code",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/code or redirect_uri/i);
  });

  it("missing redirect_uri → 400 invalid_request", async () => {
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "auth-code-1",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_request");
  });

  it("IdPTokenRevoked from exchangeCode → 401 invalid_grant + Tier 1 audit", async () => {
    const provider = makeProvider({
      exchangeCode: async () => {
        throw new IdPTokenRevoked("revoked");
      },
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    const audits = findAuditRows("auth.idp.token_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.phase).toBe("auth_code_grant");
  });

  it("IdPTransientError from exchangeCode → 503 temporarily_unavailable", async () => {
    const provider = makeProvider({
      exchangeCode: async () => {
        throw new IdPTransientError("upstream 502");
      },
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!).error).toBe("temporarily_unavailable");
  });

  it("unknown error from exchangeCode → re-thrown to caller", async () => {
    const provider = makeProvider({
      exchangeCode: async () => {
        throw new Error("boom");
      },
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await expect(
      handleOAuthToken(
        req,
        res as unknown as ServerResponse,
        makeCtx({ githubProvider: provider }),
      ),
    ).rejects.toThrow(/boom/);
  });

  it("happy path: new user + bootstrap admin → 200 + audits + RFC §5.1 JSON", async () => {
    seedOrg();
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: {
          idp_user_id: "gh-new-1",
          email: "newbie@example.com",
          name: "Newbie",
        },
        accessToken: "idp-tok-new",
      }),
      listMemberships: async () => ["acme"],
    });
    const req = mockRequest(
      {
        grant_type: "authorization_code",
        code: "c",
        redirect_uri: "http://localhost/cb",
        code_verifier: "verifier-xyz",
      },
      { ip: "10.0.0.1", userAgent: "ua/1" },
    );
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(typeof body.refresh_token).toBe("string");
    expect(body.refresh_token.split(".")).toHaveLength(3);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);

    // Audits.
    const createdAudits = findAuditRows("auth.user.created");
    expect(createdAudits).toHaveLength(1);
    const createdMeta = JSON.parse(createdAudits[0].metadata_json as string);
    expect(createdMeta.bootstrap_admin).toBe(true);

    expect(findAuditRows("auth.admin.bootstrapped")).toHaveLength(1);

    const loginAudits = findAuditRows("auth.login.success");
    expect(loginAudits).toHaveLength(1);
    const loginMeta = JSON.parse(loginAudits[0].metadata_json as string);
    expect(loginMeta.grant_type).toBe("authorization_code");
    expect(loginMeta.org_id).toBe("org-acme");
  });

  it("authorization_code: missing user-agent header → fingerprint computed without UA (?? null branch)", async () => {
    seedOrg();
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: { idp_user_id: "gh-noua", email: "noua@example.com" },
        accessToken: "tok",
      }),
    });
    // Build a request stream WITHOUT a user-agent header.
    const encoded = new URLSearchParams({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    }).toString();
    const stream = Readable.from([Buffer.from(encoded, "utf8")]);
    (stream as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "10.0.0.1",
    };
    (stream as unknown as { headers: Record<string, string> }).headers = {};

    const res = mockResponse();
    await handleOAuthToken(
      stream as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );
    expect(res.statusCode).toBe(200);
    // Fingerprint was computed from ip alone.
    const row = getDb()
      .prepare("SELECT consumer_fingerprint FROM refresh_tokens LIMIT 1")
      .get() as { consumer_fingerprint: string };
    expect(row.consumer_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("happy path: existing user → no auth.user.created audit", async () => {
    seedOrg();
    seedUser({ role: "admin" });
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: {
          idp_user_id: "gh-100", // matches seedUser's idp_user_id
          email: "alice@example.com",
        },
        accessToken: "idp-tok-existing",
      }),
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );

    expect(res.statusCode).toBe(200);
    expect(findAuditRows("auth.user.created")).toHaveLength(0);
    expect(findAuditRows("auth.admin.bootstrapped")).toHaveLength(0);
    expect(findAuditRows("auth.login.success")).toHaveLength(1);
  });
});

// ===========================================================================
// authorization_code allowlist (2 cases)
// ===========================================================================
describe("handleOAuthToken — authorization_code allowlist", () => {
  it("user not in any allowlisted org → 403 access_denied + Tier 1 audit with idp_user_id_hash", async () => {
    seedOrg("org-acme", "acme");
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: { idp_user_id: "gh-evil", email: "evil@example.com" },
        accessToken: "tok",
      }),
      listMemberships: async () => ["unrelated-org"],
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!).error).toBe("access_denied");

    const audits = findAuditRows("auth.login.denied.not_in_org");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.idp_user_id_hash).toBe(hashIdpUserId("gh-evil"));
    expect(meta.phase).toBe("auth_code_grant");
  });

  it("IdPTokenRevoked from membership check → 401 invalid_grant + Tier 1 audit (phase=auth_code_membership)", async () => {
    seedOrg();
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: { idp_user_id: "gh-200", email: "u@example.com" },
        accessToken: "tok",
      }),
      listMemberships: async () => {
        throw new IdPTokenRevoked();
      },
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    const audits = findAuditRows("auth.idp.token_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.phase).toBe("auth_code_membership");
  });

  it("IdPTransientError from membership check → 503 temporarily_unavailable", async () => {
    seedOrg();
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: { idp_user_id: "gh-201", email: "u@example.com" },
        accessToken: "tok",
      }),
      listMemberships: async () => {
        throw new IdPTransientError();
      },
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!).error).toBe("temporarily_unavailable");
  });

  it("unknown error from membership check → re-thrown", async () => {
    seedOrg();
    const provider = makeProvider({
      exchangeCode: async () => ({
        user: { idp_user_id: "gh-202", email: "u@example.com" },
        accessToken: "tok",
      }),
      listMemberships: async () => {
        throw new Error("network unrest");
      },
    });
    const req = mockRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "http://localhost/cb",
    });
    const res = mockResponse();
    await expect(
      handleOAuthToken(
        req,
        res as unknown as ServerResponse,
        makeCtx({ githubProvider: provider }),
      ),
    ).rejects.toThrow(/network unrest/);
  });
});

// ===========================================================================
// device_code grant (RFC 8628 §3.5)
// ===========================================================================
describe("handleOAuthToken — grant_type=device_code", () => {
  const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

  it("missing device_code → 400 invalid_request", async () => {
    const req = mockRequest({ grant_type: GRANT });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/device_code/i);
  });

  it("unknown device_code → 400 invalid_grant", async () => {
    const req = mockRequest({ grant_type: GRANT, device_code: "unknown-dc" });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/unknown/i);
  });

  it("polling too fast (within interval) → 400 slow_down", async () => {
    // last_polled_at = now − 1s with interval=5 → CAS rejects update.
    seedDeviceRow({
      deviceCode: "dc-fast",
      lastPolledAt: clock.now() - 1,
      interval: 5,
    });
    const req = mockRequest({ grant_type: GRANT, device_code: "dc-fast" });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("slow_down");
    expect(body.error_description).toMatch(/5s/);
  });

  it("authorization_pending: row exists, no approval, not expired, not denied", async () => {
    seedDeviceRow({ deviceCode: "dc-pending" });
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-pending",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("authorization_pending");
    // last_polled_at should be set to now after the CAS update.
    const row = getDb()
      .prepare("SELECT last_polled_at FROM device_auth_requests WHERE device_code = ?")
      .get("dc-pending") as { last_polled_at: number };
    expect(row.last_polled_at).toBe(clock.now());
  });

  it("expired_token: expires_at ≤ now → 400 expired_token", async () => {
    seedDeviceRow({
      deviceCode: "dc-expired",
      expiresAt: clock.now() - 1,
    });
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-expired",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("expired_token");
  });

  it("access_denied: denied_at set → 400 access_denied", async () => {
    seedDeviceRow({
      deviceCode: "dc-denied",
      deniedAt: clock.now() - 5,
    });
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-denied",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("access_denied");
  });

  it("approved but user row missing → 400 invalid_grant", async () => {
    // FK on device_auth_requests.approved_user_id references users(id).
    // To simulate the orphan we briefly disable FKs around the DELETE so
    // the device row survives. Re-enable to keep later assertions sound.
    seedOrg();
    seedUser({ id: "u-ghost" });
    seedDeviceRow({
      deviceCode: "dc-approved-orphan",
      approvedUserId: "u-ghost",
    });
    getDb().exec("PRAGMA foreign_keys = OFF");
    try {
      getDb().exec("DELETE FROM user_orgs");
      getDb().prepare("DELETE FROM users WHERE id = ?").run("u-ghost");
    } finally {
      getDb().exec("PRAGMA foreign_keys = ON");
    }
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-approved-orphan",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/approved user/i);
  });

  it("approved → 200 + JSON tokens + row DELETEd + Tier 2 audit with grant_type=device_code", async () => {
    seedOrg();
    seedUser({ id: "u-alice" });
    seedDeviceRow({
      deviceCode: "dc-go",
      approvedUserId: "u-alice",
    });
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-go",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(typeof body.refresh_token).toBe("string");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);

    // Row was deleted — further polls would 404.
    const stillThere = getDb()
      .prepare("SELECT 1 FROM device_auth_requests WHERE device_code = ?")
      .get("dc-go");
    expect(stillThere).toBeUndefined();

    // Audit.
    const audits = findAuditRows("auth.login.success");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.grant_type).toBe("device_code");
    expect(meta.user_id).toBe("u-alice");
    expect(typeof meta.family_id).toBe("string");

    // A refresh_tokens row was inserted for the new family.
    const refreshRows = getDb()
      .prepare("SELECT user_id FROM refresh_tokens")
      .all() as Array<{ user_id: string }>;
    expect(refreshRows).toHaveLength(1);
    expect(refreshRows[0].user_id).toBe("u-alice");
  });

  it("approved + publicUrl with trailing slash → issuer stripped (mint succeeds, JWT iss without slash)", async () => {
    seedOrg();
    seedUser({ id: "u-alice" });
    seedDeviceRow({
      deviceCode: "dc-slash",
      approvedUserId: "u-alice",
    });
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-slash",
    });
    const res = mockResponse();
    await handleOAuthToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ publicUrl: `${ISSUER}/` }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("first poll: last_polled_at NULL → CAS succeeds (authorization_pending)", async () => {
    seedDeviceRow({
      deviceCode: "dc-firstpoll",
      lastPolledAt: null,
      interval: 5,
    });
    const req = mockRequest({
      grant_type: GRANT,
      device_code: "dc-firstpoll",
    });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("authorization_pending");
  });
});

// ===========================================================================
// refresh_token grant — delegation sanity check (full coverage in T19 suite)
// ===========================================================================
describe("handleOAuthToken — grant_type=refresh_token", () => {
  it("valid refresh JWT → delegates to refreshTokenGrant and returns 200", async () => {
    seedOrg();
    seedUser({ id: "u-alice" });
    seedRefreshRow({ jti: "jti-refresh-1" });
    const refresh = await mintRefresh({ jti: "jti-refresh-1" });

    const req = mockRequest(
      { grant_type: "refresh_token", refresh_token: refresh },
      { ip: "10.0.0.1", userAgent: "ua/1" },
    );
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect(body.token_type).toBe("Bearer");

    // Predecessor was rotated.
    const old = getDb()
      .prepare("SELECT revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-refresh-1") as { revoked_reason: string };
    expect(old.revoked_reason).toBe("rotated");
  });

  it("missing refresh_token in body → delegate emits 400 invalid_request", async () => {
    const req = mockRequest({ grant_type: "refresh_token" });
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_request");
  });
});
