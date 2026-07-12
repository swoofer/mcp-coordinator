import { describe, it, expect } from "vitest";
import { handleHealth } from "../../src/http/handle-health.js";
import type { IncomingMessage, ServerResponse } from "http";

function mockRes(): { res: ServerResponse; getBody: () => Record<string, unknown> } {
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: () => {},
    end(buf?: string) {
      if (buf) chunks.push(buf);
    },
  } as unknown as ServerResponse;
  return { res, getBody: () => (chunks.length ? JSON.parse(chunks.join("")) : {}) };
}

describe("/healthz auth config reporting", () => {
  it("reports auth_enabled and jwt_secret_set", async () => {
    const { res, getBody } = mockRes();
    await handleHealth({} as IncomingMessage, res, {
      authEnabled: true,
      jwtSecretSet: true,
    });
    const body = getBody();
    expect(body.auth_enabled).toBe(true);
    expect(body.jwt_secret_set).toBe(true);
  });

  it("warns when AUTH_ENABLED=true but JWT_SECRET unset", async () => {
    const { res, getBody } = mockRes();
    await handleHealth({} as IncomingMessage, res, {
      authEnabled: true,
      jwtSecretSet: false,
    });
    const body = getBody();
    expect(body.warnings).toContain(
      "AUTH_ENABLED=true but COORDINATOR_JWT_SECRET is unset — sessions invalidate on restart",
    );
  });
});
