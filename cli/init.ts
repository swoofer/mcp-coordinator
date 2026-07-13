import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync, statSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import Database from "better-sqlite3";
import { bootPhase2 } from "../src/boot.js";
import { ensureConfigDir, loadConfig, saveConfig } from "./config.js";

const CLAUDE_MD_TEMPLATE = `## Coordination via mcp-coordinator

You share a coordinator with other Claude Code sessions on this repo. Use the
\`coordinator\` MCP tools to announce work and resolve conflicts before writing
code.

### How coordination flows (important — read first)

You communicate with the coordinator over MCP (request/response). You do NOT
receive automatic push notifications. To stay aware of what other agents are
doing, you must **poll** at the right moments:

- **Session start** — call \`register_agent\` once.
- **Before any source-file change** — call \`announce_work\`. The response tells
  you immediately if a thread was opened (conflict detected). If yes, react.
- **Before resuming work after a non-trivial pause** (e.g., before a new
  feature, between phases, after returning from a sub-task) — call
  \`coordinator_status\` to see if anyone has posted to threads you're a
  participant in. New posts may need your reply or vote.
- **Anytime you suspect activity** — call \`list_threads\` or
  \`coordinator_status\` to scan for open threads.

If you skip the polling step, you can still write code, but you may miss a
question another agent posted on a thread you opened. The dashboard
(\`http://localhost:3100/dashboard\`) is the human's view of all activity if
you want a quick visual.

### Before any source-file change

1. (Once per session) Call \`register_agent\` with your name and the modules
   you plan to touch.
2. Call \`announce_work\` with:
   - \`subject\`: short description of the change
   - \`target_files\`: files you will modify
   - \`depends_on_files\` (optional): files whose interface you depend on
   - \`target_modules\`: bounded contexts you'll touch
3. **Read the response carefully**. If \`thread_id\` is present, a conflict
   was detected — DO NOT proceed to code. Instead:
   - Call \`get_thread(thread_id)\` to see what other agents have said.
   - Call \`post_to_thread\` with \`type: "context"\` to share your plan and
     constraints.
   - Wait for the other agent to acknowledge. Poll \`get_thread_updates\` or
     \`coordinator_status\` until the thread reaches \`resolving\`.
   - When a resolution is proposed, call \`approve_resolution\` or
     \`contest_resolution\` (with reason).
   - Only proceed to code once the thread is \`resolved\`.
4. After completing a meaningful change, call \`log_action_summary\` to update
   the dashboard timeline.

### Polling for thread updates (the most-missed step)

Whenever you've opened a thread or are a participant in one, the other agents
may post new context. They cannot push to you — you must check. A reasonable
cadence:

- **Whenever you call any other coordinator tool** (announce_work,
  log_action_summary, etc.), spend one extra call on
  \`coordinator_status\` and scan for open threads where the latest message is
  from someone else.
- **Before each major task transition** (finishing one feature, starting the
  next), call \`list_threads\` or \`coordinator_status\` once.

A useful pattern: after every 3-5 file edits, run
\`coordinator_status\` once to confirm no thread you opened is still waiting on
your input.

### Tools you'll reach for most

- \`coordinator_status\` — full system snapshot (agents, threads, files, quota)
- \`announce_work\` / \`post_to_thread\` / \`approve_resolution\` /
  \`contest_resolution\` — consultation flow
- \`get_thread_updates\` — fetch only new posts since a timestamp
- \`hot_files\` — files multiple agents are editing
- \`check_file_conflict\` — quick check before opening a file

If you want push-based coordination (real-time interrupts between agent
turns instead of polling), see [essaim](https://github.com/swoofer/essaim) —
it ships an agent-loop wrapper that subscribes to the coordinator's MQTT
broker and injects events into your turn flow automatically.
`;

