import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  probePublicUrl,
  probeDiscoveryDoc,
  probeGitHubCreds,
  probeGoogleCreds,
  probeSqlite,
  probeJwtSecretEntropy,
  probeAuditQueueDepth,
  probeSweeperStatus,
  probePhase2AuditEvents,
} from "../../cli/doctor.js";

/**
 * T42 doctor Phase 2 probe tests.
 *
 * Strategy: each probe takes its dependencies as explicit injectable
 * parameters (fetchImpl, db opener). Tests never touch real network or
 * real filesystem — fetch is stubbed via closures, sqlite uses
 * in-memory better-sqlite3.
 */

type FetchImpl = typeof fetch;

interface StubResponse {
  status?: number;
  ok?: boolean;
  body?: string;
}

function stubFetch(
  responder: (url: string, init?: RequestInit) => StubResponse | Promise<StubResponse>,
): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const r = await responder(url, init);
    const status = r.status ?? 200;
    return {
      status,
      ok: r.ok ?? (status >= 200 && status < 300),
      text: async () => r.body ?? "",
      json: async () => JSON.parse(r.body ?? "{}"),
    } as Response;
  }) as FetchImpl;
}

function throwingFetch(message = "ECONNREFUSED"): FetchImpl {
  return (async () => {
    throw new Error(message);
  }) as FetchImpl;
}

// ----------------------------------------------------------------------------
// probePublicUrl
// ----------------------------------------------------------------------------

describe("probePublicUrl", () => {
  it("returns ok when HEAD /healthz responds 200", async () => {
    const f = stubFetch((url) => {
      expect(url).toBe("http://localhost:3100/healthz");
      return { status: 200 };
    });
    const r = await probePublicUrl("http://localhost:3100", f);
    expect(r.severity).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("returns fail for malformed URL", async () => {
    const r = await probePublicUrl("not a url", throwingFetch());
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/malformed/i);
  });

  it("returns fail for non-http(s) scheme", async () => {
    const r = await probePublicUrl("ftp://example.com", throwingFetch());
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/scheme/i);
  });

  it("returns warn when HEAD fails", async () => {
    const r = await probePublicUrl("http://localhost:3100", throwingFetch("connect ECONNREFUSED"));
    expect(r.severity).toBe("warn");
  });

  it("returns warn on non-200 status", async () => {
    const f = stubFetch(() => ({ status: 503 }));
    const r = await probePublicUrl("http://localhost:3100", f);
    expect(r.severity).toBe("warn");
  });

  it("returns fail when publicUrl is missing", async () => {
    const r = await probePublicUrl(undefined, throwingFetch());
    expect(r.severity).toBe("fail");
  });
});

// ----------------------------------------------------------------------------
// probeDiscoveryDoc
// ----------------------------------------------------------------------------

describe("probeDiscoveryDoc", () => {
  const validDoc = {
    issuer: "http://localhost:3100",
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };

  it("returns ok on happy path", async () => {
    const f = stubFetch(() => ({ status: 200, body: JSON.stringify(validDoc) }));
    const r = await probeDiscoveryDoc("http://localhost:3100", f);
    expect(r.severity).toBe("ok");
  });

  it("normalizes trailing slash on publicUrl when comparing issuer", async () => {
    const f = stubFetch(() => ({ status: 200, body: JSON.stringify(validDoc) }));
    const r = await probeDiscoveryDoc("http://localhost:3100/", f);
    expect(r.severity).toBe("ok");
  });

  it("returns warn when issuer drifts from publicUrl", async () => {
    const doc = { ...validDoc, issuer: "https://other.example.com" };
    const f = stubFetch(() => ({ status: 200, body: JSON.stringify(doc) }));
    const r = await probeDiscoveryDoc("http://localhost:3100", f);
    expect(r.severity).toBe("warn");
    expect(r.detail).toMatch(/issuer/i);
  });

  it("returns fail when auth methods are not ['none']", async () => {
    const doc = { ...validDoc, token_endpoint_auth_methods_supported: ["client_secret_basic"] };
    const f = stubFetch(() => ({ status: 200, body: JSON.stringify(doc) }));
    const r = await probeDiscoveryDoc("http://localhost:3100", f);
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/auth_methods/i);
  });

  it("returns fail when PKCE methods include 'plain'", async () => {
    const doc = { ...validDoc, code_challenge_methods_supported: ["S256", "plain"] };
    const f = stubFetch(() => ({ status: 200, body: JSON.stringify(doc) }));
    const r = await probeDiscoveryDoc("http://localhost:3100", f);
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/code_challenge/i);
  });

  it("returns fail on non-2xx HTTP status", async () => {
    const f = stubFetch(() => ({ status: 404, ok: false, body: "not found" }));
    const r = await probeDiscoveryDoc("http://localhost:3100", f);
    expect(r.severity).toBe("fail");
  });

  it("returns fail on unreachable endpoint", async () => {
    const r = await probeDiscoveryDoc("http://localhost:3100", throwingFetch());
    expect(r.severity).toBe("fail");
  });

  it("returns fail on malformed JSON body", async () => {
    const f = stubFetch(() => ({ status: 200, body: "<html>not json</html>" }));
    const r = await probeDiscoveryDoc("http://localhost:3100", f);
    expect(r.severity).toBe("fail");
  });
});

