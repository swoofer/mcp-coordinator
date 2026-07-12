import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { provisionUser } from "../../src/auth/oauth-finalize.js";
import { PassthroughEncryption } from "../../src/security/encryption.js";
import { FakeClock } from "../helpers/clock.js";
import { makeTestEncryption, selectIdpToken } from "../helpers/encryption.js";
import type { IdpUserInfo } from "../../src/auth/providers/types.js";
import type { DatabaseAdapter } from "../../src/db-adapter.js";

/**
 * T08 — provisionUser encrypts idp_access_token + idp_refresh_token at write.
 *
 * Exercises the new ProvisionUserArgs.encryption channel introduced in T08.
 * Asserts:
 *   - new user: both columns persist as enc:v1:… ciphertext; round-trip decrypt
 *     via selectIdpToken returns the original plaintext.
 *   - null refresh: SQL NULL, not the literal string "null".
 *   - empty-string refresh: SQL NULL (per encryptNullable normalization).
 *   - returning user (UPDATE path): both columns updated to enc:v1:… ciphertext.
 *   - PassthroughEncryption: plaintext stored as-is (backwards-compat).
 *
 * Fingerprint persistence is NOT asserted here — T06b owns that surface.
 */

const ALLOWLIST_ORG = { org_id: "org-1", org_name: "Test Org" };
const IDP_USER_ALICE: IdpUserInfo = {
  idp_user_id: "gh-100",
  email: "alice@example.com",
  name: "Alice",
};

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE orgs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL
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
      org_id     TEXT NOT NULL REFERENCES orgs(id),
      role       TEXT NOT NULL DEFAULT 'member',
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, org_id)
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

describe("provisionUser — encrypt at write (new user)", () => {
  it("stores idp_access_token + idp_refresh_token as enc:v1: ciphertext; decrypt round-trips", () => {
    const { provider } = makeTestEncryption();
    const result = provisionUser({
      db,
      clock,
      idpUser: IDP_USER_ALICE,
      accessToken: "plain-access-token",
      idpRefreshToken: "plain-refresh-token",
      allowlistOrg: ALLOWLIST_ORG,
      providerName: "github",
      encryption: provider,
    });

    // Raw stored values are ciphertext (NOT plaintext).
    const row = db
      .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = ?")
      .get(result.user.user_id) as {
      idp_access_token: string;
      idp_refresh_token: string;
    };
    expect(row.idp_access_token.startsWith("enc:v1:")).toBe(true);
    expect(row.idp_refresh_token.startsWith("enc:v1:")).toBe(true);
    expect(row.idp_access_token).not.toBe("plain-access-token");
    expect(row.idp_refresh_token).not.toBe("plain-refresh-token");

    // Round-trip decrypt via selectIdpToken helper.
    const access = selectIdpToken(
      db as unknown as DatabaseAdapter,
      result.user.user_id,
      "idp_access_token",
      provider,
    );
    expect(access).toBe("plain-access-token");

    const refresh = selectIdpToken(
      db as unknown as DatabaseAdapter,
      result.user.user_id,
      "idp_refresh_token",
      provider,
    );
    expect(refresh).toBe("plain-refresh-token");
  });

  it("null refresh token → SQL NULL (not encrypted 'null' string)", () => {
    const { provider } = makeTestEncryption();
    const result = provisionUser({
      db,
      clock,
      idpUser: IDP_USER_ALICE,
      accessToken: "tok-access",
      idpRefreshToken: null,
      allowlistOrg: ALLOWLIST_ORG,
      providerName: "github",
      encryption: provider,
    });
    const row = db
      .prepare("SELECT idp_refresh_token FROM users WHERE id = ?")
      .get(result.user.user_id) as { idp_refresh_token: string | null };
    expect(row.idp_refresh_token).toBeNull();
  });

  it("empty-string refresh token → SQL NULL (encryptNullable normalization)", () => {
    const { provider } = makeTestEncryption();
    const result = provisionUser({
      db,
      clock,
      idpUser: IDP_USER_ALICE,
      accessToken: "tok-access",
      idpRefreshToken: "",
      allowlistOrg: ALLOWLIST_ORG,
      providerName: "github",
      encryption: provider,
    });
    const row = db
      .prepare("SELECT idp_refresh_token FROM users WHERE id = ?")
      .get(result.user.user_id) as { idp_refresh_token: string | null };
    expect(row.idp_refresh_token).toBeNull();
  });
});

describe("provisionUser — encrypt at write (returning user UPDATE path)", () => {
  it("updates both tokens to enc:v1: ciphertext on second login", () => {
    const { provider } = makeTestEncryption();
    // First login (new user) — both tokens encrypted.
    const first = provisionUser({
      db,
      clock,
      idpUser: IDP_USER_ALICE,
      accessToken: "first-access",
      idpRefreshToken: "first-refresh",
      allowlistOrg: ALLOWLIST_ORG,
      providerName: "github",
      encryption: provider,
    });

    // Advance and re-login — UPDATE path.
    clock.advance(3600);
    const second = provisionUser({
      db,
      clock,
      idpUser: IDP_USER_ALICE,
      accessToken: "second-access",
      idpRefreshToken: "second-refresh",
      allowlistOrg: ALLOWLIST_ORG,
      providerName: "github",
      encryption: provider,
    });
    expect(second.isNew).toBe(false);
    expect(second.user.user_id).toBe(first.user.user_id);

    const row = db
      .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = ?")
      .get(first.user.user_id) as {
      idp_access_token: string;
      idp_refresh_token: string;
    };
    expect(row.idp_access_token.startsWith("enc:v1:")).toBe(true);
    expect(row.idp_refresh_token.startsWith("enc:v1:")).toBe(true);

    const access = selectIdpToken(
      db as unknown as DatabaseAdapter,
      first.user.user_id,
      "idp_access_token",
      provider,
    );
    expect(access).toBe("second-access");

    const refresh = selectIdpToken(
      db as unknown as DatabaseAdapter,
      first.user.user_id,
      "idp_refresh_token",
      provider,
    );
    expect(refresh).toBe("second-refresh");
  });
});

describe("provisionUser — passthrough (no key) backwards-compat", () => {
  it("stores both tokens as plaintext when encryption is PassthroughEncryption", () => {
    const result = provisionUser({
      db,
      clock,
      idpUser: IDP_USER_ALICE,
      accessToken: "plain-access",
      idpRefreshToken: "plain-refresh",
      allowlistOrg: ALLOWLIST_ORG,
      providerName: "github",
      encryption: new PassthroughEncryption(),
    });
    const row = db
      .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = ?")
      .get(result.user.user_id) as {
      idp_access_token: string;
      idp_refresh_token: string;
    };
    expect(row.idp_access_token).toBe("plain-access");
    expect(row.idp_refresh_token).toBe("plain-refresh");
    expect(row.idp_access_token.startsWith("enc:v1:")).toBe(false);
  });
});
