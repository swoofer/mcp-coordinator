/**
 * Who decides whether an announced thread starts resolved.
 *
 * announceWork resolves a thread at insert when no live agent shares one of
 * its modules, and announces nothing. runCommonAnnounceFlow, which both the
 * MCP tool and the REST route run right after, is the one that sees
 * file-level links (Layer 0, file activity) and how many other agents are
 * online; its rule is "auto-resolve only when truly alone", keeping the
 * thread open otherwise so a later announce on the same files is matched.
 * It could resolve a thread but never reopen one, so a thread resolved at
 * insert stayed resolved even with a concerned peer, which was then never
 * consulted, and nothing announced the resolution.
 *
 * Agents that died without going offline used to share every module and
 * kept that insert-time path closed in production; ignoring them (presence
 * TTL) opened it, hence these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb } from "../../src/database.js";
import { createServices, type CoordinatorServices } from "../../src/server-setup.js";
import { runCommonAnnounceFlow } from "../../src/announce-workflow.js";
import type { CoordinatorEvent } from "../../src/types.js";

let dataDir: string;
let services: CoordinatorServices;
let resolutions: string[];

// SseEmitter fans out to listeners via setImmediate: let that tick run.
const flushFanOut = () => new Promise<void>((resolve) => setImmediate(resolve));

function announce(agentId: string, modules: string[], files: string[], keepOpen = false) {
  const params = {
    agent_id: agentId,
    subject: `${agentId} works`,
    target_modules: modules,
    target_files: files,
    keep_open: keepOpen,
  };
  const thread = services.consultation.announceWork("default", params);
  return runCommonAnnounceFlow(services, thread.id, { org_id: "default", ...params });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "announce-final-status-"));
  services = createServices({ dataDir });
  resolutions = [];
  services.sseEmitter.addListener("default", (event: CoordinatorEvent) => {
    if (event.type === "thread_resolved") {
      resolutions.push(JSON.parse(event.payload).resolution_type);
    }
  });
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("announced thread, final status", () => {
  it("stays open while another agent is online, even with no shared module", () => {
    services.registry.register("default", "a1", "A", ["src/auth"]);
    services.registry.register("default", "a2", "B", ["src/api"]);

    const res = announce("a1", ["src/auth"], ["src/auth/session.ts"]);

    expect(res.updated.status).toBe("open");
  });

  it("stays open when a peer is concerned through a shared file", () => {
    services.registry.register("default", "a1", "A", ["src/auth"]);
    services.registry.register("default", "a2", "B", ["src/api"]);
    announce("a2", ["src/api"], ["src/auth/types.ts"], true);

    const res = announce("a1", ["src/auth"], ["src/auth/types.ts"]);

    expect(res.updated.status).toBe("open");
    expect(res.respondents).toEqual(["a2"]);
  });

  it("resolves, and says so, when the announcer is truly alone", async () => {
    services.registry.register("default", "a1", "A", ["src/auth"]);

    const res = announce("a1", ["src/auth"], ["src/auth/session.ts"]);
    await flushFanOut();

    expect(res.updated.status).toBe("resolved");
    expect(resolutions).toEqual(["auto_resolved"]);
  });
});
