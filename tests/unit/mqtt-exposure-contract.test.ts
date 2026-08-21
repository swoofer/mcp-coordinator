import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAedesAuthorizePublishHook,
  createAedesAuthorizeSubscribeHook,
} from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";

/**
 * issue #330 — the MQTT surface is more exposed, and enabling auth buys less,
 * than the docs said. Three facts are now written down in
 * docs/mqtt-topics.md, docs/usage.md and docs/security/threat-model.md; these
 * tests hold the code to them, because a documented limitation that quietly
 * stops being true is worse than an undocumented one.
 *
 * This header used to end: "None of this is a fix. The per-identity ACL the
 * issue asks for needs an authenticated agent identity, and AuthClaims carries
 * none — that prerequisite is what actually blocks it."
 *
 * That was wrong, and writing it down made it durable — it is why the ACL kept
 * being filed as blocked. `AuthClaims` has no field NAMED `agent_id`, but a
 * Phase 1 agent token is minted with `.setSubject(agentId)` (src/auth.ts:99),
 * so the identity has been sitting in `sub` the whole time. The MQTT verifier
 * held the entire claims object and forwarded only `org` and `role`.
 *
 * The status-topic ACL below is therefore a fix. The other limitations in this
 * file are not, and are still stated as limitations.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type HookClient = { id?: string; org?: string; role?: string; agentId?: string };

/** Run the publish hook and report whether it allowed the topic. */
function publishAllowed(client: HookClient, topic: string): boolean {
  let allowed = false;
  createAedesAuthorizePublishHook(silentLogger)(
    client as never,
    { topic } as never,
    (err?: Error | null) => {
      allowed = !err;
    },
  );
  return allowed;
}

describe("the publish ACL is per-org, and per-identity on status topics (#330)", () => {
  const alice: HookClient = { id: "alice", org: "default", role: "agent", agentId: "alice" };

  it("refuses one agent publishing on another agent's status topic", () => {
    // INVERTED, not deleted. This asserted the documented limitation — "lets
    // one agent publish on another agent's status topic" — precisely so it
    // could not become false without someone noticing. Someone noticed: the
    // ACL now checks the agent id the token was minted with, and this is the
    // topic where the limitation actually cost something, because an `offline`
    // payload here runs the named agent's departure.
    expect(publishAllowed(alice, "coordinator/default/agents/bob/status")).toBe(false);
    expect(publishAllowed(alice, "coordinator/default/agents/alice/status")).toBe(true);
  });

  it("but the rest of the org's topics are still shared, by design", () => {
    // The limitation is real everywhere else and stays stated: consultation
    // and broadcast traffic fans out to the whole org on purpose.
    expect(publishAllowed(alice, "coordinator/default/broadcast")).toBe(true);
    expect(publishAllowed(alice, "coordinator/default/consultations/bob-thread")).toBe(true);
  });

  it("still blocks cross-org", () => {
    // The one boundary the hook does enforce.
    expect(publishAllowed(alice, "coordinator/other-org/agents/bob/status")).toBe(false);
    expect(publishAllowed(alice, "internal/anything")).toBe(false);
  });

  it("refuses a client with no org at all", () => {
    expect(publishAllowed({ id: "nobody" }, "coordinator/default/broadcast")).toBe(false);
  });

  it("the org wildcard the channel sidecar subscribes with is refused", () => {
    // cli/channel.ts subscribes to coordinator/+/agents/+/status. The
    // subscribe hook tests startsWith("coordinator/<org>/"), which a `+` does
    // not satisfy — so enabling auth breaks the channel process.
    //
    // Note the asymmetry, which is easy to get wrong: a subscribe refusal is
    // `cb(null, null)` — no error, a null granted subscription — while a
    // publish refusal is `cb(new Error(...))`. Checking only the error here
    // reports every refusal as an allow.
    const granted = (topic: string) => {
      let sub: unknown = "unset";
      createAedesAuthorizeSubscribeHook(silentLogger)(
        alice as never,
        { topic, qos: 0 } as never,
        (_err: Error | null, s?: unknown) => {
          sub = s;
        },
      );
      return sub;
    };
    expect(granted("coordinator/+/agents/+/status")).toBeNull();
    // The same subscription with the org spelled out is granted, which is what
    // makes this a wildcard problem rather than a topic problem.
    expect(granted("coordinator/default/agents/+/status")).not.toBeNull();
  });
});

describe("the two broker legs are exposed differently (#330)", () => {
  const BROKER = read("src/mqtt-broker.ts");

  it("the TCP leg is pinned to loopback and ignores COORDINATOR_BIND", () => {
    expect(BROKER).toContain('tcpServer.listen(tcpPort, "127.0.0.1"');
    expect(BROKER).not.toContain("COORDINATOR_BIND");
  });

  it("the WebSocket upgrade handler gates on the path and nothing else", () => {
    // It rides the HTTP server, so it follows COORDINATOR_BIND — no origin
    // check, no credential check. That asymmetry is the reason the LAN recipe
    // in docs/usage.md now carries a warning.
    const upgrade = BROKER.slice(BROKER.indexOf('httpServer.on("upgrade"'));
    const handler = upgrade.slice(0, upgrade.indexOf("logger.info"));
    expect(handler).toContain("wsPath");
    for (const gate of ["origin", "Origin", "authorization", "Authorization"]) {
      expect(handler, `upgrade handler now checks ${gate} — update the docs`).not.toContain(gate);
    }
  });
});

describe("the docs state the consequence (#330)", () => {
  it("the LAN recipe warns before the command, not after", () => {
    const usage = read("docs/usage.md");
    const section = usage.slice(usage.indexOf("## Team setup — shared coordinator on LAN"));
    const warning = section.indexOf("COORDINATOR_BIND=0.0.0.0` without authentication");
    const command = section.indexOf("COORDINATOR_BIND=0.0.0.0 mcp-coordinator server start");
    expect(warning).toBeGreaterThan(-1);
    expect(command).toBeGreaterThan(warning);
  });

  it("the destructive half is named, not just the impersonation half", () => {
    // "an agent can spoof an agent_id" was already documented. "a third party
    // deletes another agent's working_files" was not, and is the new fact.
    for (const doc of ["docs/usage.md", "docs/mqtt-topics.md", "docs/security/threat-model.md"]) {
      expect(read(doc), `${doc} does not mention working_files`).toContain("working_files");
    }
  });
});
