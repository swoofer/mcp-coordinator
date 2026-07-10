import { it, expect, afterEach } from "vitest";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import type { AddressInfo } from "node:net";
import http from "node:http";

// NB: mqttTcpPort uses a real free port (not literal 0) — a pre-existing,
// unrelated bug in serve-http.ts's internal MQTT bridge connect URL
// (built from the raw requested port instead of the broker's resolved
// ephemeral port) causes ECONNREFUSED on the mqtt.js default port 1883
// when mqttTcpPort:0 is passed. Out of scope for this task; this test
// sidesteps it using the same getFreePort() pattern other integration
// tests already use (e.g. tests/integration/serve-http-admin-headers.test.ts).
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

let handle: ServerHandle | undefined;
afterEach(async () => { await handle?.stop(); handle = undefined; delete process.env.COORDINATOR_BIND; });

it("binds to 127.0.0.1 by default (not 0.0.0.0)", async () => {
  handle = await startServer({ port: 0, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });
  const addr = handle.httpServer.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1");
});

it("binds to 0.0.0.0 when COORDINATOR_BIND overrides the default", async () => {
  process.env.COORDINATOR_BIND = "0.0.0.0";
  handle = await startServer({ port: 0, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });
  const addr = handle.httpServer.address() as AddressInfo;
  expect(addr.address).toBe("0.0.0.0");
});
