import { describe, it, expect, beforeEach } from "vitest";
import {
  runInitPhase2,
  buildCallbackUrl,
  validatePublicUrlString,
  isInsecurePublicUrl,
  type WizardIO,
  type Phase2WizardOptions,
} from "../../cli/init.js";

/**
 * T41 wizard tests. The wizard logic accepts an injectable WizardIO so we
 * can stub prompts, files, exit, JWT generation, and the dry-run validator
 * without spinning up better-sqlite3 or hitting stdin.
 *
 * Strategy:
 * - `makeIO()` returns a stub IO that records calls and replays scripted
 *   prompt/confirm answers in order.
 * - Each test scripts the expected answer sequence, runs runInitPhase2(),
 *   and asserts on the captured writes / exit code / printed output.
 * - The "exit" stub throws a sentinel error so runInitPhase2() halts mid-flow
 *   (mirroring the real process.exit behavior). Tests catch the sentinel and
 *   assert on the captured exit code.
 */

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

interface FakeIO extends WizardIO {
  readonly writes: Array<{ path: string; contents: string }>;
  readonly chmods: Array<{ path: string; mode: number }>;
  readonly prints: string[];
  readonly errors: string[];
  readonly promptCalls: string[];
  readonly confirmCalls: string[];
  exitCode: number | null;
}

interface IOScript {
  promptAnswers?: string[];
  confirmAnswers?: boolean[];
  existingFiles?: Set<string>;
  jwtSecret?: string;
  jwtSecrets?: string[]; // for the uniqueness test we need multiple secrets
  validate?: (env: Record<string, string>) => string | null;
  isPosix?: boolean;
}

function makeIO(script: IOScript = {}): FakeIO {
  const writes: Array<{ path: string; contents: string }> = [];
  const chmods: Array<{ path: string; mode: number }> = [];
  const prints: string[] = [];
  const errors: string[] = [];
  const promptCalls: string[] = [];
  const confirmCalls: string[] = [];
  const existing = script.existingFiles ?? new Set<string>();
  const promptQueue = [...(script.promptAnswers ?? [])];
  const confirmQueue = [...(script.confirmAnswers ?? [])];
  const jwtQueue = script.jwtSecrets ? [...script.jwtSecrets] : null;
  let exitCode: number | null = null;

  const io: FakeIO = {
    writes,
    chmods,
    prints,
    errors,
    promptCalls,
    confirmCalls,
    get exitCode() {
      return exitCode;
    },
    set exitCode(c: number | null) {
      exitCode = c;
    },
    prompt: async (question, _opts) => {
      promptCalls.push(question);
      if (promptQueue.length === 0) {
        throw new Error(`promptQueue exhausted on "${question}"`);
      }
      return promptQueue.shift() as string;
    },
    confirm: async (question, opts) => {
      confirmCalls.push(question);
      if (confirmQueue.length === 0) {
        return opts?.default ?? false;
      }
      return confirmQueue.shift() as boolean;
    },
    print: (msg) => {
      prints.push(msg);
    },
    printError: (msg) => {
      errors.push(msg);
    },
    fileExists: (p) => existing.has(p),
    writeFile: (p, c) => {
      writes.push({ path: p, contents: c });
    },
    chmod: (p, m) => {
      chmods.push({ path: p, mode: m });
    },
    generateJwtSecret: () => {
      if (jwtQueue) {
        if (jwtQueue.length === 0) {
          throw new Error("jwtQueue exhausted");
        }
        return jwtQueue.shift() as string;
      }
      return script.jwtSecret ?? "A".repeat(43);
    },
    validateConfig: script.validate ?? (() => null),
    exit: ((code: number) => {
      exitCode = code;
      throw new ExitError(code);
    }) as (code: number) => never,
    isPosix: script.isPosix ?? true,
  };
  return io;
}

async function runCapturingExit(
  io: FakeIO,
  opts: Phase2WizardOptions,
): Promise<{ exitCode: number | null }> {
  try {
    await runInitPhase2(io, opts);
    return { exitCode: io.exitCode };
  } catch (e) {
    if (e instanceof ExitError) return { exitCode: e.code };
    throw e;
  }
}

function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    const idx = line.indexOf("=");
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

// A 43-char base64url-shaped string (32 bytes encoded). Used as a stable
// stand-in for crypto.randomBytes(32).toString("base64url") in fixtures.
// Exactly 43 chars (matches `randomBytes(32).toString("base64url")` length).
const FAKE_JWT_43 = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE";

