import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockGithub, type MockGithub } from "./mock-github-server.js";

/**
 * Coordinator fixture for Playwright E2E tests.
 *
 * Per-test scope:
 *   1. Spawn a mock GitHub HTTP listener (random port).
 *   2. Pick a free port for the coordinator (let the OS assign via 0).
 *      Playwright's expect.poll waits for /livez to return 200.
 *   3. spawn(`tsx src/serve-http.ts`) with Phase 2 env vars + the mock
 *      URLs. MQTT runs on a random port too so multiple coordinators
 *      can coexist in CI.
 *   4. Yield { coordinatorUrl, mockGithub } to the test.
 *   5. Tear down: SIGTERM → wait for exit → close mock → rm data dir.
 *
 * Tradeoffs vs. an in-process import of startServer():
 *   + True process boundary exposes env-var bugs we'd miss in a hot test.
 *   + Matches the v0.8.1-P2 deployment shape exactly.
 *   - ~1-2s per test for boot. Acceptable for 3 scenarios (target <60s CI).
 */

// Resolve repo root from this file's location: tests/e2e/helpers/ → ../../../
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..", "..");

const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

export interface CoordinatorFixtures {
  coordinatorUrl: string;
  mockGithub: MockGithub;
}

/**
 * Find a free TCP port by listening on 0 and reading the assigned port.
 * Node guarantees the port is unbound between close() and the caller's
 * spawn() if no other process races in — acceptable for tests.
 */
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

export const coordinatorFixture = base.extend<CoordinatorFixtures>({
  mockGithub: async ({}, use) => {
    const mock = await startMockGithub();
    await use(mock);
    await mock.close();
  },

  coordinatorUrl: async ({ mockGithub }, use) => {
    const port = await findFreePort();
    const mqttPort = await findFreePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-e2e-"));
    // Use "localhost" rather than 127.0.0.1: Chromium treats localhost as
    // a "secure context" and accepts __Host- (Secure) cookies over plain
    // http://, but does NOT extend that allowance to numeric loopback IPs.
    // Without this, the __Host-coordinator_session cookie set by the
    // OAuth callback would be silently dropped by the browser.
    const coordinatorUrl = `http://localhost:${port}`;

    // base64url-encoded 32-byte secret — meets the >=128-bit entropy gate
    // enforced by src/auth/entropy.ts (boot will reject anything weaker).
    const jwtSecret = randomBytes(32).toString("base64url");

    const child: ChildProcess = spawn("npx", ["tsx", "src/serve-http.ts"], {
      cwd: REPO_ROOT,
      // shell:true so `npx` resolves on Windows (where it's npx.cmd, not npx).
      // Without shell, Node would ENOENT on Windows even though npx is on PATH.
      shell: true,
      env: {
        ...process.env,
        PORT: String(port),
        COORDINATOR_OAUTH_ENABLED: "true",
        COORDINATOR_JWT_SECRET: jwtSecret,
        COORDINATOR_GITHUB_CLIENT_ID: "test-client",
        COORDINATOR_GITHUB_CLIENT_SECRET: "test-secret",
        COORDINATOR_GITHUB_ORG: "acme",
        COORDINATOR_PUBLIC_URL: coordinatorUrl,
        COORDINATOR_INSECURE_COOKIES: "true",
        COORDINATOR_GITHUB_AUTH_BASE_URL: mockGithub.authBaseUrl,
        COORDINATOR_GITHUB_API_BASE_URL: mockGithub.apiBaseUrl,
        COORDINATOR_DATA_DIR: dataDir,
        COORDINATOR_MQTT_TCP_PORT: String(mqttPort),
        // Phase-1 secrets — required only when AUTH_ENABLED=true, but we
        // don't enable that; left here as documentation.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Buffer child output so a startup failure produces actionable logs.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    // If the child exits before we've handed off control, surface its output.
    let exited = false;
    child.on("exit", (code, signal) => {
      exited = true;
      if (code !== 0 && code !== null) {
        // eslint-disable-next-line no-console
        console.error(
          `Coordinator child exited early code=${code} signal=${signal}\nSTDOUT:\n${stdoutChunks.join("")}\nSTDERR:\n${stderrChunks.join("")}`,
        );
      }
    });

    try {
      await waitForCoordinator(coordinatorUrl);
    } catch (err) {
      if (!exited && !child.killed) {
        child.kill("SIGTERM");
      }
      const stdoutText = stdoutChunks.join("");
      const stderrText = stderrChunks.join("");
      throw new Error(`${(err as Error).message}\nSTDOUT:\n${stdoutText}\nSTDERR:\n${stderrText}`);
    }

    await use(coordinatorUrl);

    // Teardown: SIGTERM and wait for exit (max 5s) before falling back
    // to SIGKILL. Then remove the tmpdir.
    if (!exited && !child.killed) {
      child.kill("SIGTERM");
      const exitPromise = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      await Promise.race([exitPromise, timeoutPromise]);
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — Windows may still hold a handle if SQLite
      // hasn't fully released. Acceptable for tests.
    }
  },
});

export { expect } from "@playwright/test";
