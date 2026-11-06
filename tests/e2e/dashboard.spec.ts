import { TSX_NODE_ARGS } from "../helpers/tsx-node.js";
import { test as base, expect } from "@playwright/test";
import { SignJWT } from "jose";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tests-05 — the main dashboard (dashboard/public/index.html plus its
 * extracted dashboard/public/dashboard.js, served at /dashboard/) is the
 * product's showcase and had zero e2e coverage before this file.
 *
 * PORT IS DELIBERATELY RANDOM. This spec used to pin PORT=3100 because
 * dashboard.js:1 hardcoded `const COORDINATOR_URL = 'http://localhost:3100'`
 * and every fetch()/EventSource in it targeted that literal port. Since
 * src/serve-http.ts serves the asset under `connect-src 'self'`, on any
 * other port the page's own CSP blocked all 9 data calls and the dashboard
 * rendered empty with nothing visible to the user. dashboard.js now derives
 * its origin from window.location, so the free port below is the regression
 * guard: if anyone reintroduces a hardcoded origin, the "Connecté"
 * assertions (which require the EventSource to actually open) and the
 * no-CSP-violation assertion in the render test fail immediately.
 *
 * `dashboardFixture` still doesn't reuse tests/e2e/helpers/
 * coordinator-fixture.ts's `coordinatorFixture` — not over ports (both pick
 * a free one now) but because that fixture sets COORDINATOR_OAUTH_ENABLED
 * and spawns a mock GitHub server, which would put this spec's REST calls
 * (POST /api/register, /api/reset) behind a login step it doesn't intend to
 * cover, and because it has no COORDINATOR_SSE_HEARTBEAT_MS override (see
 * below) so every "Connecté" assertion would race the 30s default heartbeat.
 *
 * Also unlike tests/e2e/admin-ui.spec.ts, the main dashboard and its
 * REST/SSE surface (/dashboard/, /api/register, /api/events, /api/reset) do
 * NOT require an OAuth session — this fixture doesn't set
 * COORDINATOR_AUTH_ENABLED or COORDINATOR_OAUTH_ENABLED, so
 * src/serve-http.ts's authenticateRequest() returns synthetic legacy claims
 * and every request is served open. No login step is needed.
 *
 * Covered:
 *   1. Page render — header, connection-status widget, and the panels that
 *      anchor the rest of this suite (Agents, Timeline w/ its 3 buttons)
 *      are present in the DOM.
 *   2 + 3. Registering an agent via the REST API (`POST /api/register`,
 *      same call site as the CLI/SDK) makes it appear in #agents-list
 *      WITHOUT a page reload — this is the live SSE update path
 *      (EventSource → addEvent('agent_online', …) → updateAgents()), not a
 *      polling refresh, so it also demonstrates the SSE panel updates live.
 *   4. Reset Server gating (pins the recent "split Clear (UI-only) from
 *      Reset Server (destructive, gated)" fix): clicking the button opens a
 *      window.confirm() the destructive fetch is gated behind. Dismissing
 *      that dialog (as this suite does explicitly) must NOT let
 *      POST /api/reset reach the server — the negative assertion that
 *      proves the destructive path doesn't fire off a bare click.
 */

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

interface DashboardFixtures {
  coordinatorUrl: string;
}

async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not assign port")));
      }
    });
  });
}

async function waitForCoordinator(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/livez`);
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Coordinator at ${url} did not become healthy in ${STARTUP_TIMEOUT_MS}ms; last error: ${String(lastError)}`,
  );
}