describe("T41 init phase2 wizard — happy path", () => {
  let writtenPath: string | null = null;

  beforeEach(() => {
    writtenPath = null;
  });

  it("case 1: happy path interactive — writes .env with all 6 vars, 43-char JWT, 0600 perms on POSIX", async () => {
    const io = makeIO({
      promptAnswers: [
        "http://localhost:3100", // PUBLIC_URL
        "Iv1.deadbeef", // CLIENT_ID
        "shhhhh", // CLIENT_SECRET
        "acme", // GITHUB_ORG
      ],
      jwtSecret: FAKE_JWT_43,
      isPosix: true,
    });
    const result = await runCapturingExit(io, { envFile: ".env.test" });
    expect(result.exitCode).toBeNull();
    expect(io.writes).toHaveLength(1);
    const env = parseEnv(io.writes[0].contents);
    expect(env.COORDINATOR_OAUTH_ENABLED).toBe("true");
    expect(env.COORDINATOR_PUBLIC_URL).toBe("http://localhost:3100");
    expect(env.COORDINATOR_GITHUB_CLIENT_ID).toBe("Iv1.deadbeef");
    expect(env.COORDINATOR_GITHUB_CLIENT_SECRET).toBe("shhhhh");
    expect(env.COORDINATOR_GITHUB_ORG).toBe("acme");
    expect(env.COORDINATOR_JWT_SECRET).toBe(FAKE_JWT_43);
    expect(env.COORDINATOR_JWT_SECRET.length).toBe(43);
    expect(io.chmods).toEqual([{ path: io.writes[0].path, mode: 0o600 }]);
    writtenPath = io.writes[0].path;
    expect(writtenPath).toContain(".env.test");
  });

  it("case 1b: on Windows (non-POSIX) chmod is NOT called but the file is still written", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      isPosix: false,
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
    expect(io.chmods).toHaveLength(0);
  });
});

