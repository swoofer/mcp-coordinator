import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb } from "../../src/database.js";
import http from "http";

let handle: ServerHandle, dataDir: string, port: number;
const FAKE_REPO_ROOT = "/abs/path";

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

describe("repo-relative path contract", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "path-contract-"));
    process.env.COORDINATOR_REPO_ROOT = FAKE_REPO_ROOT;
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    port = handle.port;
  });
  afterAll(async () => {
    delete process.env.COORDINATOR_REPO_ROOT;
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("strips REPO_ROOT prefix from absolute paths under root", async () => {
    const r = await postJson(port, "/api/working-files/start", {
      agent_id: "alice",
      file_path: `${FAKE_REPO_ROOT}/src/foo.ts`,
    });
    expect(r.status).toBe(200);
    const row = getDb()
      .prepare("SELECT file_path FROM working_files WHERE agent_id = ?")
      .get("alice") as any;
    expect(row.file_path).toBe("src/foo.ts");
  });

  it("rejects paths outside REPO_ROOT with 400", async () => {
    const r = await postJson(port, "/api/working-files/start", {
      agent_id: "bob",
      file_path: "/etc/passwd",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outside repoRoot|invalid file_path/i);
  });

  it("accepts already-relative paths as-is", async () => {
    const r = await postJson(port, "/api/working-files/start", {
      agent_id: "carol",
      file_path: "src/bar.ts",
    });
    expect(r.status).toBe(200);
    const row = getDb()
      .prepare("SELECT file_path FROM working_files WHERE agent_id = ?")
      .get("carol") as any;
    expect(row.file_path).toBe("src/bar.ts");
  });
});
