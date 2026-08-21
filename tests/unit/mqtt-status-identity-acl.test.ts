import { describe, it, expect, vi } from "vitest";
import {
  agentStatusTopicOwner,
  createAedesAuthorizePublishHook,
  createAedesAuthenticateHook,
} from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";

/**
 * issue #330 — the publish ACL matched an org prefix and nothing finer, so any
 * client the broker admitted could publish ANY message on behalf of ANY other
 * agent in its org. The issue treats identity as the missing piece and files it
 * under "pistes non tranchées".
 *
 * The identity was already there. A Phase 1 agent token is minted with
 * `.setSubject(agentId)` (src/auth.ts:99), and the MQTT verifier had the whole
 * claims object in hand — it forwarded `org` and `role` and dropped `sub`.
 *
 * Only ONE topic is restricted, deliberately:
 * `coordinator/<org>/agents/<id>/status` is the only one that is destructive
 * rather than informational — an `offline` payload there runs that agent's
 * departure (#427). Consultations and broadcast stay org-wide, because fanning
 * out to the org IS what they are for.
 */

const ORG = "acme";

/** Aedes calls back with an Error to deny, with nothing to allow. */
function publishAllowed(
  client: Record<string, unknown>,
  topic: string,
): { allowed: boolean; message?: string } {
  let out: { allowed: boolean; message?: string } = { allowed: false };
  createAedesAuthorizePublishHook(silentLogger)(
    client as never,
    { topic } as never,
    ((err: Error | null) => {
      out = err ? { allowed: false, message: err.message } : { allowed: true };
    }) as never,
  );
  return out;
}

const agent = (id: string) => ({ id: "c1", org: ORG, role: "agent", agentId: id });

describe("agentStatusTopicOwner names the agent, or nothing (#330)", () => {
  it("recognises a status topic in this org", () => {
    expect(agentStatusTopicOwner(`coordinator/${ORG}/agents/alice/status`, ORG)).toBe("alice");
  });

  it("is not fooled by another org, another leaf, or extra depth", () => {
    expect(agentStatusTopicOwner(`coordinator/other/agents/alice/status`, ORG)).toBeNull();
    expect(agentStatusTopicOwner(`coordinator/${ORG}/agents/alice/heartbeat`, ORG)).toBeNull();
    expect(agentStatusTopicOwner(`coordinator/${ORG}/agents/alice/status/extra`, ORG)).toBeNull();
    expect(agentStatusTopicOwner(`coordinator/${ORG}/consultations/alice/status`, ORG)).toBeNull();
    expect(agentStatusTopicOwner(`${ORG}/agents/alice/status`, ORG)).toBeNull();
  });

  it("an empty agent segment names nobody rather than the empty string", () => {
    expect(agentStatusTopicOwner(`coordinator/${ORG}/agents//status`, ORG)).toBeNull();
  });
});

describe("an agent may only announce itself (#330)", () => {
  it("its own status topic passes", () => {
    expect(publishAllowed(agent("alice"), `coordinator/${ORG}/agents/alice/status`).allowed).toBe(
      true,
    );
  });

  it("another agent's status topic is refused — the measured attack", () => {
    // The reproduction in the issue: publish {status:"offline"} on a live
    // agent's topic and the coordinator runs its departure.
    const r = publishAllowed(agent("mallory"), `coordinator/${ORG}/agents/victim/status`);
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/another agent's status/i);
  });

  it("consultation and broadcast topics stay org-wide", () => {
    // Restricting these would break the fan-out this bus exists for.
    for (const topic of [
      `coordinator/${ORG}/broadcast`,
      `coordinator/${ORG}/consultations/new`,
      `coordinator/${ORG}/consultations/thread-1/messages`,
    ]) {
      expect(publishAllowed(agent("alice"), topic).allowed, topic).toBe(true);
    }
  });

  it("cross-org is still refused first, and for its own reason", () => {
    const r = publishAllowed(agent("alice"), `coordinator/other-org/agents/alice/status`);
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/cross-org/i);
  });
});

describe("clients with no agent identity (#330)", () => {
  it("the internal bridge is still exempt — it routes every tenant", () => {
    const bridge = { id: "c0", org: ORG, role: "internal" };
    expect(publishAllowed(bridge, `coordinator/${ORG}/agents/alice/status`).allowed).toBe(true);
    expect(publishAllowed(bridge, `coordinator/other-org/agents/bob/status`).allowed).toBe(true);
  });

  it("an authenticated non-agent cannot claim a status topic", () => {
    // undefined identity reads as "not an agent", never as "any agent". A
    // human's Phase 2 JWT has no business announcing an agent offline.
    const human = { id: "c2", org: ORG, role: "member", agentId: undefined };
    expect(publishAllowed(human, `coordinator/${ORG}/agents/alice/status`).allowed).toBe(false);
    // ...while its ordinary org traffic is untouched.
    expect(publishAllowed(human, `coordinator/${ORG}/broadcast`).allowed).toBe(true);
  });

  it("a client with no org is refused outright, as before", () => {
    expect(publishAllowed({ id: "c3" }, `coordinator/${ORG}/broadcast`).allowed).toBe(false);
  });
});

describe("the verifier's identity reaches the client object (#330)", () => {
  const attach = async (result: Record<string, unknown>) => {
    const client: Record<string, unknown> = { id: "c9" };
    const cb = vi.fn();
    createAedesAuthenticateHook(async () => result as never, silentLogger)(
      client as never,
      undefined,
      Buffer.from("t"),
      cb as never,
    );
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    return { client, cb };
  };

  it("agentId is attached alongside org and role", async () => {
    const { client, cb } = await attach({ ok: true, org: ORG, role: "agent", agentId: "alice" });
    expect(cb).toHaveBeenCalledWith(null, true);
    expect(client.agentId).toBe("alice");
    expect(client.org).toBe(ORG);
  });

  it("and stays undefined when the verifier supplies none", async () => {
    const { client } = await attach({ ok: true, org: ORG, role: "internal" });
    expect(client.agentId).toBeUndefined();
    // Which is exactly the state the ACL must not read as "any agent".
    expect(
      publishAllowed({ id: "c9", org: ORG }, `coordinator/${ORG}/agents/a/status`).allowed,
    ).toBe(false);
  });
});