// `extraEnv` lets a describe block boot the same coordinator with auth on
// (see "authenticated coordinator" below) without duplicating this fixture.
function makeDashboardFixture(extraEnv: Record<string, string> = {}) {
  return base.extend<DashboardFixtures>({
    // eslint-disable-next-line no-empty-pattern
    coordinatorUrl: async ({}, use) => {
      // Free port, not a pinned 3100 — see file header: this is what makes the
      // spec a regression test for the dashboard's same-origin API calls.
      const port = await findFreePort();
      const mqttPort = await findFreePort();
      const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-e2e-dash-"));
      const coordinatorUrl = `http://localhost:${port}`;

      const child: ChildProcess = spawn(process.execPath, [...TSX_NODE_ARGS, "src/serve-http.ts"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          COORDINATOR_DATA_DIR: dataDir,
          COORDINATOR_MQTT_TCP_PORT: String(mqttPort),
          // handleSse() in src/serve-http.ts writeHead()s the SSE response but
          // only actually flushes it to the socket on the first res.write() —
          // either a backlog event replay (none exist on a fresh coordinator)
          // or the periodic heartbeat (:keep-alive\n\n", default 30s). Without
          // shortening it, a fresh page's EventSource can sit in "Connecting…"
          // for up to 30s before the browser sees any bytes and fires onopen.
          // 250ms keeps this suite's "Connecté" assertions fast and reliable.
          COORDINATOR_SSE_HEARTBEAT_MS: "250",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));

      let exited = false;
      child.on("exit", (code, signal) => {
        exited = true;
        if (code !== 0 && code !== null) {
          // eslint-disable-next-line no-console
          console.error(
            `Dashboard coordinator child exited early code=${code} signal=${signal}\nSTDOUT:\n${stdoutChunks.join("")}\nSTDERR:\n${stderrChunks.join("")}`,
          );
        }
      });

      try {
        await waitForCoordinator(coordinatorUrl);
      } catch (err) {
        if (!exited && !child.killed) child.kill("SIGTERM");
        throw new Error(
          `${(err as Error).message}\nSTDOUT:\n${stdoutChunks.join("")}\nSTDERR:\n${stderrChunks.join("")}`,
        );
      }

      await use(coordinatorUrl);

      if (!exited && !child.killed) {
        child.kill("SIGTERM");
        const exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        await Promise.race([exitPromise, timeoutPromise]);
        if (!child.killed) child.kill("SIGKILL");
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — Windows may still hold a handle if SQLite
        // hasn't fully released. Acceptable for tests.
      }
    },
  });
}

const test = makeDashboardFixture();

test.describe("main dashboard — render", () => {
  test("loads /dashboard/ and renders the core panels", async ({ page, coordinatorUrl }) => {
    // The dashboard's own CSP is `connect-src 'self'`, so any data call built
    // from a hardcoded origin is refused by the browser rather than failing
    // loudly in the UI. Capture those refusals so the assertion below names
    // the actual bug instead of surfacing as a confusing "Connecté" timeout.
    const cspErrors: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error" && /Content Security Policy|Refused to connect/i.test(text)) {
        cspErrors.push(text);
      }
    });

    await page.goto(`${coordinatorUrl}/dashboard/`);

    await expect(page.locator("h1")).toContainText("MCP Coordinator");
    await expect(page.locator("#conn-status")).toBeVisible();
    await expect(page.locator(".panel-title", { hasText: "Agents en ligne" })).toBeVisible();
    await expect(page.locator("#agents-list")).toBeAttached();
    await expect(page.locator(".panel-title", { hasText: "Timeline" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Clear UI" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Reset Server" })).toBeVisible();

    // Connection status flips from "Connecting..." to "Connecté" once the
    // SSE EventSource opens (es.onopen in dashboard.js) — proves the
    // /api/events stream is actually reachable, not just that the HTML
    // shipped. On a random port this only passes if dashboard.js resolved
    // its origin from window.location.
    await expect(page.locator("#conn-status")).toContainText("Connecté");

    // An open (auth-off) coordinator never asks for a token.
    await expect(page.locator("#token-form")).toBeHidden();

    // Same-origin regression guard: no data call may be CSP-refused. This
    // fails loudly if a hardcoded origin ever comes back into dashboard.js.
    expect(cspErrors).toEqual([]);
  });
});

test.describe("main dashboard — agent list live-updates via SSE", () => {
  test("registering an agent via REST makes it appear in #agents-list without a reload", async ({
    page,
    coordinatorUrl,
  }) => {
    await page.goto(`${coordinatorUrl}/dashboard/`);
    await expect(page.locator("#conn-status")).toContainText("Connecté");

    // No agent yet.
    await expect(page.locator("#agents-list")).toContainText("Aucun agent");

    const agentName = `e2e-dashboard-agent-${Date.now()}`;
    const res = await page.request.post(`${coordinatorUrl}/api/register`, {
      data: { agent_id: agentName, name: agentName, modules: ["dashboard-e2e"] },
    });
    expect(res.ok()).toBeTruthy();

    // Live update: the browser's own EventSource receives the agent_online
    // SSE event and repaints #agents-list — no page.reload() here.
    await expect(page.locator("#agents-list")).toContainText(agentName);
    await expect(page.locator(".agent-modules", { hasText: "dashboard-e2e" })).toBeVisible();
  });
});