export function createInitCommand(): Command {
  const cmd = new Command("init")
    .description(
      "First-time setup: create the config dir, write a default config.json, and print a .mcp.json snippet for your MCP client",
    )
    .option(
      "--url <url>",
      "Coordinator URL to use in the printed .mcp.json snippet (defaults to http://localhost:<port>/mcp)",
    )
    .option(
      "--write-mcp-config <path>",
      "Write the .mcp.json snippet into <path>/.mcp.json (merges if the file already exists). <path> must be an existing directory.",
    )
    .option(
      "--write-claude-md <path>",
      "Write a sample CLAUDE.md (system instructions for your coordinator-aware agent) into <path>/CLAUDE.md (merges with existing — appends a clearly-marked section). <path> must be an existing directory.",
    )
    .action((opts: { url?: string; writeMcpConfig?: string; writeClaudeMd?: string }) => {
      const dir = ensureConfigDir();
      console.log(`Config directory: ${dir}`);

      // loadConfig() throws on a malformed existing config.json (see #108).
      // For init that's a UX regression: init's whole job is to write a
      // fresh config, so a corrupt existing file should be exactly what
      // init recovers from -- not a blocker. We wrap with a try/catch
      // here, warn on stderr, and fall back to the same defaults
      // cli/config.ts uses internally. The throw in cli/config.ts is
      // preserved (correct contract for server/start, encryption/migrate,
      // etc. -- those callers should fail loud). See issue #109.
      const DEFAULTS_FOR_INIT = {
        server: { port: 3100, data_dir: join(dir, "data") },
        defaults: { coordinator_url: "http://localhost:3100" },
      };
      const safeLoadConfig = (): ReturnType<typeof loadConfig> => {
        try {
          return loadConfig();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `Warning: existing config.json is malformed and will be overwritten with defaults.\n  ${msg}`,
          );
          return DEFAULTS_FOR_INIT;
        }
      };

      const configPath = join(dir, "config.json");
      if (!existsSync(configPath)) {
        // File doesn't exist -- loadConfig() returns defaults and doesn't
        // throw, but use the safe wrapper defensively (race-safe).
        saveConfig(safeLoadConfig());
        console.log(`Wrote default config:    ${configPath}`);
      } else {
        // File exists -- if it parses, leave it untouched. If it's malformed,
        // recover by overwriting with defaults (#109).
        let parsed = false;
        try {
          loadConfig();
          parsed = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `Warning: existing config.json is malformed and will be overwritten with defaults.\n  ${msg}`,
          );
        }
        if (parsed) {
          console.log(`Config already exists:   ${configPath} (untouched)`);
        } else {
          saveConfig(DEFAULTS_FOR_INIT);
          console.log(`Rewrote config.json with defaults: ${configPath}`);
        }
      }

      const config = safeLoadConfig();
      const url = opts.url ?? `http://localhost:${config.server.port}/mcp`;

      const snippet = {
        mcpServers: {
          coordinator: {
            type: "http",
            url,
          },
        },
      };

      const validateDir = (p: string, label: string): string | null => {
        const abs = resolve(p);
        if (!existsSync(abs)) {
          console.error(`Error: ${label} path ${abs} does not exist.`);
          return null;
        }
        const st = statSync(abs);
        if (!st.isDirectory()) {
          console.error(`Error: ${label} path ${abs} is not a directory.`);
          return null;
        }
        return abs;
      };

      let exitCode = 0;

      if (opts.writeMcpConfig) {
        const dirAbs = validateDir(opts.writeMcpConfig, "--write-mcp-config");
        if (!dirAbs) {
          exitCode = 1;
        } else {
          const target = resolve(dirAbs, ".mcp.json");
          let merged: { mcpServers?: Record<string, unknown> } = snippet;
          if (existsSync(target)) {
            try {
              const existing = JSON.parse(readFileSync(target, "utf-8")) as {
                mcpServers?: Record<string, unknown>;
              };
              merged = {
                ...existing,
                mcpServers: {
                  ...(existing.mcpServers ?? {}),
                  coordinator: snippet.mcpServers.coordinator,
                },
              };
            } catch {
              console.warn(`Warning: ${target} is not valid JSON; overwriting`);
            }
          }
          writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");
          console.log(`Wrote MCP config:        ${target}`);
        }
      }

      if (opts.writeClaudeMd) {
        const dirAbs = validateDir(opts.writeClaudeMd, "--write-claude-md");
        if (!dirAbs) {
          exitCode = 1;
        } else {
          const target = resolve(dirAbs, "CLAUDE.md");
          const SENTINEL = "<!-- mcp-coordinator:coordination-section -->";
          const sectionBody = SENTINEL + "\n" + CLAUDE_MD_TEMPLATE + SENTINEL + "\n";
          let final: string;
          if (existsSync(target)) {
            const existing = readFileSync(target, "utf-8");
            if (existing.includes(SENTINEL)) {
              const re = new RegExp(`${SENTINEL}[\\s\\S]*?${SENTINEL}\\n?`, "g");
              final = existing.replace(re, sectionBody);
              console.log(`Updated CLAUDE.md (replaced existing coordinator section): ${target}`);
            } else {
              const sep = existing.endsWith("\n") ? "\n" : "\n\n";
              final = existing + sep + sectionBody;
              console.log(`Appended coordinator section to CLAUDE.md: ${target}`);
            }
          } else {
            final = "# CLAUDE.md\n\n" + sectionBody;
            console.log(`Wrote CLAUDE.md:         ${target}`);
          }
          writeFileSync(target, final);
        }
      }

      if (!opts.writeMcpConfig && !opts.writeClaudeMd) {
        console.log("");
        console.log("Add this to your MCP client (e.g., ~/.claude/.mcp.json):");
        console.log("");
        console.log(JSON.stringify(snippet, null, 2));
      }

      console.log("");
      console.log("Next steps:");
      console.log("  1. Start the coordinator:  mcp-coordinator server start --daemon");
      console.log("  2. Open the dashboard:     mcp-coordinator dashboard");
      console.log(
        "  3. Connect any MCP client (Claude Code, Cursor, Cline, ...) using the snippet above",
      );
      console.log("  4. Health check:           mcp-coordinator doctor");

      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    });

  cmd.addCommand(createInitPhase2Command());
  return cmd;
}

