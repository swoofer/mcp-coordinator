/**
 * Task 20: Cross-tenant isolation defense-in-depth test.
 *
 * Seeds two orgs (org-a, org-b) with overlapping data and exercises every
 * public REST endpoint through the REAL authenticateRequest + handleRest
 * middleware. Asserts that no row from org-a leaks into org-b's responses
 * and vice-versa.
 *
 * Service construction: createServices() is used synchronously with
 * COORDINATOR_MQTT_TCP_PORT=0 (mqtt-broker.ts: `if (tcpPort && tcpPort > 0)`
 * skips TCP bind when tcpPort is 0/falsy). No MQTT broker binds.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth, createToken, authenticateRequest } from "../../src/auth.js";
import { createServices, type CoordinatorServices } from "../../src/server-setup.js";
import { handleRest, type RestContext } from "../../src/http/handle-rest.js";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import fs from "fs";
import os from "os";
import path from "path";

const SECRET = "test-secret-at-least-32-characters-long!";

let services: CoordinatorServices;
let tokenA: string;
let tokenB: string;
let DIR: string;

beforeAll(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-test-"));
  // MQTT TCP port 0/falsy → broker skips TCP bind (see mqtt-broker.ts line:
  //   `if (tcpPort && tcpPort > 0) { tcpServer.listen(tcpPort, ...) }`)
  process.env.COORDINATOR_MQTT_TCP_PORT = "0";
  initDatabase(DIR);
  initAuth(SECRET);
  // createServices is synchronous; await is harmless on a non-Promise return.
  services = createServices({ dataDir: DIR });
  tokenA = await createToken("agent-a", "agent", undefined, { user_id: "user-a", org: "org-a" });
  tokenB = await createToken("agent-b", "agent", undefined, { user_id: "user-b", org: "org-b" });
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
  // Reset signingKey so subsequent test files get a clean auth state.
  initAuth(SECRET);
});

beforeEach(async () => {
  const db = getDb();
  // Truncate per-test so each case starts with a clean slate.
  // Order matters for FK constraints: children before parents.
  for (const t of [
    "introspections",
    "thread_messages",
    "threads",
    "action_summaries",
    "working_files",
    "file_activity",
    "agent_activity_status",
    "dependency_map",
    "events",
    "layer_firings",
    "audit_log",
    "agents",
  ]) {
    try {
      db.exec(`DELETE FROM ${t}`);
    } catch {
      /* table may not exist in this migration state */
    }
  }
  // Ensure both orgs exist (orgs table persists across beforeEach wipes).
  db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-a', 'Org A')").run();
  db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-b', 'Org B')").run();
  // Pre-register the canonical agents so FK constraints are satisfied for
  // file_activity, agent_activity_status, threads, and introspections.
  await postAs("/api/register", tokenA, {
    agent_id: "agent-a",
    name: "AgentA-default",
    modules: [],
  });
  await postAs("/api/register", tokenB, {
    agent_id: "agent-b",
    name: "AgentB-default",
    modules: [],
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

interface RequestOptions {
  url: string;
  body?: Record<string, unknown>;
  orgToken: string;
  method?: "GET" | "POST";
}

async function callAs({
  url,
  body,
  orgToken,
  method = "POST",
}: RequestOptions): Promise<{ status: number; data: unknown }> {
  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead(s: number) {
      statusCode = s;
    },
    end(buf?: string) {
      if (buf) chunks.push(buf);
    },
  } as unknown as ServerResponse;

  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.headers = {
    authorization: `Bearer ${orgToken}`,
    "content-type": "application/json",
  };
  req.method = method;
  req.url = url;

  if (method === "POST" && body !== undefined) {
    (req as unknown as { push: (chunk: unknown) => void }).push(JSON.stringify(body));
  }
  (req as unknown as { push: (chunk: unknown) => void }).push(null);

  // Exercise the REAL auth middleware — same path as production.
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    return { status: authResult.status, data: { error: authResult.error } };
  }

  const ctx: RestContext = {
    services,
    httpLog: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        child: () => ({}) as never,
      }),
    } as never,
    authEnabled: true,
    claims: authResult.claims,
  };

  try {
    await handleRest(req, res, ctx);
  } catch (err) {
    // Handlers that throw (e.g. propose/approve when thread not found) surface
    // as 500 in production via the outer HTTP server error handler. Replicate that
    // behaviour here so tests can assert `status !== 200`.
    statusCode = 500;
    chunks.push(JSON.stringify({ error: (err as Error).message || "internal error" }));
  }
  return {
    status: statusCode,
    data: chunks.length ? JSON.parse(chunks.join("")) : null,
  };
}

