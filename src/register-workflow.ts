import type { Agent } from "./types.js";
import type { CoordinatorServices } from "./server-setup.js";

/**
 * architecture-07: shared `register_agent` orchestration.
 *
 * Before this fix, the REST endpoint (`/api/register` in handle-rest.ts)
 * and the MCP tool (`register_agent` in tools/agents-tools.ts) duplicated
 * the same 2-3 lines — registry.register + sseEmitter "agent_online" — but
 * only the MCP path additionally called `mqttBridge.registerAgent(orgId,
 * agentId, name)`, which publishes the agent's retained "online" status to
 * `coordinator/<org>/agents/<id>/status`. An agent registered over REST was
 * therefore never visible as online to MQTT subscribers (essaim, external
 * dashboards) — no comment/rationale was found suggesting this was
 * intentional, so this fix aligns REST with MCP (parity) rather than
 * documenting it as deliberate.
 *
 * Follows the `runCommonAnnounceFlow` precedent in announce-workflow.ts:
 * one shared function, called by both transports, each transport keeping
 * its own pre/post steps (REST: JSON response; MCP: MCP content envelope).
 *
 * mqttBridge.registerAgent() is a no-op when the bridge isn't connected
 * (e.g. stdio transport, cf. protocole-mcp-06) — safe to call unconditionally.
 */
export function runRegisterFlow(
  services: CoordinatorServices,
  orgId: string,
  agentId: string,
  name: string,
  modules: string[],
): Agent {
  const { registry, sseEmitter, mqttBridge } = services;
  const agent = registry.register(orgId, agentId, name, modules);
  sseEmitter.emit("agent_online", { agent_id: agentId, name, modules }, { org_id: orgId });
  mqttBridge.registerAgent(orgId, agentId, name);
  return agent;
}
