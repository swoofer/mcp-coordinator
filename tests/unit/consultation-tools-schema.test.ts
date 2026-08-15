import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { registerConsultationTools } from "../../src/tools/consultation-tools.js";
import { silentLogger } from "../../src/logger.js";
import type { CoordinatorServices } from "../../src/server-setup.js";

function getInputSchema(server: McpServer, toolName: string) {
  const _server = server as unknown as {
    _registeredTools: Record<
      string,
      { inputSchema: { safeParse: (value: unknown) => { success: boolean } } }
    >;
  };
  const registered = _server._registeredTools[toolName];
  if (!registered) throw new Error(`Tool not registered: ${toolName}`);
  return registered.inputSchema;
}

describe("consultation-tools: list_threads schema", () => {
  it("rejects invalid status values", () => {
    const server = new McpServer({ name: "test", version: "0" });

    registerConsultationTools(
      server,
      { consultation: { listThreads: () => [] } } as unknown as CoordinatorServices,
      silentLogger,
      () => ({ sub: "agent-1", user_id: "u-1", org: "org-1", role: "agent", jti: "j-1" }),
    );

    const schema = getInputSchema(server, "list_threads");

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ status: "open" }).success).toBe(true);
    expect(schema.safeParse({ status: "resolving" }).success).toBe(true);
    expect(schema.safeParse({ status: "resolved" }).success).toBe(true);
    expect(schema.safeParse({ status: "cancelled" }).success).toBe(true);
    expect(schema.safeParse({ status: "poisoned" }).success).toBe(true);
    expect(schema.safeParse({ status: "closed" }).success).toBe(false);
    expect(schema.safeParse({ status: "Open" }).success).toBe(false);
    expect(schema.safeParse({ status: "resolved " }).success).toBe(false);
  });
});
