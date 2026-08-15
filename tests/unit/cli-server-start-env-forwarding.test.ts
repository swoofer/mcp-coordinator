import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildDaemonEnv } from "../../cli/server/start.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const START_FILE = join(__dirname, "..", "..", "cli", "server", "start.ts");
const SRC_DIR = join(__dirname, "..", "..", "src");

const ENC_VARS = [
  "COORDINATOR_ENCRYPTION_KEY",
  "COORDINATOR_ALLOW_TOKEN_LOSS",
  "COORDINATOR_TOKEN_LOSS_CONFIRM",
  "COORDINATOR_ALLOW_KEY_ROTATION",
] as const;

// architecture-05: Phase 2 / OAuth / bind / rotation / SSE-tuning vars that
// were previously MISSING from the daemon allowlist, causing OAuth (and
// COORDINATOR_BIND) to be silently disabled whenever the server was started
// with `--daemon`. This list was established by an authoritative grep of
// `process.env.COORDINATOR_*` AND `env.COORDINATOR_*` (boot.ts's injectable-
// env pattern) across src/ — see task-arch05-brief.md.
const PHASE2_VARS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_BIND",
  "COORDINATOR_INSECURE_COOKIES",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_GITHUB_ORG",
  "COORDINATOR_GITHUB_AUTH_BASE_URL",
  "COORDINATOR_GITHUB_API_BASE_URL",
  "COORDINATOR_GOOGLE_CLIENT_ID",
  "COORDINATOR_GOOGLE_CLIENT_SECRET",
  "COORDINATOR_GITHUB_APP_CLIENT_ID",
  "COORDINATOR_GITHUB_APP_CLIENT_SECRET",
  "COORDINATOR_GITHUB_APP_NAME",
  "COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE",
  "COORDINATOR_OIDC_ISSUER_URL",
  "COORDINATOR_OIDC_CLIENT_ID",
  "COORDINATOR_OIDC_CLIENT_SECRET",
  "COORDINATOR_OIDC_GROUPS_CLAIM",
  "COORDINATOR_JWT_PREV_SECRET",
  "COORDINATOR_JWT_SECRET_PREV",
  "COORDINATOR_JWT_SECRET_PREV_ROTATED_AT",
  "COORDINATOR_ALLOW_RESTORE",
  "COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES",
  "COORDINATOR_ALLOW_RESET",
  "COORDINATOR_MAX_SSE_CLIENTS",
  "COORDINATOR_SSE_HEARTBEAT_MS",
] as const;

const ALL_FORWARDED_COORDINATOR_VARS = [
  "COORDINATOR_AUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_JWT_EXPIRY",
  "COORDINATOR_REGISTRATION_SECRET",
  "COORDINATOR_ADMIN_SECRET",
  "COORDINATOR_MQTT_TCP_PORT",
  "COORDINATOR_MQTT_WS_PATH",
  "COORDINATOR_REPO_ROOT",
  "COORDINATOR_MAX_BODY_BYTES",
  "COORDINATOR_WORKING_FILES_TTL_MIN",
  "COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS",
  "COORDINATOR_LAYER4_SINCE_DAYS",
  "COORDINATOR_LAYER4_MAX_COMMITS",
  "COORDINATOR_LAYER4_REFRESH_INTERVAL_MS",
  "COORDINATOR_LAYER4_RETRY_MS",
  ...ENC_VARS,
  ...PHASE2_VARS,
] as const;

const UNRELATED_SECRET_VARS = ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY"] as const;

const BASE_OPTS = { port: 4477, dataDir: "/tmp/coordinator-data" };

/** Static-source assertions — the cheapest, most robust check that every
 *  var in the allowlist has a matching fwd() line and won't silently
 *  regress in a future edit. */
