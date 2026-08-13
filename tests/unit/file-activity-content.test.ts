import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb } from "../../src/database.js";
import http from "http";

let handle: ServerHandle, dataDir: string, port: number;

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

describe("/api/file-activity content+symbols", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "fa-content-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    port = handle.port;
    // Give tree-sitter time to load grammars
    await new Promise((r) => setTimeout(r, 1500));
  });
  afterAll(async () => {
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("posts file content and stores symbols_touched JSON", async () => {
    const r = await postJson(port, "/api/file-activity", {
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "src/foo.ts",
      content: "export function fooBar() { return 1; }",
    });
    expect(r.status).toBe(200);
    const row = getDb()
      .prepare("SELECT symbols_touched FROM file_activity WHERE agent_id=?")
      .get("a1") as any;
    expect(row).toBeDefined();
    if (row.symbols_touched) {
      expect(JSON.parse(row.symbols_touched)).toContain("fooBar");
    }
  });

  it("rejects content > 256 KB with 400", async () => {
    const huge = "x".repeat(300_000);
    const r = await postJson(port, "/api/file-activity", {
      session_id: "s2",
      agent_id: "a2",
      tool_name: "Edit",
      file_path: "src/big.ts",
      content: huge,
    });
    expect(r.status).toBe(400);
  });
});
