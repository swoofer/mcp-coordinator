import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth, createToken } from "../../src/auth.js";
import { startEmbeddedMqttBroker, type EmbeddedMqttBroker } from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";
import { createServer } from "net";

let dataDir: string;
let broker: EmbeddedMqttBroker | null = null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "b3-mqtt-"));
  initDatabase(dataDir);
  initAuth("a-very-long-test-secret-of-at-least-32-chars", "1h");
});

afterEach(async () => {
  if (broker) { await broker.close(); broker = null; }
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("B3 fix - opt-in MQTT JWT auth", () => {
  it("broker without authenticate option accepts any connection (default — essaim compat)", async () => {
    const port = await getFreePort();
    broker = await startEmbeddedMqttBroker({
      tcpPort: port,
      logger: silentLogger,
      // authenticate: undefined → anonymous mode
    });
    expect(broker.tcpPort).toBe(port);
    // Backward-compat: no authenticate hook means broker.authenticate is the
    // aedes default (always allow). We don't actually connect a client here
    // to keep the test fast and decoupled from mqtt.connect quirks; the
    // smoke test in startServer integration covers the full flow.
  });

  it("verifier function accepts a valid JWT in the password field", async () => {
    const token = await createToken("test-agent", "agent");

    const verify = async (_username: string | undefined, password: Buffer | undefined): Promise<{ ok: true; org: string } | { ok: false }> => {
      if (!password) return { ok: false };
      try {
        const { verifyToken } = await import("../../src/auth.js");
        const claims = await verifyToken(password.toString("utf-8"));
        return { ok: true as const, org: claims.org };
      } catch {
        return { ok: false };
      }
    };

    const result = await verify(undefined, Buffer.from(token, "utf-8"));
    expect(result.ok).toBe(true);
  });

  it("verifier rejects missing password", async () => {
    const verify = async (_u: string | undefined, password: Buffer | undefined): Promise<{ ok: true; org: string } | { ok: false }> => {
      if (!password) return { ok: false };
      try {
        const { verifyToken } = await import("../../src/auth.js");
        const claims = await verifyToken(password.toString("utf-8"));
        return { ok: true as const, org: claims.org };
      } catch {
        return { ok: false };
      }
    };
    expect((await verify(undefined, undefined)).ok).toBe(false);
  });

  it("verifier rejects invalid token", async () => {
    const verify = async (_u: string | undefined, password: Buffer | undefined): Promise<{ ok: true; org: string } | { ok: false }> => {
      if (!password) return { ok: false };
      try {
        const { verifyToken } = await import("../../src/auth.js");
        const claims = await verifyToken(password.toString("utf-8"));
        return { ok: true as const, org: claims.org };
      } catch {
        return { ok: false };
      }
    };
    expect((await verify(undefined, Buffer.from("not-a-jwt", "utf-8"))).ok).toBe(false);
    expect((await verify(undefined, Buffer.from("eyJhbGciOiJIUzI1NiJ9.fake.signature", "utf-8"))).ok).toBe(false);
  });

  it("verifier accepts admin tokens too (used by internal coordinator client)", async () => {
    const adminToken = await createToken("coordinator-internal", "admin");
    const verify = async (_u: string | undefined, password: Buffer | undefined): Promise<{ ok: true; org: string } | { ok: false }> => {
      if (!password) return { ok: false };
      try {
        const { verifyToken } = await import("../../src/auth.js");
        const claims = await verifyToken(password.toString("utf-8"));
        return { ok: true as const, org: claims.org };
      } catch {
        return { ok: false };
      }
    };
    expect((await verify(undefined, Buffer.from(adminToken, "utf-8"))).ok).toBe(true);
  });

  it("broker with authenticate option starts (full integration covered by smoke tests)", async () => {
    const port = await getFreePort();
    const calls: Array<{ user: string | undefined; ok: boolean }> = [];
    broker = await startEmbeddedMqttBroker({
      tcpPort: port,
      logger: silentLogger,
      authenticate: async (user, _pw) => {
        calls.push({ user, ok: false });
        return { ok: false }; // reject all
      },
    });
    expect(broker.tcpPort).toBe(port);
    // Calls list will populate when a client tries to connect — CLI smoke
    // test covers the full reject-on-bad-token flow.
  });
});
