import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ServerResponse } from "node:http";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { jwtVerify } from "jose";
import {
  provisionUser,
  mintTokenPair,
  setSessionCookies,
  computeFingerprint,
} from "../../src/auth/oauth-finalize.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { FakeClock } from "../helpers/clock.js";
import type { IdpUserInfo } from "../../src/auth/providers/types.js";

/**
 * T16helpers — shared oauth-finalize helpers.
 *
 * Covers: provisionUser (find-or-create + bootstrap-admin), mintTokenPair
 * (access + refresh JWTs + refresh_tokens INSERT), setSessionCookies
 * (__Host-session + __Host-csrf), computeFingerprint (SHA-256 ip|ua).
 */

// Mock ServerResponse — only setHeader/getHeader are consumed by setCookies.
interface MockResponse {
  headers: Record<string, string | string[]>;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | string[] | undefined;
}

function mockResponse(): MockResponse {
  return {
    headers: {},
    setHeader(name: string, value: string | string[]) {
      this.headers[name] = value;
    },
    getHeader(name: string) {
      return this.headers[name];
    },
  };
}

function parseSetCookie(raw: string): { name: string; value: string; attrs: Record<string, string | boolean> } {
  const parts = raw.split(";").map((p) => p.trim());
  const [first, ...rest] = parts;
  const eq = first.indexOf("=");
  const name = first.slice(0, eq);
  const value = first.slice(eq + 1);
  const attrs: Record<string, string | boolean> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i === -1) attrs[p.toLowerCase()] = true;
    else attrs[p.slice(0, i).toLowerCase()] = p.slice(i + 1);
  }
  return { name, value, attrs };
}

