import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb } from "../../src/database.js";
import http from "http";

/**
 * issue #275 — the DECLARED ↔ OBSERVED join.
 *
 * path-contract.test.ts covers ingestion: an observed path arrives and is
 * stored canonically. It never checks that a path an agent DECLARES finds it
 * again, which is the half that was broken: `normalizePath` had three call
 * sites, all observed, while `announce_work`, `/api/announce`,
 * `check_file_conflict` and `/api/check-conflict` passed raw strings to
 * queries that match those canonical columns by exact SQL equality.
 *
 * The repo root here is Windows-shaped on purpose. `normalizePath` lower-cases
 * whenever the path SHAPE is Windows (not the host platform), so this is the
 * measured failure from the issue and it reproduces on Linux CI too.
 */
let handle: ServerHandle, dataDir: string, port: number;
/** A literal backslash, built rather than escaped: this file passes through
 * tooling that mangles escape sequences, and a silently-collapsed \ turned the
 * root into a carriage return the first time round. */
const BACKSLASH = String.fromCharCode(92);

const WIN_ROOT = "C:/repo";

function postJson(
  p: number,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "localhost",
        port: p,
        path: urlPath,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: buf ? JSON.parse(buf) : {} }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** alice touches src/Types.ts, recorded through the observed path. */
async function aliceTouches(declaredForm: string): Promise<void> {
  const r = await postJson(port, "/api/file-activity", {
    session_id: "s-1",
    agent_id: "alice",
    tool_name: "Edit",
    file_path: declaredForm,
  });
  expect(r.status).toBe(200);
}

describe("declared ↔ observed path join (#275)", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "path-join-"));
    process.env.COORDINATOR_REPO_ROOT = WIN_ROOT;
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    port = handle.port;

    // threads.initiator_id is a real composite FK to agents(org_id, id) since
    // issue #231, so an announce from an unregistered agent is a 500, not a 400.
    for (const id of ["alice", "bob", "carol", "dave"]) {
      await postJson(port, "/api/register", { agent_id: id, name: id, modules: [] });
    }
  }, 60000);
  afterAll(async () => {
    delete process.env.COORDINATOR_REPO_ROOT;
    await handle?.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite handle a moment after close; the repo already
      // treats these teardown EBUSY flakes as noise (troubleshooting section 9).
    }
  }, 60000);

  it("stores the observed side lower-cased under a Windows-shaped root", async () => {
    await aliceTouches("C:/repo/src/Types.ts");
    const row = getDb()
      .prepare("SELECT file_path FROM file_activity WHERE agent_id = 'alice' LIMIT 1")
      .get() as { file_path: string };
    expect(row.file_path).toBe("src/types.ts");
  });

  // Every one of these is the SAME file as what alice touched. Before the fix
  // each returned "no conflict" — the strongest signal in the scoring, silent.
  const equivalentForms = [
    ["exact match", "src/types.ts"],
    ["different case", "src/Types.ts"],
    ["leading ./", "./src/types.ts"],
    ["backslashes", `src${BACKSLASH}Types.ts`],
    ["absolute, under the root", "C:/repo/src/Types.ts"],
    ["upper-case directory", "SRC/Types.ts"],
  ] as const;

  for (const [label, declared] of equivalentForms) {
    it(`check-conflict joins when bob declares it as ${label}`, async () => {
      const r = await postJson(port, "/api/check-conflict", { file: declared, agent_id: "bob" });
      expect(r.status).toBe(200);
      expect(r.body.conflict).toBe(true);
      expect(r.body.warnings.join(" ")).toContain("alice");
    });
  }

  it("does not invent a conflict on a genuinely different file", async () => {
    const r = await postJson(port, "/api/check-conflict", {
      file: "src/other.ts",
      agent_id: "bob",
    });
    expect(r.status).toBe(200);
    expect(r.body.conflict).toBe(false);
  });

  it("stores announced target_files in the canonical form", async () => {
    const r = await postJson(port, "/api/announce", {
      agent_id: "carol",
      subject: "touch types",
      target_modules: [],
      target_files: ["src/Types.ts", "./src/Other.ts"],
      depends_on_files: ["SRC/Dep.ts"],
    });
    expect(r.status).toBe(200);
    const row = getDb()
      .prepare("SELECT target_files, depends_on_files FROM threads WHERE initiator_id = 'carol'")
      .get() as { target_files: string; depends_on_files: string };
    expect(JSON.parse(row.target_files)).toEqual(["src/types.ts", "src/other.ts"]);
    expect(JSON.parse(row.depends_on_files)).toEqual(["src/dep.ts"]);
  });

  it("rejects a declared path outside the repo root instead of storing it", async () => {
    // The tool description claimed absolute paths were refused; it was a bare
    // z.array(z.string()) with no refine, so they were stored and re-broadcast.
    const r = await postJson(port, "/api/announce", {
      agent_id: "dave",
      subject: "escape",
      target_modules: [],
      target_files: ["D:/elsewhere/secret.ts"],
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/outside repoRoot|invalid path/i);
  });
});
