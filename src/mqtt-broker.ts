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

export interface EmbeddedMqttOptions {
  tcpPort?: number; // 0 or undefined → skip TCP
  httpServer?: HttpServer; // undefined → skip WS
  wsPath?: string; // default "/mqtt"
  logger: Logger;
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
  const { tcpPort, httpServer, wsPath = "/mqtt", logger } = opts;
  const broker = await Aedes.createBroker();

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

  if (tcpPort && tcpPort > 0) {
    const tcpServer = createTcpServer((socket) => {
      broker.handle(socket as unknown as Duplex);
    });
    // Bind to 127.0.0.1 explicitly — default binding to IPv6 (::) can cause
    // the mqtt client (which resolves localhost → 127.0.0.1) to hang.
    await new Promise<void>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(tcpPort, "127.0.0.1", () => {
        tcpServer.off("error", reject);
        logger.info({ port: tcpPort, transport: "tcp" }, "Embedded MQTT broker listening");
        resolve();
      });
    });
    tcpServer.on("error", (err) => {
      logger.error({ err, port: tcpPort }, "Embedded MQTT TCP server error");
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
    tcpPort: tcpPort && tcpPort > 0 ? tcpPort : null,
    wsPath: httpServer ? wsPath : null,
    close: async () => {
      if (tcpServerClose) await tcpServerClose();
      if (wsServerClose) await wsServerClose();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    },
  };
}