test.describe("main dashboard — Reset Server is gated, not a bare click", () => {
  test("clicking Reset Server opens a confirm dialog; dismissing it must not call POST /api/reset", async ({
    page,
    coordinatorUrl,
  }) => {
    await page.goto(`${coordinatorUrl}/dashboard/`);
    await expect(page.locator("#conn-status")).toContainText("Connecté");

    // Seed one agent so the confirm() copy takes the "active agents" branch
    // too — either branch must still gate on confirm() before the fetch.
    const agentName = `e2e-reset-gate-agent-${Date.now()}`;
    await page.request.post(`${coordinatorUrl}/api/register`, {
      data: { agent_id: agentName, name: agentName, modules: [] },
    });
    await expect(page.locator("#agents-list")).toContainText(agentName);

    // Track every request the page makes so we can assert the destructive
    // endpoint was never hit — the negative assertion this test exists for.
    const requestUrls: string[] = [];
    page.on("request", (r) => requestUrls.push(r.url()));

    let dialogMessage = "";
    let dialogType = "";
    page.once("dialog", async (dialog) => {
      dialogType = dialog.type();
      dialogMessage = dialog.message();
      // Cancel — simulates a user backing out. This is the gate: resetServer()
      // in dashboard/public/dashboard.js does `if (!confirm(msg)) return;`
      // before the fetch, so dismissal must short-circuit before /api/reset.
      await dialog.dismiss();
    });

    await page.locator("button", { hasText: "Reset Server" }).click();

    // Give the (absent) fetch a moment to have fired if the gate were broken.
    await page.waitForTimeout(300);

    expect(dialogType).toBe("confirm");
    expect(dialogMessage).toContain("Reset Server");
    expect(requestUrls.some((u) => u.includes("/api/reset"))).toBe(false);

    // Nothing was wiped — the agent registered above is still listed.
    await expect(page.locator("#agents-list")).toContainText(agentName);
  });
});

/**
 * Authenticated coordinator (COORDINATOR_AUTH_ENABLED=true, Phase 1 Bearer
 * JWTs, no OAuth). Every /api/* call answers 401 without a credential, and
 * there is no browser login to fall back on, so the page itself must carry
 * a token: read once from a `#token=` fragment (never sent to the server,
 * stripped from the URL) or typed into #token-form, kept in sessionStorage,
 * and sent as `Authorization: Bearer` on every call — the event stream too,
 * which the page reads with a streamed fetch() rather than an EventSource so
 * the token never rides in a query string.
 */
const E2E_JWT_SECRET = "e2e-dashboard-auth-secret-0123456789abcdef";