// ----------------------------------------------------------------------------
// probeGitHubCreds
// ----------------------------------------------------------------------------

describe("probeGitHubCreds", () => {
  it("returns ok (not configured) when both creds missing — GitHub is optional", async () => {
    const r = await probeGitHubCreds(undefined, undefined, throwingFetch());
    expect(r.severity).toBe("ok");
    expect(r.detail).toMatch(/not configured/i);
  });

  it("returns warn on half-config (only one of the pair set)", async () => {
    const r = await probeGitHubCreds("id", undefined, throwingFetch());
    expect(r.severity).toBe("warn");
    expect(r.detail).toMatch(/half-configured/i);
  });

  it("returns ok when GitHub responds bad_verification_code", async () => {
    const f = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ error: "bad_verification_code" }),
    }));
    const r = await probeGitHubCreds("id", "secret", f);
    expect(r.severity).toBe("ok");
  });

  it("returns warn when GitHub responds incorrect_client_credentials", async () => {
    const f = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ error: "incorrect_client_credentials" }),
    }));
    const r = await probeGitHubCreds("id", "secret", f);
    expect(r.severity).toBe("warn");
  });

  it("skips smoke when smoke=false", async () => {
    const r = await probeGitHubCreds("id", "secret", throwingFetch(), false);
    expect(r.severity).toBe("ok");
  });
});

// ----------------------------------------------------------------------------
// probeGoogleCreds
// ----------------------------------------------------------------------------

describe("probeGoogleCreds", () => {
  it("returns ok (not configured) when both creds missing — Google is optional", async () => {
    const r = await probeGoogleCreds(undefined, undefined, throwingFetch());
    expect(r.severity).toBe("ok");
    expect(r.detail).toMatch(/not configured/i);
  });

  it("returns warn on half-config (only one of the pair set)", async () => {
    const r = await probeGoogleCreds(undefined, "secret", throwingFetch());
    expect(r.severity).toBe("warn");
    expect(r.detail).toMatch(/half-configured/i);
  });

  it("returns ok when Google responds invalid_grant (creds valid, code bad)", async () => {
    const f = stubFetch(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    }));
    const r = await probeGoogleCreds("id", "secret", f);
    expect(r.severity).toBe("ok");
  });

  it("returns warn when Google responds invalid_client", async () => {
    const f = stubFetch(() => ({
      status: 401,
      body: JSON.stringify({ error: "invalid_client" }),
    }));
    const r = await probeGoogleCreds("id", "secret", f);
    expect(r.severity).toBe("warn");
  });

  it("skips smoke when smoke=false", async () => {
    const r = await probeGoogleCreds("id", "secret", throwingFetch(), false);
    expect(r.severity).toBe("ok");
  });
});

// ----------------------------------------------------------------------------
// probeSqlite — uses in-memory better-sqlite3 (no file path needed).
// ----------------------------------------------------------------------------

function makeInMemoryDb(opts: {
  journalMode?: string;
  foreignKeys?: 0 | 1;
  busyTimeout?: number;
  userVersion?: number;
}): Database.Database {
  const db = new Database(":memory:");
  if (opts.journalMode) db.pragma(`journal_mode = ${opts.journalMode}`);
  if (opts.foreignKeys !== undefined) db.pragma(`foreign_keys = ${opts.foreignKeys}`);
  if (opts.busyTimeout !== undefined) db.pragma(`busy_timeout = ${opts.busyTimeout}`);
  if (opts.userVersion !== undefined) db.pragma(`user_version = ${opts.userVersion}`);
  return db;
}

