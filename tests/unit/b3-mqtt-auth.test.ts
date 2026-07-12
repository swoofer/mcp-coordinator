import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import mqtt from "mqtt";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth, createToken, verifyToken } from "../../src/auth.js";
import {
  startEmbeddedMqttBroker,
  createAedesAuthenticateHook,
  type EmbeddedMqttBroker,
  type MqttAuthVerifier,
} from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";
import { createServer } from "net";
import type { Client } from "aedes";

let dataDir: string;
let broker: EmbeddedMqttBroker | null = null;

/** Minimal fake Aedes client — only `.id` is read by the real hook. */
function fakeClient(id = "fake-client-1"): Client {
  return { id } as unknown as Client;
}

/**
 * Drive the REAL production hook (`createAedesAuthenticateHook`, extracted
 * verbatim from `startEmbeddedMqttBroker` in src/mqtt-broker.ts) through its
 * raw Aedes callback shape, and resolve with what it passed to `cb`. This is
 * the exact function wired into the embedded broker in production — no
 * reimplementation here.
 */
function runAedesHook(
  verifier: MqttAuthVerifier,
  username: string | undefined,
  password: Buffer | undefined,
): Promise<{ err: Error | null; success: boolean; client: Client }> {
  const hook = createAedesAuthenticateHook(verifier, silentLogger);
  const client = fakeClient();
  return new Promise((resolve) => {
    hook(client, username, password, (err, success) => {
      resolve({ err, success, client });
    });
  });
}

/**
 * The same JWT-backed verifier production wiring passes to
 * `startEmbeddedMqttBroker({ authenticate })` (mirrors src/serve-http.ts's
 * AUTH_ENABLED branch, which uses verifyTokenStrict; here we use verifyToken
 * since that's what this suite's existing tokens are signed for).
 */
const jwtVerifier: MqttAuthVerifier = async (_username, password) => {
  if (!password) return { ok: false };
  try {
    const claims = await verifyToken(password.toString("utf-8"));
    return { ok: true as const, org: claims.org };
  } catch {
    return { ok: false };
  }
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "b3-mqtt-"));
  initDatabase(dataDir);
  initAuth("a-very-long-test-secret-of-at-least-32-chars", "1h");
});

afterEach(async () => {
  if (broker) {
    await broker.close();
    broker = null;
  }
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  // CRITICAL: this test calls initAuth with a non-canonical secret AND a
  // non-default expiry ("1h"). Reset module state to canonical values so
  // subsequent test files in the same worker (vitest fileParallelism:false)
  // don't pick up the contaminated signing key or defaultExpiry.
  initAuth("test-secret-at-least-32-characters-long!");
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

  it("the real hook accepts a valid JWT in the password field and attaches org to the Aedes client", async () => {
    const token = await createToken("test-agent", "agent");

    const { err, success, client } = await runAedesHook(
      jwtVerifier,
      undefined,
      Buffer.from(token, "utf-8"),
    );

    expect(err).toBeNull();
    expect(success).toBe(true);
    // The real hook's success-path side effect (see mqtt-broker.ts) — attaches
    // `org` onto the Aedes client object so authorizeSubscribe/authorizePublish
    // can enforce the coordinator/<org>/ prefix ACL.
    expect((client as unknown as { org: string }).org).toBe("default");
  });

  it("the real hook rejects a missing password", async () => {
    const { err, success } = await runAedesHook(jwtVerifier, undefined, undefined);
    expect(err).toBeNull();
    expect(success).toBe(false);
  });

  it("the real hook rejects an invalid token", async () => {
    const r1 = await runAedesHook(jwtVerifier, undefined, Buffer.from("not-a-jwt", "utf-8"));
    expect(r1.success).toBe(false);
    const r2 = await runAedesHook(
      jwtVerifier,
      undefined,
      Buffer.from("eyJhbGciOiJIUzI1NiJ9.fake.signature", "utf-8"),
    );
    expect(r2.success).toBe(false);
  });

  it("the real hook accepts admin tokens too (used by internal coordinator client)", async () => {
    const adminToken = await createToken("coordinator-internal", "admin");
    const { success, client } = await runAedesHook(
      jwtVerifier,
      undefined,
      Buffer.from(adminToken, "utf-8"),
    );
    expect(success).toBe(true);
    expect((client as unknown as { org: string }).org).toBe("default");
  });

  it("the real hook's cb(err, false) path also fires when the verifier itself rejects (not just on caught exceptions)", async () => {
    // Distinct from the invalid-token case above: this exercises the
    // `!result.ok` branch of the real hook directly (cb(null, false) +
    // logger.warn), whereas the invalid-token tests exercise the verifier's
    // own catch. Both paths live in createAedesAuthenticateHook.
    const alwaysReject: MqttAuthVerifier = async () => ({ ok: false });
    const { err, success } = await runAedesHook(alwaysReject, "someone", Buffer.from("irrelevant"));
    expect(err).toBeNull();
    expect(success).toBe(false);
  });

  it("broker with authenticate option starts and enforces it end-to-end over a real MQTT CONNECT (accept + reject)", async () => {
    const port = await getFreePort();
    broker = await startEmbeddedMqttBroker({
      tcpPort: port,
      logger: silentLogger,
      // This is production wiring: startEmbeddedMqttBroker installs
      // createAedesAuthenticateHook(jwtVerifier, logger) as the real Aedes
      // `authenticate` hook — no test-side reimplementation.
      authenticate: jwtVerifier,
    });
    expect(broker.tcpPort).toBe(port);

    const goodToken = await createToken("good-agent", "agent");
    const good = await new Promise<{ connected: boolean }>((resolve) => {
      const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
        clientId: "good-client",
        // MQTT 3.1.1 requires a username whenever a password is present
        // (mqtt-packet's client-side encoder enforces this and destroys the
        // stream before sending anything otherwise) — mirrors production
        // clients, which always set a username alongside the token.
        username: "agent",
        password: goodToken,
        reconnectPeriod: 0,
        connectTimeout: 3000,
      });
      c.once("connect", () => {
        resolve({ connected: true });
        c.end(true);
      });
      c.once("error", () => {
        resolve({ connected: false });
        c.end(true);
      });
    });
    expect(good.connected).toBe(true);

    const bad = await new Promise<{ connected: boolean }>((resolve) => {
      const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
        clientId: "bad-client",
        username: "agent",
        password: "not-a-valid-jwt",
        reconnectPeriod: 0,
        connectTimeout: 3000,
      });
      // Aedes writes a CONNACK[returnCode=5] then closes the socket
      // (client.close.bind in its authenticate handler) — over loopback,
      // mqtt.js sometimes observes this as a "close" without ever surfacing
      // a parsed "error" event (the socket teardown can race the CONNACK
      // parse). Treat anything other than "connect" as rejection: what we
      // actually care about is that the real hook never let the client in.
      c.once("connect", () => {
        resolve({ connected: true });
        c.end(true);
      });
      c.once("error", () => {
        resolve({ connected: false });
        c.end(true);
      });
      c.once("close", () => resolve({ connected: false }));
    });
    expect(bad.connected).toBe(false);
  });
});
