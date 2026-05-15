import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  parseProfilesToml,
  loadProfile,
  ProfileNotFoundError,
  TomlParseError,
} from "../src/profiles.js";

describe("parseProfilesToml", () => {
  it("parses a single profile with two fields", () => {
    const out = parseProfilesToml(
      `[profile.default]\nbase_url = "https://a.example"\nclient_id = "cli_abc"\n`,
    );
    expect(out).toEqual({
      default: { base_url: "https://a.example", client_id: "cli_abc" },
    });
  });

  it("parses multiple profiles", () => {
    const out = parseProfilesToml(
      `
[profile.default]
base_url = "https://dev.example"

[profile.prod]
base_url = "https://prod.example"
client_id = "cli_prod"
`,
    );
    expect(Object.keys(out).sort()).toEqual(["default", "prod"]);
    expect(out.default!.base_url).toBe("https://dev.example");
    expect(out.prod!.client_id).toBe("cli_prod");
  });

  it("handles single-quoted string values", () => {
    const out = parseProfilesToml(`[profile.x]\nbase_url = 'https://a.example'\n`);
    expect(out.x!.base_url).toBe("https://a.example");
  });

  it("handles inline # comments", () => {
    const out = parseProfilesToml(
      `[profile.x]\nbase_url = "https://a.example" # default endpoint\n`,
    );
    expect(out.x!.base_url).toBe("https://a.example");
  });

  it("does NOT treat # inside quoted strings as comment", () => {
    const out = parseProfilesToml(`[profile.x]\nclient_id = "abc#def"\n`);
    expect(out.x!.client_id).toBe("abc#def");
  });

  it("rejects unknown table header with TomlParseError + line number", () => {
    let caught: unknown;
    try {
      parseProfilesToml(`[profile.default]\nbase_url = "x"\n[server]\nport = 8080\n`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TomlParseError);
    expect((caught as TomlParseError).line).toBe(3);
    expect((caught as TomlParseError).reason).toContain("unsupported table header");
  });

  it("rejects key=value outside any section with TomlParseError", () => {
    let caught: unknown;
    try {
      parseProfilesToml(`base_url = "x"\n[profile.default]\n`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TomlParseError);
    expect((caught as TomlParseError).line).toBe(1);
  });

  it("rejects unquoted value with TomlParseError", () => {
    let caught: unknown;
    try {
      parseProfilesToml(`[profile.default]\nbase_url = https://a.example\n`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TomlParseError);
    expect((caught as TomlParseError).line).toBe(2);
    expect((caught as TomlParseError).reason).toContain("quoted string");
  });

  it("handles TOML escape sequences (\\n, \\t, \\\")", () => {
    const out = parseProfilesToml(`[profile.x]\nlabel = "a\\nb\\tc\\"d"\n`);
    expect(out.x!.label).toBe('a\nb\tc"d');
  });

  it("allows blank lines between sections + entries", () => {
    const out = parseProfilesToml(
      `\n\n[profile.default]\n\nbase_url = "https://a.example"\n\n\n`,
    );
    expect(out.default!.base_url).toBe("https://a.example");
  });
});

describe("loadProfile", () => {
  let tmpDir: string;
  let configPath: string;
  const ORIG_ENV = process.env.MCP_COORDINATOR_PROFILE;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mcp-profiles-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
    configPath = path.join(tmpDir, "config.toml");
    delete process.env.MCP_COORDINATOR_PROFILE;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
    if (ORIG_ENV === undefined) {
      delete process.env.MCP_COORDINATOR_PROFILE;
    } else {
      process.env.MCP_COORDINATOR_PROFILE = ORIG_ENV;
    }
  });

  it("returns null when config.toml doesn't exist", async () => {
    const result = await loadProfile({ configPath });
    expect(result).toBeNull();
  });

  it("returns the named profile when present", async () => {
    await fs.promises.writeFile(
      configPath,
      `[profile.default]\nbase_url = "https://dev.example"\n\n[profile.prod]\nbase_url = "https://prod.example"\n`,
    );
    const result = await loadProfile({ configPath, profileName: "prod" });
    expect(result?.base_url).toBe("https://prod.example");
  });

  it("throws ProfileNotFoundError with available list when profile missing", async () => {
    await fs.promises.writeFile(
      configPath,
      `[profile.default]\nbase_url = "https://dev.example"\n[profile.staging]\nbase_url = "https://staging.example"\n`,
    );
    let caught: unknown;
    try {
      await loadProfile({ configPath, profileName: "prod" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProfileNotFoundError);
    expect((caught as ProfileNotFoundError).available.sort()).toEqual(["default", "staging"]);
    expect((caught as ProfileNotFoundError).profileName).toBe("prod");
  });

  it("defaults to 'default' profile when no env var and no opt.profileName", async () => {
    await fs.promises.writeFile(
      configPath,
      `[profile.default]\nbase_url = "https://dev.example"\n`,
    );
    const result = await loadProfile({ configPath });
    expect(result?.base_url).toBe("https://dev.example");
  });

  it("honors MCP_COORDINATOR_PROFILE env var", async () => {
    await fs.promises.writeFile(
      configPath,
      `[profile.default]\nbase_url = "https://dev.example"\n[profile.staging]\nbase_url = "https://staging.example"\n`,
    );
    process.env.MCP_COORDINATOR_PROFILE = "staging";
    const result = await loadProfile({ configPath });
    expect(result?.base_url).toBe("https://staging.example");
  });

  it("opts.profileName beats env var", async () => {
    await fs.promises.writeFile(
      configPath,
      `[profile.default]\nbase_url = "https://dev.example"\n[profile.staging]\nbase_url = "https://staging.example"\n[profile.prod]\nbase_url = "https://prod.example"\n`,
    );
    process.env.MCP_COORDINATOR_PROFILE = "staging";
    const result = await loadProfile({ configPath, profileName: "prod" });
    expect(result?.base_url).toBe("https://prod.example");
  });
});