describe("cli/server/start.ts — buildDaemonEnv allowlist (source-level)", () => {
  const source = readFileSync(START_FILE, "utf8");

  for (const v of [...ENC_VARS, ...PHASE2_VARS]) {
    it(`forwards ${v} via fwd()`, () => {
      const needle = `fwd("${v}", parentEnv.${v})`;
      expect(source).toContain(needle);
    });
  }

  it("fwd('COORDINATOR_*', ...) count matches the expected total (existing + Phase 3 + Phase 2/OAuth)", () => {
    const matches = source.match(/fwd\(\s*"COORDINATOR_/g) ?? [];
    // Snapshot lower-bound assumption: must cover at least every var in
    // ALL_FORWARDED_COORDINATOR_VARS. Loose upper bound tolerates future
    // unrelated additions.
    expect(matches.length).toBeGreaterThanOrEqual(ALL_FORWARDED_COORDINATOR_VARS.length);
  });
});

/** R3 — parity check: every `process.env.COORDINATOR_*` / `env.COORDINATOR_*`
 *  read in src/ that represents *operator-facing server config* must be
 *  covered by buildDaemonEnv's allowlist. This proves "vars lues par le
 *  serveur ⊇ vars forwardées au daemon" doesn't regress for the vars this
 *  task cares about (Phase 2 / OAuth / bind / rotation). It intentionally
 *  does NOT assert full-equality with every grep hit in src/, since some
 *  hits are non-operator internals (e.g. computed defaults) — see the
 *  task report for the full enumeration + exclusions. */
describe("cli/server/start.ts — grep-authoritative Phase 2 coverage (R3 parity)", () => {
  it("every Phase 2/OAuth/bind/rotation/SSE/guard var actually read in src/ is in the forwarded set", () => {
    // Files that actually read the vars under test (established via the
    // authoritative grep — see task-arch05-brief.md / task-arch05-report.md).
    const SOURCE_FILES = [
      "boot.ts",
      "serve-http.ts",
      "sse-emitter.ts",
      "reset-guard.ts",
      join("auth", "cookies.ts"),
      "boot-orgs-uniqueness.ts",
    ];
    const combined = SOURCE_FILES.map((f) => readFileSync(join(SRC_DIR, f), "utf8")).join("\n");

    for (const v of PHASE2_VARS) {
      // Two access patterns exist in src/: direct `env.VAR` / `process.env.VAR`,
      // and boot.ts's `readRequiredEnv(env, "VAR")` helper (string-literal key).
      const readSomewhere =
        combined.includes(`env.${v}`) ||
        combined.includes(`process.env.${v}`) ||
        combined.includes(`"${v}"`);
      // Every var in PHASE2_VARS must actually be read somewhere in src/
      // (sanity: the list itself must be grep-grounded, not invented).
      expect(readSomewhere, `${v} expected to be read in one of ${SOURCE_FILES.join(", ")}`).toBe(
        true,
      );
    }
  });
});

/** Behavioral assertion — buildDaemonEnv is a pure function, test directly. */
describe("cli/server/start.ts — buildDaemonEnv (behavioral)", () => {
  it("R1 red-turned-green: forwards Phase 2/OAuth/bind vars when set in parentEnv", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      COORDINATOR_OAUTH_ENABLED: "true",
      COORDINATOR_PUBLIC_URL: "https://coordinator.example.com",
      COORDINATOR_BIND: "127.0.0.1",
    };

    const result = buildDaemonEnv(parentEnv, BASE_OPTS);

    expect(result.COORDINATOR_OAUTH_ENABLED).toBe("true");
    expect(result.COORDINATOR_PUBLIC_URL).toBe("https://coordinator.example.com");
    expect(result.COORDINATOR_BIND).toBe("127.0.0.1");
  });

  it("forwards every var in the full Phase 2/OAuth/rotation/SSE allowlist when set", () => {
    const parentEnv: NodeJS.ProcessEnv = {};
    for (const v of PHASE2_VARS) parentEnv[v] = `value-${v}`;

    const result = buildDaemonEnv(parentEnv, BASE_OPTS);

    for (const v of PHASE2_VARS) {
      expect(result[v]).toBe(`value-${v}`);
    }
  });

  it("omits Phase 2/OAuth/rotation/SSE vars when unset in parentEnv", () => {
    const result = buildDaemonEnv({}, BASE_OPTS);
    for (const v of PHASE2_VARS) {
      expect(result).not.toHaveProperty(v);
    }
  });

  it("forwards each Phase 3 encryption env var when set in the parent process", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      COORDINATOR_ENCRYPTION_KEY: "test-key-value",
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_5_ROWS",
      COORDINATOR_ALLOW_KEY_ROTATION: "1",
    };

    const result = buildDaemonEnv(parentEnv, BASE_OPTS);

    expect(result.COORDINATOR_ENCRYPTION_KEY).toBe("test-key-value");
    expect(result.COORDINATOR_ALLOW_TOKEN_LOSS).toBe("1");
    expect(result.COORDINATOR_TOKEN_LOSS_CONFIRM).toBe("I_UNDERSTAND_THIS_NULLS_5_ROWS");
    expect(result.COORDINATOR_ALLOW_KEY_ROTATION).toBe("1");
  });

  it("omits each Phase 3 encryption env var when unset in the parent process", () => {
    const result = buildDaemonEnv({}, BASE_OPTS);
    for (const v of ENC_VARS) {
      expect(result).not.toHaveProperty(v);
    }
  });

  it("R5 (1/2): COORDINATOR_OAUTH_ENABLED=true is transmitted to the daemon — no more silent disable", () => {
    const parentEnv: NodeJS.ProcessEnv = { COORDINATOR_OAUTH_ENABLED: "true" };
    const result = buildDaemonEnv(parentEnv, BASE_OPTS);
    expect(result.COORDINATOR_OAUTH_ENABLED).toBe("true");
  });

  it("R5 (2/2) + security non-regression: unrelated secrets are NEVER forwarded, even if named similarly or present in parentEnv", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      COORDINATOR_OAUTH_ENABLED: "true",
    };
    for (const v of UNRELATED_SECRET_VARS) parentEnv[v] = "leaked-secret-value";

    const result = buildDaemonEnv(parentEnv, BASE_OPTS);

    for (const v of UNRELATED_SECRET_VARS) {
      expect(result).not.toHaveProperty(v);
    }
  });

  it("always sets the base env (PATH/HOME/PORT/COORDINATOR_DATA_DIR) regardless of allowlisted vars", () => {
    const result = buildDaemonEnv(
      { PATH: "/usr/bin", HOME: "/home/op" },
      { port: 9999, dataDir: "/data" },
    );
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/op");
    expect(result.PORT).toBe("9999");
    expect(result.COORDINATOR_DATA_DIR).toBe("/data");
  });
});