const REGISTRY = buildJwtKeyRegistry(Buffer.alloc(32, 0x01));
const ISSUER = "http://localhost:3000";
const ALLOWLIST_ORG = { org_id: "org-1", org_name: "Test Org" };
const IDP_USER_ALICE: IdpUserInfo = {
  idp_user_id: "gh-100",
  email: "alice@example.com",
  name: "Alice",
};
const IDP_USER_BOB: IdpUserInfo = {
  idp_user_id: "gh-200",
  email: "bob@example.com",
  name: "Bob",
};

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE orgs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      id                TEXT PRIMARY KEY,
      primary_org_id    TEXT NOT NULL REFERENCES orgs(id),
      email             TEXT NOT NULL,
      name              TEXT,
      idp_provider      TEXT NOT NULL,
      idp_user_id       TEXT NOT NULL,
      idp_access_token  TEXT,
      idp_refresh_token TEXT,
      role              TEXT NOT NULL DEFAULT 'member',
      token_epoch       INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at     TEXT,
      UNIQUE(idp_provider, idp_user_id)
    );
    CREATE TABLE user_orgs (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id     TEXT NOT NULL REFERENCES orgs(id)  ON DELETE RESTRICT,
      role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','service')),
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE refresh_tokens (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES users(id),
      org_id               TEXT NOT NULL REFERENCES orgs(id),
      jti                  TEXT NOT NULL UNIQUE,
      family_id            TEXT,
      parent_jti           TEXT,
      consumer_fingerprint TEXT,
      expires_at           TEXT NOT NULL,
      last_used_at         TEXT,
      revoked_at           TEXT,
      revoked_reason       TEXT,
      replay_count         INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO orgs (id, name) VALUES ('org-1', 'Test Org');
  `);
}

let db: Database.Database;
let clock: FakeClock;

beforeEach(() => {
  db = new Database(":memory:");
  setupSchema(db);
  clock = new FakeClock(1_700_000_000);
});

afterEach(() => {
  db.close();
});

// ----------------------------------------------------------------------
// provisionUser
// ----------------------------------------------------------------------
describe("provisionUser", () => {
  it("new user with existing admin: returns isNew=true, bootstrapAdmin=false", () => {
    // Seed an existing admin so bootstrap check finds one.
    db.prepare(
      `INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id, role, last_login_at)
       VALUES ('admin-existing', 'org-1', 'admin@example.com', 'github', 'gh-0', 'admin', '1')`,
    ).run();
    db.prepare(
      `INSERT INTO user_orgs (user_id, org_id, role, joined_at)
       VALUES ('admin-existing', 'org-1', 'admin', '1')`,
    ).run();

    const result = provisionUser(db, clock, IDP_USER_ALICE, "tok-alice", ALLOWLIST_ORG, "github");
    expect(result.isNew).toBe(true);
    expect(result.bootstrapAdmin).toBe(false);
    expect(result.user.role).toBe("member");
    expect(result.user.primary_org_id).toBe("org-1");
    expect(result.user.user_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("new user with no admin: returns bootstrapAdmin=true (first user becomes admin)", () => {
    const result = provisionUser(db, clock, IDP_USER_ALICE, "tok-alice", ALLOWLIST_ORG, "github");
    expect(result.isNew).toBe(true);
    expect(result.bootstrapAdmin).toBe(true);
    expect(result.user.role).toBe("admin");
  });

  it("new user: INSERTs users row with idp_access_token + last_login_at populated", () => {
    const result = provisionUser(db, clock, IDP_USER_ALICE, "tok-alice-secret", ALLOWLIST_ORG, "github");
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(result.user.user_id) as {
      idp_access_token: string;
      last_login_at: string;
      idp_user_id: string;
      email: string;
      name: string;
      idp_provider: string;
    };
    expect(row.idp_access_token).toBe("tok-alice-secret");
    expect(row.last_login_at).toBe(String(clock.now()));
    expect(row.idp_user_id).toBe("gh-100");
    expect(row.email).toBe("alice@example.com");
    expect(row.name).toBe("Alice");
    expect(row.idp_provider).toBe("github");
  });

  it("new user (bootstrapped admin): user_orgs row gets FINAL role 'admin' (not 'member')", () => {
    const result = provisionUser(db, clock, IDP_USER_ALICE, "tok-alice", ALLOWLIST_ORG, "github");
    expect(result.bootstrapAdmin).toBe(true);
    const userOrg = db
      .prepare("SELECT role FROM user_orgs WHERE user_id = ? AND org_id = ?")
      .get(result.user.user_id, "org-1") as { role: string };
    expect(userOrg.role).toBe("admin");
    // Sanity: users.role is also admin.
    const userRow = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(result.user.user_id) as { role: string };
    expect(userRow.role).toBe("admin");
  });

  it("returning user: returns isNew=false and updates idp_access_token + last_login_at", () => {
    // First login.
    const first = provisionUser(db, clock, IDP_USER_ALICE, "tok-old", ALLOWLIST_ORG, "github");
    // Advance clock; second login should refresh fields.
    clock.advance(3600);
    const second = provisionUser(db, clock, IDP_USER_ALICE, "tok-new", ALLOWLIST_ORG, "github");
    expect(second.isNew).toBe(false);
    expect(second.bootstrapAdmin).toBe(false);
    expect(second.user.user_id).toBe(first.user.user_id);

    const row = db.prepare("SELECT idp_access_token, last_login_at FROM users WHERE id = ?").get(
      first.user.user_id,
    ) as { idp_access_token: string; last_login_at: string };
    expect(row.idp_access_token).toBe("tok-new");
    expect(row.last_login_at).toBe(String(clock.now()));
  });

  it("returning user: does NOT insert duplicate users row", () => {
    provisionUser(db, clock, IDP_USER_ALICE, "tok-1", ALLOWLIST_ORG, "github");
    provisionUser(db, clock, IDP_USER_ALICE, "tok-2", ALLOWLIST_ORG, "github");
    const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("returning user: does NOT insert duplicate user_orgs row", () => {
    provisionUser(db, clock, IDP_USER_ALICE, "tok-1", ALLOWLIST_ORG, "github");
    provisionUser(db, clock, IDP_USER_ALICE, "tok-2", ALLOWLIST_ORG, "github");
    const count = db.prepare("SELECT COUNT(*) as c FROM user_orgs").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("new user with missing IdP name: stores NULL in users.name (?? null branch)", () => {
    const noName: IdpUserInfo = { idp_user_id: "gh-300", email: "noname@example.com" };
    const result = provisionUser(db, clock, noName, "tok-noname", ALLOWLIST_ORG, "github");
    const row = db.prepare("SELECT name FROM users WHERE id = ?").get(result.user.user_id) as {
      name: string | null;
    };
    expect(row.name).toBeNull();
  });

  it("returning user: keeps existing role (re-login does not promote)", () => {
    // Seed an admin so Alice gets 'member' on first login.
    db.prepare(
      `INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id, role, last_login_at)
       VALUES ('admin-existing', 'org-1', 'admin@example.com', 'github', 'gh-0', 'admin', '1')`,
    ).run();
    db.prepare(
      `INSERT INTO user_orgs (user_id, org_id, role, joined_at)
       VALUES ('admin-existing', 'org-1', 'admin', '1')`,
    ).run();
    const first = provisionUser(db, clock, IDP_USER_BOB, "tok-bob", ALLOWLIST_ORG, "github");
    expect(first.user.role).toBe("member");

    // Now wipe admin and re-login Bob: he should still be 'member' (role frozen).
    db.prepare("DELETE FROM user_orgs WHERE user_id = 'admin-existing'").run();
    db.prepare("DELETE FROM users WHERE id = 'admin-existing'").run();
    const second = provisionUser(db, clock, IDP_USER_BOB, "tok-bob-2", ALLOWLIST_ORG, "github");
    expect(second.bootstrapAdmin).toBe(false);
    expect(second.user.role).toBe("member");
  });
});

// ----------------------------------------------------------------------
// mintTokenPair
// ----------------------------------------------------------------------
describe("mintTokenPair", () => {
  function seedUser(role: "admin" | "member" = "member"): {
    user_id: string;
    primary_org_id: string;
    role: "admin" | "member" | "service";
  } {
    const userId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id, role, last_login_at)
       VALUES (?, 'org-1', 'u@example.com', 'github', ?, ?, '1')`,
    ).run(userId, `gh-${userId.slice(0, 8)}`, role);
    return { user_id: userId, primary_org_id: "org-1", role };
  }

  it("returns accessJwt + refreshJwt + refreshJti + familyId + expiresAtRefresh", async () => {
    const user = seedUser("member");
    const pair = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: "fp-1",
    });
    expect(typeof pair.accessJwt).toBe("string");
    expect(pair.accessJwt.split(".")).toHaveLength(3);
    expect(typeof pair.refreshJwt).toBe("string");
    expect(pair.refreshJwt.split(".")).toHaveLength(3);
    expect(pair.refreshJti).toMatch(/^[0-9a-f-]{36}$/);
    expect(pair.familyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pair.expiresAtRefresh).toBe(clock.now() + 30 * 24 * 3600);
  });

  it("INSERTs refresh_tokens row with matching jti, family_id, parent_jti=NULL, fingerprint, expires_at", async () => {
    const user = seedUser("member");
    const pair = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: "fp-xyz",
    });
    const row = db.prepare("SELECT * FROM refresh_tokens WHERE jti = ?").get(pair.refreshJti) as {
      user_id: string;
      org_id: string;
      jti: string;
      family_id: string;
      parent_jti: string | null;
      consumer_fingerprint: string;
      expires_at: string;
      last_used_at: string;
    };
    expect(row).toBeDefined();
    expect(row.user_id).toBe(user.user_id);
    expect(row.org_id).toBe("org-1");
    expect(row.jti).toBe(pair.refreshJti);
    expect(row.family_id).toBe(pair.familyId);
    expect(row.parent_jti).toBeNull();
    expect(row.consumer_fingerprint).toBe("fp-xyz");
    expect(row.expires_at).toBe(String(pair.expiresAtRefresh));
    expect(row.last_used_at).toBe(String(clock.now()));
  });

  it("familyId auto-generated when not provided", async () => {
    const user = seedUser("member");
    const a = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: null,
    });
    const b = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: null,
    });
    expect(a.familyId).not.toBe(b.familyId);
  });

  it("familyId honored when provided (rotation successor)", async () => {
    const user = seedUser("member");
    const fixedFamily = crypto.randomUUID();
    const pair = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: null,
      familyId: fixedFamily,
    });
    expect(pair.familyId).toBe(fixedFamily);
    const row = db.prepare("SELECT family_id FROM refresh_tokens WHERE jti = ?").get(
      pair.refreshJti,
    ) as { family_id: string };
    expect(row.family_id).toBe(fixedFamily);
  });

  it("accessJwt claims include sub, active_org_id, family_id, role", async () => {
    const user = seedUser("admin");
    const pair = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: null,
    });
    const { payload } = await jwtVerify(pair.accessJwt, REGISTRY.current.key, {
      issuer: ISSUER,
    });
    expect(payload.sub).toBe(user.user_id);
    expect(payload.active_org_id).toBe("org-1");
    expect(payload.family_id).toBe(pair.familyId);
    expect(payload.role).toBe("admin");
  });

  it("refreshJwt claims include sub, active_org_id, family_id (no role)", async () => {
    const user = seedUser("member");
    const pair = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: null,
    });
    const { payload } = await jwtVerify(pair.refreshJwt, REGISTRY.current.key, {
      issuer: ISSUER,
    });
    expect(payload.sub).toBe(user.user_id);
    expect(payload.active_org_id).toBe("org-1");
    expect(payload.family_id).toBe(pair.familyId);
    expect(payload.role).toBeUndefined();
    expect(payload.jti).toBe(pair.refreshJti);
  });

  it("honors custom accessTTLSeconds + refreshTTLSeconds", async () => {
    const user = seedUser("member");
    const pair = await mintTokenPair(db, clock, {
      user,
      registry: REGISTRY,
      issuer: ISSUER,
      fingerprint: null,
      accessTTLSeconds: 60,
      refreshTTLSeconds: 120,
    });
    expect(pair.expiresAtRefresh).toBe(clock.now() + 120);
    const { payload } = await jwtVerify(pair.accessJwt, REGISTRY.current.key, {
      issuer: ISSUER,
    });
    // exp is iat + ttlSeconds; iat is jose-internal Math.floor(Date.now()/1000).
    // We only sanity-check exp - iat == 60.
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
  });
});

