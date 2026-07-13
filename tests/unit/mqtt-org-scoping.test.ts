import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startEmbeddedMqttBroker } from "../../src/mqtt-broker.js";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth, createToken, verifyTokenStrict } from "../../src/auth.js";
import mqtt from "mqtt";
import { silentLogger } from "../../src/logger.js";
import fs from "fs";

const DIR = "data-test-mqtt-org";
const SECRET = "test-secret-at-least-32-characters-long!";
let broker: Awaited<ReturnType<typeof startEmbeddedMqttBroker>>;
let TCP_PORT: number;

beforeAll(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(SECRET);
  broker = await startEmbeddedMqttBroker({
    // 0 = OS picks a free port; read back from broker.tcpPort
    tcpPort: 0,
    logger: silentLogger,
    authenticate: async (_username, password) => {
      if (!password) return { ok: false };
      try {
        const { claims } = await verifyTokenStrict(password.toString());
        return { ok: true as const, org: claims.org };
      } catch {
        return { ok: false };
      }
    },
  });
  TCP_PORT = broker.tcpPort!;
});

afterAll(async () => {
  await broker.close();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
  // Module-state hygiene: reset auth module to a known state so other tests
  // that share the process aren't affected by the secret used here.
  initAuth(SECRET);
});

async function connectAs(orgToken: string, clientId: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${TCP_PORT}`, {
      clientId,
      username: "agent",
      password: orgToken,
      reconnectPeriod: 0,
    });
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

describe("MQTT org topic scoping", () => {
  it("client cannot subscribe outside its org prefix", async () => {
    const tokenA = await createToken("agent-a", "agent", undefined, {
      user_id: "u-a",
      org: "org-a",
    });
    const client = await connectAs(tokenA, "client-a-1");

    // mqtt.js v5 calls callback(err, subs) when broker sends SUBACK with qos=128.
    // The err.code === 128 (0x80 = subscription failure per MQTT 3.1.1 §3.9.3).
    const result = await new Promise<{ denied: boolean }>((resolve) => {
      client.subscribe("coordinator/org-b/agents/+", { qos: 0 }, (err, _granted) => {
        // Denied: broker sent SUBACK[128] → mqtt.js 5.x raises an error with code=128
        resolve({ denied: err !== null && err !== undefined });
      });
    });
    expect(result.denied).toBe(true); // subscription was denied (SUBACK[128])
    client.end();
  });

  it("client can subscribe to its own org prefix", async () => {
    const tokenA = await createToken("agent-a2", "agent", undefined, {
      user_id: "u-a",
      org: "org-a",
    });
    const client = await connectAs(tokenA, "client-a-2");

    const result = await new Promise<{ granted: number }>((resolve) => {
      client.subscribe("coordinator/org-a/agents/+", { qos: 0 }, (_err, granted) => {
        const g = granted ?? [];
        resolve({ granted: g[0]?.qos ?? 128 });
      });
    });
    expect(result.granted).toBe(0); // 0 = QoS 0 granted
    client.end();
  });

  it("client gets disconnected on cross-org publish (Aedes default behavior)", async () => {
    const tokenA = await createToken("agent-a3", "agent", undefined, {
      user_id: "u-a",
      org: "org-a",
    });
    const client = await connectAs(tokenA, "client-a-3");

    let closeHit = false;
    client.once("close", () => {
      closeHit = true;
    });
    client.publish("coordinator/org-b/agents/x/status", "payload", { qos: 0 });
    // Aedes emits clientError and disconnects on authorizePublish error.
    // Poll instead of sleeping a fixed duration — robust under CI load.
    await vi.waitFor(
      () => {
        expect(closeHit).toBe(true);
      },
      { timeout: 2000, interval: 50 },
    );
  });
});