// ---------------------------------------------------------------------------
// T41: `mcp-coordinator init phase2` — OAuth setup wizard
// ---------------------------------------------------------------------------
//
// Guides operators through the COORDINATOR_* env vars required to flip
// COORDINATOR_OAUTH_ENABLED=true (Phase 2). Writes a `.env` file at the
// target path (chmod 0600 on POSIX) and dry-run-validates the result via
// bootPhase2() so weak/invalid configs are caught here, not on first boot.
//
// The wizard logic is factored into runInitPhase2(io) so tests can inject a
// stubbed WizardIO; the CLI wrapper constructs a real IO from readline + fs.

export interface WizardIO {
  prompt: (question: string, opts?: { default?: string; mask?: boolean }) => Promise<string>;
  confirm: (question: string, opts?: { default?: boolean }) => Promise<boolean>;
  print: (msg: string) => void;
  printError: (msg: string) => void;
  fileExists: (path: string) => boolean;
  writeFile: (path: string, contents: string) => void;
  chmod: (path: string, mode: number) => void;
  // Allows tests to override JWT secret generation deterministically.
  generateJwtSecret: () => string;
  // Allows tests to inject a fake validator (avoids spinning up a real DB
  // for the dry-run boot check). Returns null on success or an error message.
  validateConfig: (env: Record<string, string>) => string | null;
  // Allows tests to assert on exit codes without actually killing the process.
  exit: (code: number) => never;
  isPosix: boolean;
}

export interface Phase2WizardOptions {
  envFile?: string;
  nonInteractive?: boolean;
  publicUrl?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  githubOrg?: string;
}

/**
 * Number of times we re-prompt for PUBLIC_URL on invalid input before
 * giving up. Keeps the wizard from spinning forever in a malformed-stdin
 * loop; 3 is empirically enough for typos.
 */
const PUBLIC_URL_MAX_RETRIES = 3;

