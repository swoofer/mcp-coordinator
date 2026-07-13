import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { DatabaseAdapter } from "../../src/db-adapter.js";
import { makeTestEncryption, withEncryptionEnv, selectIdpToken } from "../helpers/encryption.js";

describe("makeTestEncryption", () => {
  it("returns a provider that round-trips with a valid context", () => {
    const { provider } = makeTestEncryption();
    const ctx = {
      org_id: "org-1",
      column: "idp_access_token" as const,
      user_id: "user-1",
    };
    const ct = provider.encrypt("hello", ctx);
    expect(provider.decrypt(ct, ctx)).toBe("hello");
  });

  it("returns a 32-byte key and a 16-hex-char fingerprint", () => {
    const { key, fingerprint } = makeTestEncryption();
    expect(key.length).toBe(32);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns DIFFERENT providers (and keys/fingerprints) across calls", () => {
    const a = makeTestEncryption();
    const b = makeTestEncryption();
    expect(a.key.equals(b.key)).toBe(false);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.provider).not.toBe(b.provider);
  });
});

describe("withEncryptionEnv", () => {
  const ORIGINAL = process.env.COORDINATOR_ENCRYPTION_KEY;

  afterEach(() => {
    // Defensive restore in case a test path missed cleanup.
    if (ORIGINAL === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
    else process.env.COORDINATOR_ENCRYPTION_KEY = ORIGINAL;
  });

  it("sets COORDINATOR_ENCRYPTION_KEY for the duration of fn and restores the original on return", () => {
    process.env.COORDINATOR_ENCRYPTION_KEY = "sentinel-original";
    const { key } = makeTestEncryption();
    const expected = key.toString("base64");
    let observed: string | undefined;
    const ret = withEncryptionEnv(key, () => {
      observed = process.env.COORDINATOR_ENCRYPTION_KEY;
      return 42;
    });
    expect(ret).toBe(42);
    expect(observed).toBe(expected);
    expect(process.env.COORDINATOR_ENCRYPTION_KEY).toBe("sentinel-original");
  });

  it("restores to UNSET when the original was undefined", () => {
    delete process.env.COORDINATOR_ENCRYPTION_KEY;
    const { key } = makeTestEncryption();
    withEncryptionEnv(key, () => {
      expect(process.env.COORDINATOR_ENCRYPTION_KEY).toBe(key.toString("base64"));
    });
    expect(process.env.COORDINATOR_ENCRYPTION_KEY).toBeUndefined();
    expect("COORDINATOR_ENCRYPTION_KEY" in process.env).toBe(false);
  });

  it("restores the original even when fn throws (try/finally)", () => {
    process.env.COORDINATOR_ENCRYPTION_KEY = "sentinel-throws";
    const { key } = makeTestEncryption();
    expect(() =>
      withEncryptionEnv(key, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.env.COORDINATOR_ENCRYPTION_KEY).toBe("sentinel-throws");
  });
});

describe("selectIdpToken", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE users (
        id                TEXT PRIMARY KEY,
        primary_org_id    TEXT NOT NULL,
        idp_access_token  TEXT,
        idp_refresh_token TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("returns the plaintext for an encrypted access token", () => {
    const { provider } = makeTestEncryption();
    const userId = "user-1";
    const orgId = "org-1";
    const plaintext = "ghs_secret_access_token_value";
    const ct = provider.encrypt(plaintext, {
      org_id: orgId,
      column: "idp_access_token",
      user_id: userId,
    });
    db.prepare(`INSERT INTO users (id, primary_org_id, idp_access_token) VALUES (?, ?, ?)`).run(
      userId,
      orgId,
      ct,
    );

    const got = selectIdpToken(
      db as unknown as DatabaseAdapter,
      userId,
      "idp_access_token",
      provider,
    );
    expect(got).toBe(plaintext);
  });

  it("returns null when the column is NULL", () => {
    const { provider } = makeTestEncryption();
    db.prepare(`INSERT INTO users (id, primary_org_id, idp_access_token) VALUES (?, ?, NULL)`).run(
      "user-null",
      "org-null",
    );

    const got = selectIdpToken(
      db as unknown as DatabaseAdapter,
      "user-null",
      "idp_access_token",
      provider,
    );
    expect(got).toBeNull();
  });

  it("returns null when the user row is missing", () => {
    const { provider } = makeTestEncryption();
    const got = selectIdpToken(
      db as unknown as DatabaseAdapter,
      "does-not-exist",
      "idp_refresh_token",
      provider,
    );
    expect(got).toBeNull();
  });
});
