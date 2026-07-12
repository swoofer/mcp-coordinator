import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tests-05 — the main dashboard (dashboard/public/index.html, served at
 * /dashboard/) is the product's showcase and had zero e2e coverage before
 * this file.
 *
 * This spec does NOT reuse tests/e2e/helpers/coordinator-fixture.ts's
 * `coordinatorFixture`: that fixture assigns the coordinator an OS-ephemeral
 * port (`findFreePort()`), which is right for the OAuth/admin specs (those
 * pages call relative-ish endpoints reachable regardless of port). The main
 * dashboard's client-side JS, however, hardcodes
 * `const COORDINATOR_URL = 'http://localhost:3100'` in
 * dashboard/public/index.html (no window.location-based origin detection —
 * every fetch()/EventSource call in that file targets port 3100 literally).
 * A random port would leave the dashboard's own JS talking to nothing.
 * `dashboardFixture` below pins PORT=3100 instead so the page's hardcoded
 * calls actually reach this test's coordinator. Tests in this file
 * necessarily run serially against a fixed port (playwright.config.ts
 * already sets workers=1 / fullyParallel=false repo-wide, so this doesn't
 * introduce new contention — just makes explicit why this spec can't share
 * coordinator-fixture.ts's free-port pattern).
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
// See file header: dashboard/public/index.html hardcodes this port.
const DASHBOARD_PORT = 3100;

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

const dashboardFixture = base.extend<DashboardFixtures>({
  // eslint-disable-next-line no-empty-pattern
  coordinatorUrl: async ({}, use) => {
    const mqttPort = await findFreePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-e2e-dash-"));
    const coordinatorUrl = `http://localhost:${DASHBOARD_PORT}`;

    const child: ChildProcess = spawn("npx", ["tsx", "src/serve-http.ts"], {
      cwd: REPO_ROOT,
      // shell:true so `npx` resolves on Windows (npx.cmd, not npx).
      shell: true,
      env: {
        ...process.env,
        PORT: String(DASHBOARD_PORT),
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

const test = dashboardFixture;

test.describe("main dashboard — render", () => {
  test("loads /dashboard/ and renders the core panels", async ({ page, coordinatorUrl }) => {
    await page.goto(`${coordinatorUrl}/dashboard/`);

    await expect(page.locator("h1")).toContainText("MCP Coordinator");
    await expect(page.locator("#conn-status")).toBeVisible();
    await expect(page.locator(".panel-title", { hasText: "Agents en ligne" })).toBeVisible();
    await expect(page.locator("#agents-list")).toBeAttached();
    await expect(page.locator(".panel-title", { hasText: "Timeline" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Clear UI" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Reset Server" })).toBeVisible();

    // Connection status flips from "Connecting..." to "Connecté" once the
    // SSE EventSource opens (es.onopen in index.html) — proves the /api/events
    // stream is actually reachable, not just that the HTML shipped.
    await expect(page.locator("#conn-status")).toContainText("Connecté");
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
      // in dashboard/public/index.html does `if (!confirm(msg)) return;`
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