const REQUIRED_NONINTERACTIVE_FLAGS: Array<[keyof Phase2WizardOptions, string]> = [
  ["publicUrl", "--public-url"],
  ["githubClientId", "--github-client-id"],
  ["githubClientSecret", "--github-client-secret"],
  ["githubOrg", "--github-org"],
];

export async function runInitPhase2(io: WizardIO, opts: Phase2WizardOptions): Promise<void> {
  const envPath = resolve(opts.envFile ?? ".env");

  // 1. Pre-check: existing .env?
  if (io.fileExists(envPath)) {
    if (opts.nonInteractive) {
      io.printError(
        `[FAIL] ${envPath} already exists. Refusing to overwrite in --non-interactive mode.`,
      );
      io.printError("       Delete or move the file, or omit --non-interactive to be prompted.");
      io.exit(1);
    }
    const overwrite = await io.confirm(`${envPath} already exists. Overwrite?`, { default: false });
    if (!overwrite) {
      io.printError("[FAIL] Aborting — existing .env left untouched.");
      io.exit(1);
    }
  }

  // 2. GitHub OAuth app pre-instructions.
  io.print("");
  io.print("=== mcp-coordinator Phase 2 OAuth setup ===");
  io.print("");
  io.print("Step 1: Create a GitHub OAuth App at:");
  io.print("  https://github.com/settings/applications/new");
  io.print("");
  io.print(
    "  Your callback URL will be `${PUBLIC_URL}/api/auth/oauth/callback` " +
      "— but you need to set PUBLIC_URL first; you'll come back to this.",
  );
  io.print("");

  // 3-4. Resolve PUBLIC_URL (interactive or flag).
  let publicUrl: string;
  if (opts.nonInteractive) {
    publicUrl = opts.publicUrl ?? "";
    const validateMsg = validatePublicUrlString(publicUrl);
    if (validateMsg !== null) {
      io.printError(`[FAIL] --public-url invalid: ${validateMsg}`);
      io.exit(1);
    }
    // Non-interactive http://non-localhost requires the caller to have
    // exported COORDINATOR_INSECURE_COOKIES=true beforehand; we won't
    // prompt for confirmation. We still warn so it shows up in logs.
    if (isInsecurePublicUrl(publicUrl)) {
      io.print(
        "[WARN] PUBLIC_URL uses http:// for a non-localhost host. " +
          "COORDINATOR_INSECURE_COOKIES=true will be required at runtime.",
      );
    }
  } else {
    publicUrl = await promptForValidPublicUrl(io);
  }

  // 4. Print the callback URL the user should paste into the GitHub form.
  const callbackUrl = buildCallbackUrl(publicUrl);
  io.print("");
  io.print("Step 2: Paste this exact URL into the GitHub OAuth app's");
  io.print('        "Authorization callback URL" field:');
  io.print("");
  io.print(`  ${callbackUrl}`);
  io.print("");

  // 5-7. Collect remaining credentials.
  let githubClientId: string;
  let githubClientSecret: string;
  let githubOrg: string;

  if (opts.nonInteractive) {
    const missing: string[] = [];
    for (const [key, flag] of REQUIRED_NONINTERACTIVE_FLAGS) {
      if (!opts[key] || (opts[key] as string).trim() === "") missing.push(flag);
    }
    if (missing.length > 0) {
      io.printError(`[FAIL] --non-interactive requires: ${missing.join(", ")}`);
      io.exit(1);
    }
    githubClientId = (opts.githubClientId as string).trim();
    githubClientSecret = (opts.githubClientSecret as string).trim();
    githubOrg = (opts.githubOrg as string).trim();
  } else {
    githubClientId = await promptNonEmpty(io, "COORDINATOR_GITHUB_CLIENT_ID");
    githubClientSecret = await promptNonEmpty(io, "COORDINATOR_GITHUB_CLIENT_SECRET", {
      mask: true,
    });
    githubOrg = await promptNonEmpty(io, "COORDINATOR_GITHUB_ORG");
  }

  // 8. Generate JWT secret. crypto.randomBytes(32).toString("base64url")
  //    produces a 43-character URL-safe string (256 bits).
  const jwtSecret = io.generateJwtSecret();
  io.print("");
  io.print("=== GENERATED JWT_SECRET (save this; you won't see it again) ===");
  io.print(`  ${jwtSecret}`);
  io.print("================================================================");
  io.print("");

  // 9. Assemble env file. COORDINATOR_INSECURE_COOKIES is intentionally NOT
  //    written automatically — operators must set it explicitly to make the
  //    insecure choice an obvious manual decision.
  const env: Record<string, string> = {
    COORDINATOR_OAUTH_ENABLED: "true",
    COORDINATOR_PUBLIC_URL: publicUrl,
    COORDINATOR_GITHUB_CLIENT_ID: githubClientId,
    COORDINATOR_GITHUB_CLIENT_SECRET: githubClientSecret,
    COORDINATOR_GITHUB_ORG: githubOrg,
    COORDINATOR_JWT_SECRET: jwtSecret,
  };

  // 10. Dry-run validation. validateConfig either returns null (OK) or an
  //     error string. We do this BEFORE writing so a bad config doesn't
  //     leave a stale .env on disk.
  const validationError = io.validateConfig(env);
  if (validationError !== null) {
    io.printError(`[FAIL] Generated config failed validation: ${validationError}`);
    io.printError("       No .env file was written.");
    io.exit(1);
  }

  // 11. Write the file.
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const contents = lines.join("\n") + "\n";
  io.writeFile(envPath, contents);
  if (io.isPosix) {
    io.chmod(envPath, 0o600);
  }

  io.print(
    `[OK] Wrote ${envPath} (${lines.length} variables)${io.isPosix ? " with mode 0600" : ""}`,
  );
  io.print("");
  io.print("=== Next steps ===");
  io.print("  1. Start coordinator: `mcp-coordinator server start`");
  io.print(`  2. Visit ${publicUrl}/auth/login in a browser to sign in via GitHub.`);
  io.print("     The FIRST user to sign in becomes admin.");
  io.print("");
}

