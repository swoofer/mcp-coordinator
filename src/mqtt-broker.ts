import { Aedes, type Client } from "aedes";
import { createServer as createTcpServer } from "net";
import type { Server as HttpServer, IncomingMessage } from "http";
import { Duplex } from "stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Logger } from "./logger.js";

/**
 * Bridge a WebSocket to a Duplex stream for aedes.
 * Replaces createWebSocketStream which is not supported in Bun.
 */
function wsToDuplex(ws: WebSocket): Duplex {
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      try {
        ws.send(chunk);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      ws.close();
      callback();
    },
  });
  ws.on("message", (data) => duplex.push(data));
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
    aedesOpts.authenticate = (client: Client, username: string | undefined, password: Buffer | undefined, cb: (err: Error | null, success: boolean) => void) => {
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
    const wss = new WebSocketServer({ noServer: true });
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