// org "default" is the only org a fresh database holds; agent rows carry a
// foreign key to it, so registering under an unprovisioned org would 500.
async function mintAgentToken(agentId: string, org = "default"): Promise<string> {
  return new SignJWT({ role: "agent", user_id: agentId, org })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(agentId)
    .setJti(`${agentId}-${Date.now()}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(E2E_JWT_SECRET));
}

const authTest = makeDashboardFixture({
  COORDINATOR_AUTH_ENABLED: "true",
  COORDINATOR_JWT_SECRET: E2E_JWT_SECRET,
  // Boot refuses auth-on without these two (serve-http.ts); unused here.
  COORDINATOR_REGISTRATION_SECRET: "e2e-dashboard-registration-secret",
  COORDINATOR_ADMIN_SECRET: "e2e-dashboard-admin-secret",
});

authTest.describe("main dashboard — authenticated coordinator", () => {
  authTest(
    "without a token, the page asks for one instead of staying silently empty",
    async ({ page, coordinatorUrl }) => {
      await page.goto(`${coordinatorUrl}/dashboard/`);
      await expect(page.locator("#token-form")).toBeVisible();
      await expect(page.locator("#conn-status")).toContainText("Déconnecté");
    },
  );

  authTest(
    "a #token= fragment connects the page, is removed from the URL, and live updates flow",
    async ({ page, coordinatorUrl }) => {
      const token = await mintAgentToken("e2e-dashboard-viewer");
      await page.goto(`${coordinatorUrl}/dashboard/#token=${token}`);

      await expect(page.locator("#conn-status")).toContainText("Connecté");
      await expect(page.locator("#token-form")).toBeHidden();
      expect(page.url()).not.toContain(token);

      const agentName = `e2e-auth-agent-${Date.now()}`;
      const agentToken = await mintAgentToken(agentName);
      const res = await page.request.post(`${coordinatorUrl}/api/register`, {
        headers: { Authorization: `Bearer ${agentToken}` },
        data: { agent_id: agentName, name: agentName, modules: ["dashboard-auth-e2e"] },
      });
      expect(res.ok()).toBeTruthy();
      await expect(page.locator("#agents-list")).toContainText(agentName);
    },
  );

  authTest(
    "a token typed into the form connects and survives a reload",
    async ({ page, coordinatorUrl }) => {
      const token = await mintAgentToken("e2e-dashboard-typist");
      await page.goto(`${coordinatorUrl}/dashboard/`);
      await page.locator("#token-input").fill(token);
      await page.locator("#token-form button[type=submit]").click();

      await expect(page.locator("#conn-status")).toContainText("Connecté");
      await expect(page.locator("#token-form")).toBeHidden();

      await page.reload();
      await expect(page.locator("#conn-status")).toContainText("Connecté");
      await expect(page.locator("#token-form")).toBeHidden();
    },
  );

  authTest(
    "a rejected token brings the form back with an error",
    async ({ page, coordinatorUrl }) => {
      await page.goto(`${coordinatorUrl}/dashboard/#token=not-a-valid-jwt`);
      await expect(page.locator("#token-form")).toBeVisible();
      await expect(page.locator("#token-error")).toContainText("refusé");
      await expect(page.locator("#conn-status")).toContainText("Déconnecté");
    },
  );

  authTest(
    "the token never appears in a request URL, the event stream included",
    async ({ page, coordinatorUrl }) => {
      // Reverse proxies log the full path with its query string (Envoy's
      // x-envoy-origin-path does), so `?token=` would copy a long-lived
      // credential into access logs. The fragment itself is never sent.
      const token = await mintAgentToken("e2e-dashboard-no-url");
      const queries: string[] = [];
      page.on("request", (r) => queries.push(new URL(r.url()).search));
      await page.goto(`${coordinatorUrl}/dashboard/#token=${token}`);
      await expect(page.locator("#conn-status")).toContainText("Connecté");
      expect(queries.filter((q) => q.includes(token))).toEqual([]);
    },
  );

  authTest(
    "a malformed #token= fragment is dropped instead of killing the page",
    async ({ page, coordinatorUrl }) => {
      // "%zz" makes decodeURIComponent throw; uncaught, it would abort the
      // whole script and leave a page with no form and no handlers.
      await page.goto(`${coordinatorUrl}/dashboard/#token=%zz`);
      await expect(page.locator("#token-form")).toBeVisible();
      expect(page.url()).not.toContain("token=");
    },
  );

  authTest(
    "a 401 answering a request sent before the form was submitted does not wipe the new token",
    async ({ page, coordinatorUrl }) => {
      // Hold the page's first /api/scoring-stats call (sent at load, with no
      // token) until a valid token has been submitted, then let its 401 land.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let first = true;
      await page.route("**/api/scoring-stats*", async (route) => {
        if (!first) return route.continue();
        first = false;
        await held;
        await route.continue();
      });

      await page.goto(`${coordinatorUrl}/dashboard/`);
      await expect(page.locator("#token-form")).toBeVisible();
      await page.locator("#token-input").fill(await mintAgentToken("e2e-dashboard-race"));
      await page.locator("#token-form button[type=submit]").click();
      await expect(page.locator("#conn-status")).toContainText("Connecté");

      const stale = page.waitForResponse(
        (r) => r.url().includes("/api/scoring-stats") && r.status() === 401,
      );
      release();
      await stale;
      // Let the page's response handler run before asserting it changed nothing.
      await page.waitForTimeout(300);
      await expect(page.locator("#token-form")).toBeHidden();
      await expect(page.locator("#conn-status")).toContainText("Connecté");
    },
  );
});