/**
 * Build the OAuth callback URL from PUBLIC_URL, handling trailing slashes
 * idempotently. Tested standalone in init-phase2.test.ts (case 10).
 */
export function buildCallbackUrl(publicUrl: string): string {
  const trimmed = publicUrl.replace(/\/+$/, "");
  return `${trimmed}/api/auth/oauth/callback`;
}

/**
 * Returns null on valid PUBLIC_URL, or a human-readable error string. Mirrors
 * validatePublicUrl() in src/boot.ts but defers the insecure-cookies check
 * to the caller (interactive mode prompts to confirm; non-interactive warns).
 */
export function validatePublicUrlString(url: string): string | null {
  if (!url || url.trim() === "") return "value is empty";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a valid URL: ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `must be http:// or https://, got ${parsed.protocol}`;
  }
  return null;
}

/**
 * True if scheme is http and host is not localhost. Triggers the
 * COORDINATOR_INSECURE_COOKIES confirmation flow.
 */
export function isInsecurePublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]";
  } catch {
    return false;
  }
}

async function promptForValidPublicUrl(io: WizardIO): Promise<string> {
  for (let attempt = 0; attempt < PUBLIC_URL_MAX_RETRIES; attempt++) {
    const raw = await io.prompt(
      "COORDINATOR_PUBLIC_URL (e.g., http://localhost:3100 or https://coord.acme.example)",
    );
    const err = validatePublicUrlString(raw);
    if (err !== null) {
      io.printError(`[WARN] ${err}`);
      continue;
    }
    if (isInsecurePublicUrl(raw)) {
      io.print(
        "[WARN] You used http:// for a non-localhost host. Cookies cannot be Secure-flagged,",
      );
      io.print("       which means session cookies will be visible to network attackers (MITM).");
      io.print(
        "       You MUST set COORDINATOR_INSECURE_COOKIES=true in your environment for boot to succeed.",
      );
      const ok = await io.confirm("Proceed anyway?", { default: false });
      if (!ok) continue;
    }
    return raw;
  }
  io.printError(
    `[FAIL] PUBLIC_URL still invalid after ${PUBLIC_URL_MAX_RETRIES} attempts; aborting.`,
  );
  io.exit(1);
}