/** Convenience wrapper for POST. */
function postAs(url: string, orgToken: string, body: Record<string, unknown>) {
  return callAs({ url, body, orgToken, method: "POST" });
}

/** Convenience wrapper for GET (with optional query params baked into url). */
function getAs(url: string, orgToken: string) {
  return callAs({ url, orgToken, method: "GET" });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("cross-tenant isolation defense-in-depth", () => {
  // ── /api/register + /api/status ──────────────────────────────────────────
  it("/api/register + /api/status: org A cannot see org B's agents", async () => {
    await postAs("/api/register", tokenA, { agent_id: "agent-a", name: "AgentAlpha", modules: [] });
    await postAs("/api/register", tokenB, { agent_id: "agent-b", name: "AgentBeta", modules: [] });

    const statusA = await postAs("/api/status", tokenA, {});
    expect(statusA.status).toBe(200);
    // /api/status returns { online: N, open_threads: N, hot_files: N, mqtt: bool }.
    // online=1 means org-a sees exactly its own agents.
    expect((statusA.data as { online: number }).online).toBe(1);

    const statusB = await postAs("/api/status", tokenB, {});
    expect((statusB.data as { online: number }).online).toBe(1);
  });

  // ── /api/session-start ───────────────────────────────────────────────────
  it("/api/session-start: briefing scoped to org", async () => {
    await postAs("/api/register", tokenA, { agent_id: "agent-a", name: "AgentAlpha", modules: [] });
    await postAs("/api/register", tokenB, { agent_id: "agent-b", name: "AgentBeta", modules: [] });

    const briefingB = await postAs("/api/session-start", tokenB, {});
    expect(briefingB.status).toBe(200);
    expect(JSON.stringify(briefingB.data)).not.toContain("AgentAlpha");
    expect(JSON.stringify(briefingB.data)).toContain("AgentBeta");
  });

  // ── /api/log-file + /api/hot-files ───────────────────────────────────────
  it("/api/log-file + /api/hot-files: hot files don't bleed across orgs", async () => {
    // Log the same file from two different agents in org-a so hot-files has
    // something to return (getHotFiles requires agent_count > 1).
    // Also register a second org-a agent for this purpose.
    await postAs("/api/register", tokenA, { agent_id: "agent-a2", name: "AgentA2", modules: [] });
    await postAs("/api/log-file", tokenA, {
      session_id: "s-a1",
      agent_id: "agent-a",
      tool_name: "Edit",
      file: "x.ts",
    });
    await postAs("/api/log-file", tokenA, {
      session_id: "s-a2",
      agent_id: "agent-a2",
      tool_name: "Edit",
      file: "x.ts",
    });
    // org-b also edits the same file — must NOT appear in org-a's hot-files
    await postAs("/api/log-file", tokenB, {
      session_id: "s-b",
      agent_id: "agent-b",
      tool_name: "Edit",
      file: "x.ts",
    });

    const hotA = await postAs("/api/hot-files", tokenA, {});
    expect(hotA.status).toBe(200);
    // org-a's hot-files must not leak org-b agents
    expect(JSON.stringify(hotA.data)).not.toContain("agent-b");
    // org-a's own agents must be present in the hot-files result
    expect(JSON.stringify(hotA.data)).toContain("agent-a");
  });

  // ── /api/check-conflict ──────────────────────────────────────────────────
  it("/api/check-conflict: doesn't surface other-org agents", async () => {
    await postAs("/api/log-file", tokenA, {
      session_id: "s",
      agent_id: "agent-a",
      tool_name: "Edit",
      file: "shared.ts",
    });
    await postAs("/api/log-file", tokenB, {
      session_id: "s",
      agent_id: "agent-b",
      tool_name: "Edit",
      file: "shared.ts",
    });

    // org-a checks for conflict on shared.ts — should only see org-a agents
    const result = await postAs("/api/check-conflict", tokenA, {
      file: "shared.ts",
      agent_id: "agent-a-other",
    });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.data)).not.toContain("agent-b");
  });

  // ── /api/announce + /api/threads-active ──────────────────────────────────
  it("/api/announce + /api/threads-active: thread from org A invisible to org B", async () => {
    const announce = await postAs("/api/announce", tokenA, {
      agent_id: "agent-a",
      subject: "secret subject A",
      plan: "plan",
      target_modules: [],
      target_files: [],
    });
    expect(announce.status).toBe(200);
    const threadId = (announce.data as { thread_id: string }).thread_id;

    const listB = await postAs("/api/threads-active", tokenB, {});
    expect(listB.status).toBe(200);
    expect(JSON.stringify(listB.data)).not.toContain("secret subject A");
    expect(JSON.stringify(listB.data)).not.toContain(threadId);
  });

  // ── /api/post-to-thread ──────────────────────────────────────────────────
  it("/api/post-to-thread: cannot post to another org's thread", async () => {
    const announce = await postAs("/api/announce", tokenA, {
      agent_id: "agent-a",
      subject: "A's thread",
      plan: "p",
      target_modules: [],
      target_files: [],
    });
    const threadId = (announce.data as { thread_id: string }).thread_id;

    // org-b attempts to post to org-a's thread
    const result = await postAs("/api/post-to-thread", tokenB, {
      thread_id: threadId,
      agent_id: "agent-b",
      // valid type value from MessageType union
      type: "context",
      content: "i should not be able to post here",
    });
    // Handler looks up the thread scoped to org-b → 404 (thread_not_found)
    expect(result.status).toBe(404);
  });

  // ── /api/claim-task ──────────────────────────────────────────────────────
  it("/api/claim-task: cannot claim a thread from another org", async () => {
    // keep_open: true prevents auto-resolve so the thread stays 'open' for claiming.
    const announce = await postAs("/api/announce", tokenA, {
      agent_id: "agent-a",
      subject: "A's claimable thread",
      plan: "p",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const threadId = (announce.data as { thread_id: string }).thread_id;

    // org-b tries to claim org-a's thread by id
    const claim = await postAs("/api/claim-task", tokenB, {
      thread_id: threadId,
      agent_id: "agent-b",
    });
    // ISOLATION REQUIREMENT: claim must NOT succeed (success: true would be a leak)
    // The raw UPDATE in handle-rest.ts does NOT filter by org_id — this test
    // intentionally exposes that gap. Expected: success: false (no row changes
    // because the thread belongs to org-a and UPDATE hits it without org fence).
    // If this assertion fails → Task 20 has found a real cross-tenant leak.
    expect((claim.data as { success: boolean }).success).toBe(false);
  });

  // ── /api/working-files/start ─────────────────────────────────────────────
  it("/api/working-files/start: claims scoped to org (DB-level check)", async () => {
    await postAs("/api/working-files/start", tokenA, {
      agent_id: "agent-a",
      file_path: "shared.ts",
    });
    await postAs("/api/working-files/start", tokenB, {
      agent_id: "agent-b",
      file_path: "shared.ts",
    });

    const rowsA = getDb().prepare("SELECT * FROM working_files WHERE org_id = 'org-a'").all() as {
      agent_id: string;
    }[];
    const rowsB = getDb().prepare("SELECT * FROM working_files WHERE org_id = 'org-b'").all() as {
      agent_id: string;
    }[];

    expect(rowsA.map((r) => r.agent_id)).toContain("agent-a");
    expect(rowsA.map((r) => r.agent_id)).not.toContain("agent-b");
    expect(rowsB.map((r) => r.agent_id)).toContain("agent-b");
    expect(rowsB.map((r) => r.agent_id)).not.toContain("agent-a");
  });

  // ── /api/propose-resolution ──────────────────────────────────────────────
  it("/api/propose-resolution: cannot propose on another org's thread", async () => {
    const announce = await postAs("/api/announce", tokenA, {
      agent_id: "agent-a",
      subject: "A's thread (resolution test)",
      plan: "p",
      target_modules: [],
      target_files: [],
    });
    const threadId = (announce.data as { thread_id: string }).thread_id;

    // org-b tries to propose resolution on org-a's thread
    // Field is `summary` (not `resolution_summary`) per handle-rest.ts line 223
    const result = await postAs("/api/propose-resolution", tokenB, {
      thread_id: threadId,
      agent_id: "agent-b",
      summary: "evil-cross-org-resolution",
    });
    // consultation.proposeResolution scopes by org → org-b cannot see org-a's thread.
    // Expect a non-200 outcome (error or null response).
    expect(result.status).not.toBe(200);
  });

  // ── /api/approve-resolution ──────────────────────────────────────────────
  it("/api/approve-resolution: cannot approve another org's thread", async () => {
    const announce = await postAs("/api/announce", tokenA, {
      agent_id: "agent-a",
      subject: "A's thread (approve test)",
      plan: "p",
      target_modules: [],
      target_files: [],
    });
    const threadId = (announce.data as { thread_id: string }).thread_id;

    const result = await postAs("/api/approve-resolution", tokenB, {
      thread_id: threadId,
      agent_id: "agent-b",
    });
    expect(result.status).not.toBe(200);
  });

  // ── /api/agent-status/:id (GET path-param) ───────────────────────────────
  it("/api/agent-status/:id: cannot read another org's agent status", async () => {
    // Register alpha in org-a
    await postAs("/api/register", tokenA, { agent_id: "alpha", name: "Alpha", modules: [] });

    // org-b tries to read alpha's status via path param
    // Handler: const aid = url.split("/")[3]; const agent = registry.get(ctx.claims.org, aid);
    // registry.get scopes by org → returns null → { registered: false, status: "unknown" }
    const result = await getAs("/api/agent-status/alpha", tokenB);
    expect(result.status).toBe(200);
    // Must NOT report alpha as registered under org-b
    expect((result.data as { registered: boolean }).registered).toBe(false);
  });

  // ── /api/pending-introspections (GET with query param) ───────────────────
  it("/api/pending-introspections: doesn't return other-org introspections", async () => {
    // Announce threads first to satisfy introspections FK (thread_id REFERENCES threads(id)).
    const annA = await postAs("/api/announce", tokenA, {
      agent_id: "agent-a",
      subject: "thread for introspection A",
      plan: "p",
      target_modules: [],
      target_files: [],
    });
    const annB = await postAs("/api/announce", tokenB, {
      agent_id: "agent-b",
      subject: "thread for introspection B",
      plan: "p",
      target_modules: [],
      target_files: [],
    });
    const tidA = (annA.data as { thread_id: string }).thread_id;
    const tidB = (annB.data as { thread_id: string }).thread_id;
    // Insert introspections directly: public API only creates them via announce workflow
    getDb()
      .prepare(
        "INSERT INTO introspections (id, org_id, thread_id, agent_id, score, status) VALUES ('i1', 'org-a', ?, 'agent-a', 5, 'pending')",
      )
      .run(tidA);
    getDb()
      .prepare(
        "INSERT INTO introspections (id, org_id, thread_id, agent_id, score, status) VALUES ('i2', 'org-b', ?, 'agent-b', 5, 'pending')",
      )
      .run(tidB);

    // Handler reads agent_id from URL query string (not request body)
    const listA = await getAs("/api/pending-introspections?agent_id=agent-a", tokenA);
    expect(listA.status).toBe(200);
    expect(JSON.stringify(listA.data)).toContain("i1");
    expect(JSON.stringify(listA.data)).not.toContain("i2");
    expect(JSON.stringify(listA.data)).not.toContain("agent-b");
  });

  // ── Direct audit_log isolation (DB-level) ────────────────────────────────
  it("audit_log: writes from org A invisible in org B's reads (DB-level)", () => {
    const db = getDb();
    // v0.8: audit_log.org_id renamed to actor_org_id per V4 FIX 1
    db.prepare("INSERT INTO audit_log (actor_org_id, action) VALUES ('org-a', 'auth.test')").run();
    db.prepare("INSERT INTO audit_log (actor_org_id, action) VALUES ('org-b', 'auth.test')").run();

    const rowsForA = db.prepare("SELECT * FROM audit_log WHERE actor_org_id = 'org-a'").all();
    const rowsForB = db.prepare("SELECT * FROM audit_log WHERE actor_org_id = 'org-b'").all();
    expect(rowsForA).toHaveLength(1);
    expect(rowsForB).toHaveLength(1);
  });

  // ── /api/scoring-stats ────────────────────────────────────────────────────
  it("/api/scoring-stats: org A cannot see org B's layer firings or outcomes", async () => {
    const db = getDb();
    // Same thread_id reused across both orgs on purpose — proves the join
    // is scoped by org_id, not just accidentally non-colliding ids.
    db.prepare(
      "INSERT INTO layer_firings (org_id, thread_id, layer, score, agent_id) VALUES (?, ?, ?, ?, ?)",
    ).run("org-a", "t-shared", "L1", 100, "agent-a");
    db.prepare(
      "INSERT INTO layer_firings (org_id, thread_id, layer, score, agent_id) VALUES (?, ?, ?, ?, ?)",
    ).run("org-b", "t-shared", "L1", 50, "agent-b");
    db.prepare("INSERT INTO events (org_id, type, payload) VALUES (?, ?, ?)").run(
      "org-a",
      "thread_resolved",
      JSON.stringify({ thread_id: "t-shared", resolution_type: "auto_resolved" }),
    );
    db.prepare("INSERT INTO events (org_id, type, payload) VALUES (?, ?, ?)").run(
      "org-b",
      "thread_resolved",
      JSON.stringify({ thread_id: "t-shared", resolution_type: "consensus" }),
    );

    const statsA = (await getAs("/api/scoring-stats?since=24h", tokenA)) as {
      status: number;
      data: {
        layers: Array<{ layer: string; fire_count: number; outcomes: Record<string, number> }>;
      };
    };
    expect(statsA.status).toBe(200);
    const l1A = statsA.data.layers.find((l) => l.layer === "L1");
    expect(l1A).toBeDefined();
    // Org A sees ONLY its own firing (fire_count 1, not 2) and its own outcome.
    expect(l1A!.fire_count).toBe(1);
    expect(l1A!.outcomes.auto_resolved).toBe(1);
    expect(l1A!.outcomes.consensus).toBe(0);

    const statsB = (await getAs("/api/scoring-stats?since=24h", tokenB)) as {
      status: number;
      data: {
        layers: Array<{ layer: string; fire_count: number; outcomes: Record<string, number> }>;
      };
    };
    expect(statsB.status).toBe(200);
    const l1B = statsB.data.layers.find((l) => l.layer === "L1");
    expect(l1B).toBeDefined();
    expect(l1B!.fire_count).toBe(1);
    expect(l1B!.outcomes.consensus).toBe(1);
    expect(l1B!.outcomes.auto_resolved).toBe(0);
  });

  // ── Edge case: empty-string org claim returns no rows ────────────────────
  it("empty-string org claim returns no rows", async () => {
    // Seed some data in org-a and org-b
    await postAs("/api/register", tokenA, { agent_id: "agent-a", name: "A1", modules: [] });
    await postAs("/api/register", tokenB, { agent_id: "agent-b", name: "B1", modules: [] });

    // Craft a token with org="" — should not accidentally match any scoped rows
    const evilToken = await createToken("attacker", "agent", undefined, {
      user_id: "evil",
      org: "",
    });
    const result = await postAs("/api/status", evilToken, {});
    // No exception, no agents leaked
    const data = JSON.stringify(result.data);
    expect(data).not.toContain("A1");
    expect(data).not.toContain("B1");
  });
});
