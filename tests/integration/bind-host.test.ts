import { it, expect, afterEach } from "vitest";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import type { AddressInfo } from "node:net";

let handle: ServerHandle | undefined;
afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  delete process.env.COORDINATOR_BIND;
});

it("binds to 127.0.0.1 by default (not 0.0.0.0)", async () => {
  handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });
  const addr = handle.httpServer.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1");
});

it("binds to 0.0.0.0 when COORDINATOR_BIND overrides the default", async () => {
  process.env.COORDINATOR_BIND = "0.0.0.0";
  handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });
  const addr = handle.httpServer.address() as AddressInfo;
  expect(addr.address).toBe("0.0.0.0");
});

// Regression: `port: 0` / `mqttTcpPort: 0` mean "OS, assign one as you bind".
// startServer used to echo the raw 0 back — the handle reported port 0, the
// startup banner advertised :0, and the internal MQTT bridge built its connect
// URL from the sentinel, so mqtt.js fell back to its 1883 default and died
// with ECONNREFUSED. That forced every integration test to pre-probe a free
// port and hand over the number, which is a TOCTOU race: a parallel vitest
// worker could win the re-bind and one side got EADDRINUSE.
it("reports the actually-bound HTTP port when asked for an ephemeral one", async () => {
  handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });

  const addr = handle.httpServer.address() as AddressInfo;
  expect(handle.port).toBe(addr.port);
  expect(handle.port).toBeGreaterThan(0);

  // ...and the reported port is genuinely serving, not just a number.
  const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
  expect(res.status).toBe(200);
  expect((await res.json()) as { status: string }).toMatchObject({ status: "alive" });
});

it("wires the internal MQTT bridge to the broker's resolved ephemeral port", async () => {
  // With mqttTcpPort: 0 the bridge must follow the broker to its OS-assigned
  // port. If it regresses to the sentinel it hits 1883 and the coordinator
  // comes up with a dead bridge — which surfaces here as a failed publish.
  handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });

  // /readyz gates on db + mqtt, so a bridge pointed at the wrong port makes
  // this 503 with checks.mqtt.ok === false.
  const res = await fetch(`http://127.0.0.1:${handle.port}/readyz`);
  const body = (await res.json()) as { status: string; checks: { mqtt: { ok: boolean } } };
  expect(body.checks.mqtt.ok).toBe(true);
  expect(res.status).toBe(200);
});