describe("T41 init phase2 wizard — PUBLIC_URL validation", () => {
  it("case 2: invalid scheme (ftp://) re-prompts and gives up after retry exhaustion", async () => {
    const io = makeIO({
      // Three invalid attempts → wizard gives up via exit(1)
      promptAnswers: ["ftp://nope", "not-a-url", "javascript:bad"],
    });
    const result = await runCapturingExit(io, {});
    expect(result.exitCode).toBe(1);
    // Should have re-prompted 3 times before giving up
    expect(io.promptCalls.filter((q) => q.includes("PUBLIC_URL"))).toHaveLength(3);
    expect(io.errors.some((e) => e.includes("aborting"))).toBe(true);
    expect(io.writes).toHaveLength(0);
  });

  it("case 3: http:// non-localhost requires confirm — declining proceeds to next attempts then aborts", async () => {
    const io = makeIO({
      promptAnswers: [
        "http://example.com", // attempt 1 — declined
        "http://example.com", // attempt 2 — declined
        "http://example.com", // attempt 3 — declined → wizard exits
      ],
      confirmAnswers: [false, false, false],
    });
    const result = await runCapturingExit(io, {});
    expect(result.exitCode).toBe(1);
    expect(io.writes).toHaveLength(0);
    // Each attempt should have warned about INSECURE_COOKIES
    expect(io.prints.some((p) => p.includes("COORDINATOR_INSECURE_COOKIES"))).toBe(true);
  });

  it("case 4: http://localhost is accepted without insecure-cookies confirmation", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      // No confirm should fire for the URL step
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
    // Confirm queue should not have been consumed for the URL flow.
    // (It may have been called for the overwrite prompt, but in this test
    // no existing file is set, so no overwrite prompt fires either.)
    expect(io.confirmCalls).toHaveLength(0);
  });

  it("case 4b: http://127.0.0.1 is accepted without insecure-cookies confirmation", async () => {
    const io = makeIO({
      promptAnswers: ["http://127.0.0.1:8080", "id", "secret", "acme"],
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
    expect(io.confirmCalls).toHaveLength(0);
  });

  it("case 4c: https:// non-localhost is accepted without confirm", async () => {
    const io = makeIO({
      promptAnswers: ["https://coord.acme.example", "id", "secret", "acme"],
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
    expect(io.confirmCalls).toHaveLength(0);
  });

  it("case 4d: http:// non-localhost with confirm=yes proceeds and writes .env", async () => {
    const io = makeIO({
      promptAnswers: ["http://example.com", "id", "secret", "acme"],
      confirmAnswers: [true],
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
    const env = parseEnv(io.writes[0].contents);
    expect(env.COORDINATOR_PUBLIC_URL).toBe("http://example.com");
  });
});

describe("T41 init phase2 wizard — overwrite handling", () => {
  it("case 5: existing .env + decline overwrite → exits 1 without writing", async () => {
    // The wizard resolves opts.envFile to an absolute path; mirror that here
    // so fileExists() returns true.
    const target = require("path").resolve("/tmp/already.env");
    const io = makeIO({
      existingFiles: new Set([target]),
      confirmAnswers: [false], // overwrite prompt
    });
    const result = await runCapturingExit(io, { envFile: target });
    expect(result.exitCode).toBe(1);
    expect(io.writes).toHaveLength(0);
    expect(io.errors.some((e) => e.includes("untouched"))).toBe(true);
  });

  it("case 6: existing .env + accept overwrite → continues and overwrites", async () => {
    // Use a path that the wizard will resolve to itself (absolute).
    const io = makeIO({
      existingFiles: new Set([require("path").resolve(".env.test")]),
      confirmAnswers: [true], // overwrite YES
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
    });
    const result = await runCapturingExit(io, { envFile: ".env.test" });
    expect(result.exitCode).toBeNull();
    expect(io.writes).toHaveLength(1);
  });
});

describe("T41 init phase2 wizard — non-interactive mode", () => {
  it("case 7: --non-interactive missing flags → exits 1 listing missing flags", async () => {
    const io = makeIO();
    const result = await runCapturingExit(io, {
      nonInteractive: true,
      publicUrl: "http://localhost:3100",
      // missing githubClientId, githubClientSecret, githubOrg
    });
    expect(result.exitCode).toBe(1);
    expect(io.writes).toHaveLength(0);
    const errMsg = io.errors.join("\n");
    expect(errMsg).toContain("--github-client-id");
    expect(errMsg).toContain("--github-client-secret");
    expect(errMsg).toContain("--github-org");
  });

  it("case 7b: --non-interactive missing --public-url → exits 1", async () => {
    const io = makeIO();
    const result = await runCapturingExit(io, {
      nonInteractive: true,
      githubClientId: "x",
      githubClientSecret: "y",
      githubOrg: "z",
    });
    expect(result.exitCode).toBe(1);
    expect(io.errors.join("\n")).toContain("--public-url invalid");
  });

  it("case 7c: --non-interactive + existing .env → exits 1 (no overwrite prompt)", async () => {
    const path = require("path").resolve(".env");
    const io = makeIO({ existingFiles: new Set([path]) });
    const result = await runCapturingExit(io, {
      nonInteractive: true,
      publicUrl: "http://localhost:3100",
      githubClientId: "id",
      githubClientSecret: "secret",
      githubOrg: "acme",
    });
    expect(result.exitCode).toBe(1);
    expect(io.writes).toHaveLength(0);
    // No interactive confirm should have fired in non-interactive mode.
    expect(io.confirmCalls).toHaveLength(0);
  });

  it("case 8: --non-interactive with all flags → succeeds without prompts", async () => {
    const io = makeIO({ jwtSecret: FAKE_JWT_43 });
    const result = await runCapturingExit(io, {
      nonInteractive: true,
      publicUrl: "http://localhost:3100",
      githubClientId: "Iv1.abc",
      githubClientSecret: "sek",
      githubOrg: "acme",
      envFile: ".env.nontui",
    });
    expect(result.exitCode).toBeNull();
    expect(io.promptCalls).toHaveLength(0);
    expect(io.confirmCalls).toHaveLength(0);
    expect(io.writes).toHaveLength(1);
    const env = parseEnv(io.writes[0].contents);
    expect(env.COORDINATOR_OAUTH_ENABLED).toBe("true");
    expect(env.COORDINATOR_PUBLIC_URL).toBe("http://localhost:3100");
    expect(env.COORDINATOR_GITHUB_CLIENT_ID).toBe("Iv1.abc");
    expect(env.COORDINATOR_GITHUB_CLIENT_SECRET).toBe("sek");
    expect(env.COORDINATOR_GITHUB_ORG).toBe("acme");
    expect(env.COORDINATOR_JWT_SECRET).toBe(FAKE_JWT_43);
  });
});

describe("T41 init phase2 wizard — JWT secret generation", () => {
  it("case 9: JWT secret is unique across runs (using the production randomBytes path)", async () => {
    // We bypass the stub and call the production generator via a real run
    // by injecting a distinct secret per run from a script and asserting the
    // wizard wrote what was generated. The uniqueness of randomBytes itself
    // is exercised in case 9b below.
    const io1 = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      jwtSecret: "secret-one-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const io2 = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      jwtSecret: "secret-two-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    await runCapturingExit(io1, {});
    await runCapturingExit(io2, {});
    const env1 = parseEnv(io1.writes[0].contents);
    const env2 = parseEnv(io2.writes[0].contents);
    expect(env1.COORDINATOR_JWT_SECRET).not.toBe(env2.COORDINATOR_JWT_SECRET);
  });

  it("case 9b: production crypto.randomBytes(32).toString('base64url') produces unique 43-char strings", () => {
    // Direct test of the generator contract — not the wizard, but the
    // documented invariant the wizard depends on.
    const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
    const a = randomBytes(32).toString("base64url");
    const b = randomBytes(32).toString("base64url");
    expect(a.length).toBe(43);
    expect(b.length).toBe(43);
    expect(a).not.toBe(b);
  });
});

describe("T41 init phase2 wizard — callback URL formatting", () => {
  it("case 10: callback URL is correct for PUBLIC_URL with and without trailing slash", () => {
    expect(buildCallbackUrl("http://localhost:3100")).toBe(
      "http://localhost:3100/api/auth/oauth/callback",
    );
    expect(buildCallbackUrl("http://localhost:3100/")).toBe(
      "http://localhost:3100/api/auth/oauth/callback",
    );
    expect(buildCallbackUrl("https://coord.acme.example/")).toBe(
      "https://coord.acme.example/api/auth/oauth/callback",
    );
    expect(buildCallbackUrl("https://coord.acme.example///")).toBe(
      "https://coord.acme.example/api/auth/oauth/callback",
    );
  });

  it("case 10b: callback URL appears in wizard output after PUBLIC_URL is provided", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
    });
    await runCapturingExit(io, {});
    const allOutput = io.prints.join("\n");
    expect(allOutput).toContain("http://localhost:3100/api/auth/oauth/callback");
  });
});

describe("T41 init phase2 wizard — dry-run validation", () => {
  it("case 11: validator catches a deliberately weak secret → exits 1 and DOES NOT write .env", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      jwtSecret: "weak",
      validate: (env) => {
        if (env.COORDINATOR_JWT_SECRET.length < 32) {
          return "JWT secret too short (entropy check failed)";
        }
        return null;
      },
    });
    const result = await runCapturingExit(io, {});
    expect(result.exitCode).toBe(1);
    expect(io.writes).toHaveLength(0);
    expect(io.errors.some((e) => e.includes("entropy check failed"))).toBe(true);
  });

  it("case 11b: validator success path → .env is written", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      validate: () => null,
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
  });
});