describe("probeSqlite", () => {
  it("returns ok with WAL + fk + busy>=5000 + user_version>=8", async () => {
    // In-memory DBs cannot enter WAL mode; inject opener that fakes WAL.
    const db = makeInMemoryDb({ foreignKeys: 1, busyTimeout: 5000, userVersion: 8 });
    const opener = () => ({
      pragma: (q: string, o?: { simple?: boolean }) => {
        if (q === "journal_mode") return "wal";
        return db.pragma(q, o);
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    });
    const r = await probeSqlite("ignored", opener);
    expect(r.severity).toBe("ok");
  });

  it("returns fail with user_version=7", async () => {
    const db = makeInMemoryDb({ foreignKeys: 1, busyTimeout: 5000, userVersion: 7 });
    const opener = () => ({
      pragma: (q: string, o?: { simple?: boolean }) => {
        if (q === "journal_mode") return "wal";
        return db.pragma(q, o);
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    });
    const r = await probeSqlite("ignored", opener);
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/user_version=7/);
  });

  it("returns fail when journal_mode is not wal", async () => {
    const db = makeInMemoryDb({ foreignKeys: 1, busyTimeout: 5000, userVersion: 8 });
    const opener = () => ({
      pragma: (q: string, o?: { simple?: boolean }) => {
        if (q === "journal_mode") return "delete";
        return db.pragma(q, o);
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    });
    const r = await probeSqlite("ignored", opener);
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/journal_mode=delete/);
  });

  it("returns fail when opener throws", async () => {
    const opener = () => {
      throw new Error("ENOENT no such file");
    };
    const r = await probeSqlite("/nope", opener);
    expect(r.severity).toBe("fail");
  });
});

// ----------------------------------------------------------------------------
// probeJwtSecretEntropy
// ----------------------------------------------------------------------------

describe("probeJwtSecretEntropy", () => {
  it("returns fail on dictionary word 'changeme'", async () => {
    const r = await probeJwtSecretEntropy("changeme");
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/dictionary word/);
  });

  it("returns ok on 32 crypto-random bytes (base64)", async () => {
    const secret = randomBytes(32).toString("base64");
    const r = await probeJwtSecretEntropy(secret);
    expect(r.severity).toBe("ok");
  });

  it("returns fail when secret missing", async () => {
    const r = await probeJwtSecretEntropy(undefined);
    expect(r.severity).toBe("fail");
  });

  it("returns fail on all-same-byte secret", async () => {
    const r = await probeJwtSecretEntropy("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(r.severity).toBe("fail");
    expect(r.detail).toMatch(/identical|dictionary/);
  });
});

// ----------------------------------------------------------------------------
// probeAuditQueueDepth + probeSweeperStatus — share /health/ready endpoint
// ----------------------------------------------------------------------------

describe("probeAuditQueueDepth", () => {
  it("returns ok when depth < threshold", async () => {
    const body = JSON.stringify({
      checks: { audit_queue: { depth: 10, threshold_percent: 80 } },
    });
    const f = stubFetch(() => ({ status: 200, body }));
    const r = await probeAuditQueueDepth("http://localhost:3100", f);
    expect(r.severity).toBe("ok");
  });

  it("returns warn when depth >= threshold", async () => {
    const body = JSON.stringify({
      checks: { audit_queue: { depth: 85, threshold_percent: 80 } },
    });
    const f = stubFetch(() => ({ status: 200, body }));
    const r = await probeAuditQueueDepth("http://localhost:3100", f);
    expect(r.severity).toBe("warn");
  });

  it("returns fail when /health/ready unreachable", async () => {
    const r = await probeAuditQueueDepth("http://localhost:3100", throwingFetch());
    expect(r.severity).toBe("fail");
  });
});

describe("probeSweeperStatus", () => {
  it("returns ok when circuit closed and ok=true", async () => {
    const body = JSON.stringify({
      checks: { sweeper: { ok: true, circuit_open: false } },
    });
    const f = stubFetch(() => ({ status: 200, body }));
    const r = await probeSweeperStatus("http://localhost:3100", f);
    expect(r.severity).toBe("ok");
  });

  it("returns fail when circuit_open=true", async () => {
    const body = JSON.stringify({
      checks: { sweeper: { ok: false, circuit_open: true } },
    });
    const f = stubFetch(() => ({ status: 200, body }));
    const r = await probeSweeperStatus("http://localhost:3100", f);
    expect(r.severity).toBe("fail");
  });

  it("returns warn when /health/ready unreachable", async () => {
    const r = await probeSweeperStatus("http://localhost:3100", throwingFetch());
    expect(r.severity).toBe("warn");
  });
});

// ----------------------------------------------------------------------------
// probePhase2AuditEvents — uses in-memory sqlite with audit_log table.
// ----------------------------------------------------------------------------

function makeAuditDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT,
      org_id          TEXT,
      action          TEXT NOT NULL,
      target          TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe("probePhase2AuditEvents", () => {
  it("returns ok when an auth.login.success row exists within 24h", async () => {
    const db = makeAuditDb();
    db.prepare("INSERT INTO audit_log (action) VALUES (?)").run("auth.login.success");
    const opener = () => ({
      prepare: (sql: string) => db.prepare(sql) as never,
      close: () => db.close(),
    });
    const r = await probePhase2AuditEvents("ignored", opener);
    expect(r.severity).toBe("ok");
    expect(r.detail).toMatch(/1 Phase 2/);
  });

  it("returns warn on empty audit_log", async () => {
    const db = makeAuditDb();
    const opener = () => ({
      prepare: (sql: string) => db.prepare(sql) as never,
      close: () => db.close(),
    });
    const r = await probePhase2AuditEvents("ignored", opener);
    expect(r.severity).toBe("warn");
    expect(r.detail).toMatch(/no Phase 2/i);
  });

  it("returns warn when only Phase 1 events exist", async () => {
    const db = makeAuditDb();
    db.prepare("INSERT INTO audit_log (action) VALUES (?)").run("agent.register");
    db.prepare("INSERT INTO audit_log (action) VALUES (?)").run("thread.create");
    const opener = () => ({
      prepare: (sql: string) => db.prepare(sql) as never,
      close: () => db.close(),
    });
    const r = await probePhase2AuditEvents("ignored", opener);
    expect(r.severity).toBe("warn");
  });

  it("returns fail when opener throws", async () => {
    const opener = () => {
      throw new Error("EACCES");
    };
    const r = await probePhase2AuditEvents("/nope", opener);
    expect(r.severity).toBe("fail");
  });
});