// ----------------------------------------------------------------------
// setSessionCookies
// ----------------------------------------------------------------------
describe("setSessionCookies", () => {
  it("sets session + csrf cookies with __Host- prefix", () => {
    const res = mockResponse();
    setSessionCookies(res as unknown as ServerResponse, {
      accessJwt: "ey.access.jwt",
      csrfToken: "csrf-123",
    });
    const cookies = res.headers["Set-Cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    const arr = cookies as string[];
    expect(arr[0].startsWith("__Host-coordinator_session=")).toBe(true);
    expect(arr[1].startsWith("__Host-coordinator_csrf=")).toBe(true);
  });

  it("session cookie is HttpOnly; csrf cookie is NOT HttpOnly", () => {
    const res = mockResponse();
    setSessionCookies(res as unknown as ServerResponse, {
      accessJwt: "ey.access",
      csrfToken: "csrf",
    });
    const arr = res.headers["Set-Cookie"] as string[];
    const session = parseSetCookie(arr[0]);
    const csrf = parseSetCookie(arr[1]);
    expect(session.attrs.httponly).toBe(true);
    expect(csrf.attrs.httponly).toBeUndefined();
  });

  it("both cookies SameSite=Strict, Secure, Path=/, no Domain; honors maxAgeSeconds override", () => {
    const res = mockResponse();
    setSessionCookies(res as unknown as ServerResponse, {
      accessJwt: "ey.a",
      csrfToken: "c",
      maxAgeSeconds: 1234,
    });
    const arr = res.headers["Set-Cookie"] as string[];
    for (const raw of arr) {
      const { attrs } = parseSetCookie(raw);
      expect(String(attrs.samesite).toLowerCase()).toBe("strict");
      expect(attrs.secure).toBe(true);
      expect(attrs.path).toBe("/");
      expect(attrs.domain).toBeUndefined();
      expect(attrs["max-age"]).toBe("1234");
    }
  });

  it("clearStateCookie=true adds a 3rd Set-Cookie with maxAge=0 clearing oauth_state", () => {
    const res = mockResponse();
    setSessionCookies(res as unknown as ServerResponse, {
      accessJwt: "ey.a",
      csrfToken: "c",
      clearStateCookie: true,
    });
    const arr = res.headers["Set-Cookie"] as string[];
    expect(arr).toHaveLength(3);
    const clearCookie = parseSetCookie(arr[2]);
    expect(clearCookie.name).toBe("__Host-coordinator_oauth_state");
    expect(clearCookie.value).toBe("");
    expect(clearCookie.attrs["max-age"]).toBe("0");
    expect(String(clearCookie.attrs.samesite).toLowerCase()).toBe("lax");
    expect(clearCookie.attrs.httponly).toBe(true);
  });
});

// ----------------------------------------------------------------------
// computeFingerprint
// ----------------------------------------------------------------------
describe("computeFingerprint", () => {
  it("returns null when both ip and ua are null", () => {
    expect(computeFingerprint(null, null)).toBeNull();
  });

  it("returns null when both ip and ua are empty strings", () => {
    expect(computeFingerprint("", "")).toBeNull();
  });

  it("returns 64-char hex hash when ip is set", () => {
    const fp = computeFingerprint("127.0.0.1", null);
    expect(fp).not.toBeNull();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 64-char hex hash when only ua is set", () => {
    const fp = computeFingerprint(null, "Mozilla/5.0");
    expect(fp).not.toBeNull();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes; identical inputs produce identical hashes", () => {
    const a = computeFingerprint("127.0.0.1", "UA-1");
    const b = computeFingerprint("127.0.0.2", "UA-1");
    const c = computeFingerprint("127.0.0.1", "UA-1");
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});