/** Integration — the real daemon spawn() call passes
 *  `env: buildDaemonEnv(process.env, {port, dataDir})`. Exercise the actual
 *  Commander action with a mocked spawn + filesystem and assert the
 *  constructed childEnv end-to-end. */
describe("cli/server/start.ts — daemon-spawn env forwarding (integration)", () => {
  const envSnapshot: Record<string, string | undefined> = {};
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let openSyncMock: ReturnType<typeof vi.fn>;
  let writeFileSyncMock: ReturnType<typeof vi.fn>;

  const TRACKED_VARS = [...ENC_VARS, ...PHASE2_VARS, ...UNRELATED_SECRET_VARS];

  beforeEach(() => {
    for (const v of TRACKED_VARS) {
      envSnapshot[v] = process.env[v];
      delete process.env[v];
    }
    envSnapshot.PORT = process.env.PORT;
    envSnapshot.COORDINATOR_DATA_DIR = process.env.COORDINATOR_DATA_DIR;

    spawnMock = vi.fn().mockReturnValue({
      pid: 12345,
      unref: () => {},
    });
    // issue #273: the daemon path now waits for the child to accept a
    // connection before reporting success. `spawn` is mocked here, so
    // nothing will ever listen on 3199 — collapse the window rather than
    // sit through the real one.
    envSnapshot.COORDINATOR_DAEMON_BIND_TIMEOUT_MS = process.env.COORDINATOR_DAEMON_BIND_TIMEOUT_MS;
    process.env.COORDINATOR_DAEMON_BIND_TIMEOUT_MS = "50";
    openSyncMock = vi.fn().mockReturnValue(3);
    writeFileSyncMock = vi.fn();

    vi.doMock("child_process", () => ({ spawn: spawnMock }));
    // The action imports fs dynamically for openSync; preserve the rest of fs.
    vi.doMock("fs", async () => {
      const real = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...real,
        openSync: openSyncMock,
        writeFileSync: writeFileSyncMock,
        unlinkSync: real.unlinkSync,
      };
    });

    // process.exit short-circuits the action; surface as a known throw.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__process_exit_called__");
    }) as never);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    exitSpy.mockRestore();
    vi.doUnmock("child_process");
    vi.doUnmock("fs");
    vi.resetModules();
  });

  async function runDaemon(): Promise<void> {
    // Re-import so mocks resolve fresh.
    const mod = await import("../../cli/server/start.js");
    const cmd = mod.createServerStartCommand();
    try {
      await cmd.parseAsync(["node", "start", "--daemon", "--port", "3199"]);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__process_exit_called__") {
        throw e;
      }
    }
  }

  it("forwards COORDINATOR_OAUTH_ENABLED + COORDINATOR_PUBLIC_URL + COORDINATOR_BIND set in the real parent process through the real spawn() call", async () => {
    process.env.COORDINATOR_OAUTH_ENABLED = "true";
    process.env.COORDINATOR_PUBLIC_URL = "https://coordinator.example.com";
    process.env.COORDINATOR_BIND = "127.0.0.1";

    await runDaemon();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    expect(spawnOpts.env.COORDINATOR_OAUTH_ENABLED).toBe("true");
    expect(spawnOpts.env.COORDINATOR_PUBLIC_URL).toBe("https://coordinator.example.com");
    expect(spawnOpts.env.COORDINATOR_BIND).toBe("127.0.0.1");
  });

  it("does not leak unrelated secrets (AWS/GITHUB_TOKEN/OPENAI) through the real spawn() call", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "leaked";
    process.env.GITHUB_TOKEN = "leaked";
    process.env.OPENAI_API_KEY = "leaked";

    await runDaemon();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    for (const v of UNRELATED_SECRET_VARS) {
      expect(spawnOpts.env).not.toHaveProperty(v);
    }
  });
});