async function promptNonEmpty(
  io: WizardIO,
  label: string,
  opts: { mask?: boolean } = {},
): Promise<string> {
  for (let attempt = 0; attempt < PUBLIC_URL_MAX_RETRIES; attempt++) {
    const val = await io.prompt(label, { mask: opts.mask });
    if (val.trim() !== "") return val.trim();
    io.printError(`[WARN] ${label} cannot be empty.`);
  }
  io.printError(`[FAIL] ${label} not provided after ${PUBLIC_URL_MAX_RETRIES} attempts; aborting.`);
  io.exit(1);
}

/**
 * Build the production WizardIO from readline + fs + a real dry-run boot.
 */
export function makeDefaultWizardIO(): WizardIO {
  return {
    prompt: defaultPrompt,
    confirm: defaultConfirm,
    print: (msg) => {
      console.log(msg);
    },
    printError: (msg) => {
      console.error(msg);
    },
    fileExists: (p) => existsSync(p),
    writeFile: (p, c) => writeFileSync(p, c),
    chmod: (p, m) => {
      chmodSync(p, m);
    },
    generateJwtSecret: () => randomBytes(32).toString("base64url"),
    validateConfig: defaultValidateConfig,
    exit: (code) => {
      process.exit(code);
    },
    isPosix: process.platform !== "win32",
  };
}

async function defaultPrompt(
  question: string,
  opts?: { default?: string; mask?: boolean },
): Promise<string> {
  // Password masking via stdin is not portable across platforms (tty raw mode
  // is needed and breaks under non-tty harnesses). MVP echoes input
  // regardless; operators paste from a secure source.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolveP) => {
      const display = opts?.default ? `${question} [${opts.default}]: ` : `${question}: `;
      rl.question(display, (answer) => {
        resolveP(answer.trim() || opts?.default || "");
      });
    });
  } finally {
    rl.close();
  }
}

async function defaultConfirm(question: string, opts?: { default?: boolean }): Promise<boolean> {
  const def = opts?.default ?? false;
  const suffix = def ? "[Y/n]" : "[y/N]";
  const ans = await defaultPrompt(`${question} ${suffix}`);
  if (ans === "") return def;
  const lower = ans.toLowerCase();
  if (lower === "y" || lower === "yes") return true;
  if (lower === "n" || lower === "no") return false;
  return def;
}

/**
 * Default validator: spins up an in-memory DB, copies env into process.env
 * temporarily, calls bootPhase2() to leverage the production validation
 * surface (entropy check, URL format, NR12 logic). Restores env on return.
 */
function defaultValidateConfig(env: Record<string, string>): string | null {
  // Spins up an in-memory better-sqlite3 with the minimal schema bootPhase2
  // touches, then re-uses the production validation surface. Tests inject a
  // stub validator and skip this code path entirely.
  try {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        allowlist_github_org TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        token_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
      );
    `);
    const snapshot: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) snapshot[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      bootPhase2({ enabled: true, db });
      return null;
    } finally {
      for (const [k, v] of Object.entries(snapshot)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function createInitPhase2Command(): Command {
  return new Command("phase2")
    .description("Bootstrap a Phase 2 OAuth deployment (writes .env, validates, prints next steps)")
    .option("--env-file <path>", "Output env file path (default: .env)", ".env")
    .option("--non-interactive", "Use flags instead of interactive prompts")
    .option("--public-url <url>", "COORDINATOR_PUBLIC_URL value (required in --non-interactive)")
    .option("--github-client-id <id>", "COORDINATOR_GITHUB_CLIENT_ID value")
    .option("--github-client-secret <secret>", "COORDINATOR_GITHUB_CLIENT_SECRET value")
    .option("--github-org <org>", "COORDINATOR_GITHUB_ORG value")
    .action(async (opts: Phase2WizardOptions) => {
      const io = makeDefaultWizardIO();
      try {
        await runInitPhase2(io, opts);
      } catch (e) {
        io.printError(`[FAIL] ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
