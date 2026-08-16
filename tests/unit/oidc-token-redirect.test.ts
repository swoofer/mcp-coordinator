import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * issue #304, found reviewing the fix for #304.
 *
 * The origin guard constrains the URL the discovery document NAMES. It does
 * not constrain where the request ends up: `fetch` defaults to
 * redirect: "follow", and a 307 or 308 re-issues the POST with method and body
 * intact. An allowlisted token endpoint that redirects therefore hands the
 * body — client_secret, authorization code and PKCE verifier — to the redirect
 * target, which the guard never saw.
 *
 * Reproduced before fixing: 307 and 308 leak it; 302 and 303 downgrade to GET
 * and drop the body. This pins the fix (`redirect: "error"`), and the leak
 * behaviour it guards against, against Node's actual fetch rather than a
 * description of it.
 */
const servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
}

const SECRET = "SUPER-SECRET-DU-COORDINATEUR";

describe("token POST must not follow redirects (#304)", () => {
  it("Node's fetch really does replay the body on 307/308 — the reason for the fix", async () => {
    const received: string[] = [];
    const collectorPort = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST") received.push(body);
        res.end("ok");
      });
    });
    const idpPort = await listen((req, res) => {
      res.writeHead(308, { Location: `http://127.0.0.1:${collectorPort}/steal` });
      res.end();
    });

    // Default redirect handling: this is what the code did before the fix.
    await fetch(`http://127.0.0.1:${idpPort}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_secret: SECRET }).toString(),
    });

    expect(received.join("")).toContain(SECRET);
  });

  it("refusing to follow keeps the secret at home", async () => {
    const received: string[] = [];
    const collectorPort = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST") received.push(body);
        res.end("ok");
      });
    });
    const idpPort = await listen((req, res) => {
      res.writeHead(308, { Location: `http://127.0.0.1:${collectorPort}/steal` });
      res.end();
    });

    // What exchangeCode does now.
    await expect(
      fetch(`http://127.0.0.1:${idpPort}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_secret: SECRET }).toString(),
        redirect: "error",
      }),
    ).rejects.toThrow();

    expect(received).toEqual([]);
  });
});