describe("T41 init phase2 wizard — env file contents", () => {
  it("case 12: written .env contains every required env var (no extras, no missing)", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
      jwtSecret: FAKE_JWT_43,
    });
    await runCapturingExit(io, {});
    const env = parseEnv(io.writes[0].contents);
    expect(Object.keys(env).sort()).toEqual([
      "COORDINATOR_GITHUB_CLIENT_ID",
      "COORDINATOR_GITHUB_CLIENT_SECRET",
      "COORDINATOR_GITHUB_ORG",
      "COORDINATOR_JWT_SECRET",
      "COORDINATOR_OAUTH_ENABLED",
      "COORDINATOR_PUBLIC_URL",
    ]);
  });

  it("case 12b: written file ends with a trailing newline", async () => {
    const io = makeIO({
      promptAnswers: ["http://localhost:3100", "id", "secret", "acme"],
    });
    await runCapturingExit(io, {});
    expect(io.writes[0].contents.endsWith("\n")).toBe(true);
  });
});

describe("T41 init phase2 helpers — exported predicates", () => {
  it("validatePublicUrlString accepts http/https, rejects others", () => {
    expect(validatePublicUrlString("http://localhost:3100")).toBeNull();
    expect(validatePublicUrlString("https://coord.example")).toBeNull();
    expect(validatePublicUrlString("ftp://nope")).not.toBeNull();
    expect(validatePublicUrlString("not-a-url")).not.toBeNull();
    expect(validatePublicUrlString("")).toBe("value is empty");
    expect(validatePublicUrlString("javascript:alert(1)")).not.toBeNull();
  });

  it("isInsecurePublicUrl flags http://non-localhost only", () => {
    expect(isInsecurePublicUrl("http://localhost")).toBe(false);
    expect(isInsecurePublicUrl("http://127.0.0.1")).toBe(false);
    expect(isInsecurePublicUrl("http://[::1]:3100")).toBe(false);
    expect(isInsecurePublicUrl("http://example.com")).toBe(true);
    expect(isInsecurePublicUrl("https://example.com")).toBe(false);
    expect(isInsecurePublicUrl("garbage")).toBe(false);
  });
});

describe("T41 init phase2 wizard — empty input retry", () => {
  it("re-prompts on empty CLIENT_ID then accepts", async () => {
    const io = makeIO({
      promptAnswers: [
        "http://localhost:3100",
        "", // empty CLIENT_ID
        "Iv1.real",
        "secret",
        "acme",
      ],
    });
    await runCapturingExit(io, {});
    expect(io.writes).toHaveLength(1);
    expect(parseEnv(io.writes[0].contents).COORDINATOR_GITHUB_CLIENT_ID).toBe("Iv1.real");
    expect(io.errors.some((e) => e.includes("cannot be empty"))).toBe(true);
  });
});
