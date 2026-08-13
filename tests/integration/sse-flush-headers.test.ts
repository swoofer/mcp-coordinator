/**
 * handleSse() must flush the 200 + event-stream headers to the socket
 * immediately (res.flushHeaders()), not lazily on the first body byte.
 *
 * On a fresh/quiet org there are no recent events to write, so without an
 * explicit flush Node buffers the headers until the first write — which,
 * for a quiet coordinator, is the heartbeat (up to COORDINATOR_SSE_HEARTBEAT_MS,
 * default ~30s). A browser EventSource then sits in "Connecting" and never
 * fires `onopen` until then. This test drives the real /api/events endpoint
 * and asserts the response headers arrive fast: fetch() resolves on response
 * headers, so if the flush were missing it would hang past the short timeout.
 *
 * Bug surfaced via the dashboard e2e smoke (tests-05); this is the
 * deterministic in-process regression test for it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

describe("SSE /api/events flushes headers immediately (quiet org)", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  it("response headers arrive well before any heartbeat, even with no buffered events", async () => {
    handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });
    const port = handle.port;

    const ac = new AbortController();
    // Abort well under the heartbeat interval. If flushHeaders() were missing,
    // a fresh org (no recent events) writes no body until the heartbeat, so
    // fetch() — which resolves once response headers land — would never resolve
    // and this would abort/throw. With the flush it resolves in milliseconds.
    const timer = setTimeout(() => ac.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    // Close the still-open SSE stream so the server can shut down cleanly.
    ac.abort();
    await res.body?.cancel().catch(() => {});
  });
});
