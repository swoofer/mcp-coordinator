import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const DIR = "data-test-sse-org";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  // v0.9 (issue #79): SseEmitter.emit() INSERTs into events; FK on events.org_id.
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
});
afterAll(() => { closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

describe("SseEmitter org_id filtering", () => {
  it("emits to listeners in matching org only", async () => {
    const emitter = new SseEmitter();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    emitter.addListener("org-a", (ev) => receivedA.push(ev.payload));
    emitter.addListener("org-b", (ev) => receivedB.push(ev.payload));

    emitter.emit("file_edited", { agent_id: "a1", file: "x.ts" }, { org_id: "org-a" });
    emitter.emit("file_edited", { agent_id: "b1", file: "y.ts" }, { org_id: "org-b" });

    // setImmediate fan-out — flush twice (two events × one setImmediate each).
    // A single tick can leave the second callback pending under load.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(receivedA).toHaveLength(1);
    expect(receivedA[0]).toContain("x.ts");
    expect(receivedA[0]).not.toContain("y.ts");

    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]).toContain("y.ts");
    expect(receivedB[0]).not.toContain("x.ts");
  });

  it("listenerCount and unsubscribe still work per-org", () => {
    const emitter = new SseEmitter();
    const unsub = emitter.addListener("org-a", () => {});
    expect(emitter.listenerCount()).toBe(1);
    unsub();
    expect(emitter.listenerCount()).toBe(0);
  });
});
