import { Aedes, type Client } from "aedes";
import { createServer as createTcpServer } from "net";
import type { Server as HttpServer, IncomingMessage } from "http";
import { Duplex } from "stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Logger } from "./logger.js";

// performance-04: caps inbound WS frame size for the MQTT-over-WS bridge
// (DoS guard). Defaults to 1 MiB — same default as COORDINATOR_MAX_BODY_BYTES
// (src/http/utils.ts) for a consistent "reasonable payload" ceiling across
// the server's ingress paths. Override via env if legitimate MQTT payloads
// need more headroom.
const MQTT_WS_MAX_PAYLOAD_BYTES = parseInt(
  process.env.COORDINATOR_MQTT_WS_MAX_PAYLOAD_BYTES || "1048576",
  10,
);

/**
 * Bridge a WebSocket to a Duplex stream for aedes.
 * Replaces createWebSocketStream which is not supported in Bun.
 *
 * Backpressure (performance-04):
 *  - write: `ws.send`'s callback is only invoked once the chunk is flushed
 *    to the underlying socket. Forwarding it as the Duplex `write` callback
 *    means the Duplex won't accept the next chunk until the previous one is
 *    actually flushed — a slow WS consumer now throttles the source instead
 *    of buffering without bound.
 *  - read: `duplex.push()` returns false when the internal read buffer is
 *    full. When that happens we `ws.pause()` (stops the underlying socket
 *    from emitting further "message" events) and resume it from `read()`,
 *    which aedes calls once it's ready to consume more — mirroring the
 *    standard Node.js readable-stream backpressure contract.
 *    `ws.pause()`/`ws.resume()` are no-ops when the socket isn't in a state
 *    where pausing/resuming applies (see `ws` lib), so this can't deadlock
 *    on a socket that's already closing/closed.
 *
 * `highWaterMark` is set explicitly (16 KiB — the same figure Node's
 * Duplex/Readable/Writable defaults to when unset) rather than left
 * implicit: it bounds the read/write buffers to a known size regardless of
 * Node version/platform defaults, and makes the `push()`/`write()`
 * backpressure threshold deterministic for tests.
 */
const WS_DUPLEX_HIGH_WATER_MARK_BYTES = 16 * 1024;

