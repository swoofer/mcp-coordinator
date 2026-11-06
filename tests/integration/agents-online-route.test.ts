/**
 * POST /api/agents-online lists the agents currently online in the caller's
 * org, with their activity. The dashboard calls it each time its event
 * stream (re)connects: the stream only reports agents as they register or
 * change, so agents already online when the page opened were never shown
 * ("Aucun agent" next to a timeline full of their heartbeats).
 *
 * Each test boots the real HTTP server on its own temporary data dir: the
 * default (./data) is shared with other test files and outlives the run, so
 * events replayed from it would not be this test's.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

describe("POST /api/agents-online", () => {
  let handle: ServerHandle | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function boot() {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-agents-online-"));
    handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt", dataDir });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = (route: string, body: unknown) =>
      fetch(`${base}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    return { base, post };
  }

  it("returns the agents already online, with name, modules and activity", async () => {
    const { post } = await boot();

    const reg = await post("/api/register", {
      agent_id: "already-online",
      name: "Already Online",
      modules: ["mod-a", "mod-b"],
    });
    expect(reg.ok).toBe(true);

    const res = await post("/api/agents-online", {});
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(agents).toEqual([
      {
        agent_id: "already-online",
        name: "Already Online",
        modules: ["mod-a", "mod-b"],
        activity_status: "idle",
        current_file: null,
        current_thread: null,
      },
    ]);
  });

  it("returns an event id that splits events already in the list from later ones", async () => {
    const { base, post } = await boot();

    await post("/api/register", { agent_id: "before", name: "Before", modules: [] });
    const { last_event_id } = (await (await post("/api/agents-online", {})).json()) as {
      last_event_id: number;
    };
    await post("/api/register", { agent_id: "after", name: "After", modules: [] });

    // Both agent_online events are in the history the stream replays.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const onlineId = (agentId: string) =>
      text.match(
        new RegExp(`id: (\\d+)\\nevent: agent_online\\ndata: [^\\n]*"agent_id":"${agentId}"`),
      )?.[1];
    while (!onlineId("before") || !onlineId("after")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before both agent_online events:\n${text}`);
      text += value;
    }
    ac.abort();

    expect(Number(onlineId("before"))).toBeLessThanOrEqual(last_event_id);
    expect(Number(onlineId("after"))).toBeGreaterThan(last_event_id);
  });
});
