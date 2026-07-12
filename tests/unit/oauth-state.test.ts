import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fc from "fast-check";
import type { Clock } from "../../src/auth/clock.js";
import {
  createOAuthState,
  createOAuthStateWithVerifier,
  consumeOAuthState,
  inspectOAuthState,
  type OAuthStateRow,
} from "../../src/auth/oauth-state.js";

// FakeClock matches T04's expected seam — tests control time deterministically.
class FakeClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(s: number): void {
    this.current += s;
  }
}

let db: Database.Database;
let clock: FakeClock;

beforeEach(() => {
  db = new Database(":memory:");
  // Mirror T01a's schema in src/database.ts exactly.
  db.exec(`
    CREATE TABLE oauth_state (
      state           TEXT PRIMARY KEY,
      code_verifier   TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      provider        TEXT NOT NULL,
      org_id          TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      consumed_at     INTEGER,
      nonce           TEXT
    );
    CREATE INDEX idx_oauth_state_expires ON oauth_state(expires_at);
  `);
  clock = new FakeClock();
});

afterEach(() => {
  db.close();
});

describe("createOAuthState", () => {
  it("writes a row with 256-bit base64url state + code_verifier (43 chars each)", () => {
    const { state, code_verifier } = createOAuthState(db, clock, "github", "https://app/cb");
    expect(state).toHaveLength(43);
    expect(code_verifier).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as OAuthStateRow;
    expect(row.code_verifier).toBe(code_verifier);
    expect(row.redirect_uri).toBe("https://app/cb");
    expect(row.consumed_at).toBeNull();
  });

  it("sets created_at + 600 === expires_at (10-minute TTL)", () => {
    clock.current = 5_000_000;
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as OAuthStateRow;
    expect(row.created_at).toBe(5_000_000);
    expect(row.expires_at).toBe(5_000_600);
    expect(row.expires_at - row.created_at).toBe(600);
  });

  it("populates provider column correctly", () => {
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as OAuthStateRow;
    expect(row.provider).toBe("github");
  });
});

describe("createOAuthStateWithVerifier", () => {
  it("persists the caller-supplied code_verifier verbatim (not auto-generated)", () => {
    const supplied = "my-precise-pkce-verifier-value-A1B2C3D4E5F6G7H8I9J0";
    const { state } = createOAuthStateWithVerifier(db, clock, "github", "https://app/cb", supplied);
    const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as OAuthStateRow;
    expect(row.code_verifier).toBe(supplied);
    expect(row.provider).toBe("github");
    expect(row.redirect_uri).toBe("https://app/cb");
  });

  it("still generates a 256-bit base64url state token (43 chars)", () => {
    const { state } = createOAuthStateWithVerifier(
      db,
      clock,
      "github",
      "https://app/cb",
      "anything",
    );
    expect(state).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as OAuthStateRow;
    expect(row.created_at).toBe(1_000_000);
    expect(row.expires_at).toBe(1_000_600);
    expect(row.consumed_at).toBeNull();
  });

  it("T55: stores the supplied nonce (OIDC) and consumeOAuthState returns it", () => {
    const nonceValue = "n-7b3f0a8e-deterministic";
    const { state } = createOAuthStateWithVerifier(
      db,
      clock,
      "oidc",
      "https://app/cb",
      "verifier-x",
      nonceValue,
    );
    const consumed = consumeOAuthState(db, clock, state);
    expect(consumed).toEqual({
      code_verifier: "verifier-x",
      redirect_uri: "https://app/cb",
      provider: "oidc",
      nonce: nonceValue,
    });
  });

  it("T55: nonce is nullable when caller omits it", () => {
    const { state } = createOAuthStateWithVerifier(
      db,
      clock,
      "github",
      "https://app/cb",
      "verifier-x",
      // nonce intentionally omitted
    );
    const consumed = consumeOAuthState(db, clock, state);
    expect(consumed?.nonce).toBeNull();
  });
});

describe("consumeOAuthState", () => {
  it("happy path returns verifier+redirect+provider and marks row consumed", () => {
    const { state, code_verifier } = createOAuthState(db, clock, "github", "https://app/cb");
    clock.advance(5);
    const consumed = consumeOAuthState(db, clock, state);
    expect(consumed).toEqual({
      code_verifier,
      redirect_uri: "https://app/cb",
      provider: "github",
      // T55: createOAuthState (no-nonce overload) leaves nonce NULL.
      nonce: null,
    });
    const row = db.prepare("SELECT consumed_at FROM oauth_state WHERE state = ?").get(state) as {
      consumed_at: number;
    };
    expect(row.consumed_at).toBe(1_000_005);
  });

  it("second call on same state returns null (one-time use via consumed_at IS NULL)", () => {
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    expect(consumeOAuthState(db, clock, state)).not.toBeNull();
    expect(consumeOAuthState(db, clock, state)).toBeNull();
  });

  it("returns null after TTL expires (advance clock past expires_at)", () => {
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    clock.advance(601); // 1s past 600s TTL
    expect(consumeOAuthState(db, clock, state)).toBeNull();
    // Row should remain un-consumed (CAS failed on expires_at guard, not consumed_at).
    const row = db.prepare("SELECT consumed_at FROM oauth_state WHERE state = ?").get(state) as {
      consumed_at: number | null;
    };
    expect(row.consumed_at).toBeNull();
  });

  it("returns null for unknown state", () => {
    expect(consumeOAuthState(db, clock, "does-not-exist")).toBeNull();
  });
});

describe("inspectOAuthState", () => {
  it("returns { status: 'unknown', row: null } for missing state", () => {
    expect(inspectOAuthState(db, clock, "ghost")).toEqual({ status: "unknown", row: null });
  });

  it("returns { status: 'consumed', row } after a successful consume", () => {
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    consumeOAuthState(db, clock, state);
    const result = inspectOAuthState(db, clock, state);
    expect(result.status).toBe("consumed");
    expect(result.row).not.toBeNull();
    expect(result.row?.consumed_at).not.toBeNull();
  });

  it("returns { status: 'expired', row } for an un-consumed row past expires_at", () => {
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    clock.advance(601);
    // Don't bother consuming — just inspect a known-stale row.
    const result = inspectOAuthState(db, clock, state);
    expect(result.status).toBe("expired");
    expect(result.row).not.toBeNull();
    expect(result.row?.consumed_at).toBeNull();
  });

  it("throws when called on a live un-consumed un-expired row (precondition violation)", () => {
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    // Do NOT consume, do NOT advance clock — row is live.
    expect(() => inspectOAuthState(db, clock, state)).toThrow(
      "inspectOAuthState: row is live (un-consumed, un-expired); use consumeOAuthState first",
    );
  });
});

describe("consumeOAuthState atomicity (property)", () => {
  it("property: across N sequential consume calls on same state, exactly one wins", () => {
    // better-sqlite3 is sync — there's no real concurrency to test. The
    // atomic CAS guarantee lives in the UPDATE...WHERE consumed_at IS NULL
    // clause itself. This test proves the WHERE-clause guard works:
    // regardless of how many times we call consume, at most one returns
    // a row.
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (n) => {
        // Fresh row per property run.
        db.exec("DELETE FROM oauth_state");
        clock.current = 1_000_000; // reset to base; defensive against future clock.advance() in this property
        const { state } = createOAuthState(db, clock, "github", "https://app/cb");
        let wins = 0;
        for (let i = 0; i < n; i++) {
          if (consumeOAuthState(db, clock, state) !== null) wins++;
        }
        return wins === 1;
      }),
      { numRuns: 50 },
    );
  });
});