export function wsToDuplex(ws: WebSocket): Duplex {
  const duplex = new Duplex({
    highWaterMark: WS_DUPLEX_HIGH_WATER_MARK_BYTES,
    read() {
      // aedes is ready for more data — release backpressure applied (if any)
      // in the "message" handler below.
      ws.resume();
    },
    write(chunk, _encoding, callback) {
      try {
        // `ws.send`'s callback fires once the chunk is written to the
        // underlying socket (or errors). Passing it straight through gives
        // the Duplex real backpressure: it won't call `write` again until
        // this callback fires.
        ws.send(chunk, (err) => callback(err ?? null));
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      ws.close();
      callback();
    },
  });
  ws.on("message", (data) => {
    if (!duplex.push(data)) {
      // Buffer full: stop the socket from delivering more "message" events
      // until `read()` above signals aedes is ready again.
      ws.pause();
    }
  });
  ws.on("close", () => { duplex.push(null); duplex.destroy(); });
  ws.on("error", (err) => duplex.destroy(err));
  return duplex;
}

export interface EmbeddedMqttBroker {
  tcpPort: number | null;
  wsPath: string | null;
  close: () => Promise<void>;
}

/**
 * B3 fix: opt-in MQTT authentication. When provided, every CONNECT packet's
 * password field is passed to authenticate(). Returns `{ ok: true, org }` on
 * success — the org is attached to the Aedes client and used by the ACL hooks.
 * Returns `{ ok: false }` to reject the CONNECT.
 * When omitted (default), the broker accepts anonymous connections — preserving
 * the existing behavior so essaim and other clients without auth keep working.
 *
 * The internal coordinator client (MqttBridge) bypasses this by passing an
 * internal admin token when AUTH_ENABLED is true.
 */
export type MqttAuthResult = { ok: false } | { ok: true; org: string };
export type MqttAuthVerifier = (
  username: string | undefined,
  password: Buffer | undefined,
) => Promise<MqttAuthResult>;

/** Aedes' raw `authenticate` hook signature (client, username, password, cb). */
export type AedesAuthenticateHook = (
  client: Client,
  username: string | undefined,
  password: Buffer | undefined,
  cb: (err: Error | null, success: boolean) => void,
) => void;

/**
 * Build the Aedes-shaped `authenticate` hook from a `MqttAuthVerifier`.
 * Pulled out of `startEmbeddedMqttBroker` (pure extraction, no behavior
 * change) and exported so tests can exercise the exact production hook —
 * including the `client.org` side effect and the reject/error logging —
 * instead of re-implementing its logic (see tests/unit/b3-mqtt-auth.test.ts).
 */
export function createAedesAuthenticateHook(
  authenticate: MqttAuthVerifier,
  logger: Logger,
): AedesAuthenticateHook {
  return (client, username, password, cb) => {
    Promise.resolve(authenticate(username, password)).then(
      (result) => {
        if (!result.ok) {
          logger.warn({ client_id: client?.id, username }, "MQTT auth rejected");
          cb(null, false);
          return;
        }
        // Attach org to the Aedes client object — survives the connection lifetime.
        (client as unknown as { org: string }).org = result.org;
        cb(null, true);
      },
      (err) => {
        logger.warn({ client_id: client?.id, err: (err as Error).message }, "MQTT auth error");
        cb(null, false);
      }
    );
  };
}

export interface EmbeddedMqttOptions {
  tcpPort?: number; // 0 = OS-assigned (read back from EmbeddedMqttBroker.tcpPort), undefined = skip TCP
  httpServer?: HttpServer; // undefined → skip WS
  wsPath?: string; // default "/mqtt"
  logger: Logger;
  /**
   * Per-CONNECT auth verifier. Returns `{ ok: true, org }` on success — the org is
   * attached to the Aedes client and used by authorizeSubscribe/authorizePublish.
   * Returning `{ ok: false }` rejects the CONNECT.
   * Omit to allow anonymous (default — Phase 1 backward compat).
   */
  authenticate?: MqttAuthVerifier;
}

/**
 * Start an embedded MQTT broker (aedes) exposed via TCP, WebSocket, or both.
 * TCP and WS share the same aedes instance, so a client on ws:// can receive
 * messages from a client on mqtt:// and vice versa.
 *
 * Uses Aedes.createBroker() to wait for the broker's async initialization
 * before accepting connections — new Aedes() returns before the broker is
 * fully ready, which causes client connect timeouts in compiled binaries.
 */
export async function startEmbeddedMqttBroker(opts: EmbeddedMqttOptions): Promise<EmbeddedMqttBroker> {
  const { tcpPort, httpServer, wsPath = "/mqtt", logger, authenticate } = opts;

  // Build Aedes options. Hooks are passed at construction time to guarantee
  // they are set before the broker accepts any connections.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aedesOpts: Record<string, any> = {};

  if (authenticate) {
    // B3 fix: when AUTH_ENABLED, every CONNECT must present a valid token.
    aedesOpts.authenticate = createAedesAuthenticateHook(authenticate, logger);

    // ACL: subscriptions must match coordinator/<org>/...
    // cb(null, null) → granted=128 (subscription failure per MQTT 3.1.1)
    aedesOpts.authorizeSubscribe = (client: Client, sub: { topic: string; qos: number }, cb: (err: Error | null, sub: { topic: string; qos: number } | null) => void) => {
      const org = (client as unknown as { org?: string }).org;
      if (!org) return cb(new Error("MQTT client missing org"), null);
      const prefix = `coordinator/${org}/`;
      if (!sub.topic.startsWith(prefix)) {
        logger.warn({ client_id: client?.id, org, topic: sub.topic }, "MQTT subscribe denied (cross-org)");
        return cb(null, null);
      }
      cb(null, sub);
    };

    // ACL: publishes must match coordinator/<org>/...
    // Passing an Error to cb causes Aedes to disconnect the client (intended:
    // cross-org publish is treated as a protocol violation, not silently dropped).
    aedesOpts.authorizePublish = (client: Client, packet: { topic: string }, cb: (err: Error | null) => void) => {
      const org = (client as unknown as { org?: string }).org;
      if (!org) return cb(new Error("MQTT client missing org"));
      const prefix = `coordinator/${org}/`;
      if (!packet.topic.startsWith(prefix)) {
        logger.warn({ client_id: client?.id, org, topic: packet.topic }, "MQTT publish denied (cross-org) — client will be disconnected");
        return cb(new Error("Cross-org publish denied"));
      }
      cb(null);
    };

    logger.info("MQTT auth enabled (token in CONNECT password)");
  }

  const broker = await Aedes.createBroker(aedesOpts);

  broker.on("client", (client: Client) => {
    logger.debug({ client_id: client?.id }, "MQTT client connected");
  });
  broker.on("clientDisconnect", (client: Client) => {
    logger.debug({ client_id: client?.id }, "MQTT client disconnected");
  });
  broker.on("clientError", (client: Client, err: Error) => {
    logger.warn({ client_id: client?.id, err: err.message }, "MQTT client error");
  });

  let tcpServerClose: (() => Promise<void>) | null = null;
  let wsServerClose: (() => Promise<void>) | null = null;
  let resolvedTcpPort: number | null = null;

  if (tcpPort !== undefined && tcpPort >= 0) {
    const tcpServer = createTcpServer((socket) => {
      broker.handle(socket as unknown as Duplex);
    });
    // Bind to 127.0.0.1 explicitly — default binding to IPv6 (::) can cause
    // the mqtt client (which resolves localhost → 127.0.0.1) to hang.
    await new Promise<void>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(tcpPort, "127.0.0.1", () => {
        tcpServer.off("error", reject);
        const addr = tcpServer.address();
        // TS narrowing doesn't flow into this callback. `tcpPort` is typed
        // `number | undefined` here even though the outer guard rules out
        // undefined. Use `?? null` to keep the assignment compatible with
        // `number | null`.
        resolvedTcpPort = typeof addr === "object" && addr ? addr.port : (tcpPort ?? null);
        logger.info({ port: resolvedTcpPort, transport: "tcp" }, "Embedded MQTT broker listening");
        resolve();
      });
    });
    tcpServer.on("error", (err) => {
      logger.error({ err, port: resolvedTcpPort }, "Embedded MQTT TCP server error");
    });
    tcpServerClose = () => new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  }

  if (httpServer) {
    // performance-04: bound inbound WS frame size — without this, `ws`
    // defaults to a 100 MiB maxPayload, letting a single client send
    // unbounded-ish frames to the broker.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MQTT_WS_MAX_PAYLOAD_BYTES });
    wss.on("connection", (ws) => {
      const duplex = wsToDuplex(ws);
      broker.handle(duplex);
    });
    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = req.url || "";
      if (url === wsPath || url.startsWith(`${wsPath}?`)) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      }
    });
    logger.info({ path: wsPath, transport: "ws" }, "Embedded MQTT broker listening on HTTP upgrade");
    wsServerClose = () => new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return {
    tcpPort: resolvedTcpPort,
    wsPath: httpServer ? wsPath : null,
    close: async () => {
      if (tcpServerClose) await tcpServerClose();
      if (wsServerClose) await wsServerClose();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    },
  };
}
