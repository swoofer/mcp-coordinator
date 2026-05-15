import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Profile {
  base_url?: string;
  client_id?: string;
  /** Path to a tokens.json (custom location per profile). */
  tokens_path?: string;
  /** Other arbitrary string fields preserved. */
  [key: string]: string | undefined;
}

export class ProfileNotFoundError extends Error {
  constructor(public readonly profileName: string, public readonly available: string[]) {
    super(`Profile "${profileName}" not found. Available: ${available.join(", ") || "(none)"}`);
    this.name = "ProfileNotFoundError";
  }
}

export class TomlParseError extends Error {
  constructor(public readonly line: number, public readonly reason: string) {
    super(`config.toml line ${line}: ${reason}`);
    this.name = "TomlParseError";
  }
}

/**
 * Parse a minimal-subset TOML string into a map of profile name -> Profile.
 *
 * Supports ONLY:
 *   [profile.NAME]
 *   key = "value"   (double-quoted strings)
 *   key = 'value'   (single-quoted strings)
 *   # comment
 *   (blank lines)
 *
 * Rejects arrays, nested tables, datetimes, numeric literals, multi-line
 * strings. Errors include the line number for operator troubleshooting.
 */
export function parseProfilesToml(content: string): Record<string, Profile> {
  const profiles: Record<string, Profile> = {};
  let currentProfile: Profile | null = null;
  let currentName: string | null = null;
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let line = lines[i]!;
    // Strip inline comment (only outside quotes; we don't support # inside strings)
    const commentIdx = findUnquotedHash(line);
    if (commentIdx >= 0) line = line.slice(0, commentIdx);
    line = line.trim();
    if (line === "") continue;

    // Section header
    const sectionMatch = line.match(/^\[\s*profile\.([A-Za-z0-9_-]+)\s*\]$/);
    if (sectionMatch) {
      currentName = sectionMatch[1]!;
      currentProfile = profiles[currentName] ?? {};
      profiles[currentName] = currentProfile;
      continue;
    }

    // Reject other table headers (non-profile.X)
    if (line.startsWith("[")) {
      throw new TomlParseError(
        lineNum,
        `unsupported table header: ${line} (only [profile.NAME] supported)`,
      );
    }

    if (!currentProfile) {
      throw new TomlParseError(lineNum, `key=value outside any [profile.NAME] section`);
    }

    // Key = "value" or 'value'
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!kvMatch) {
      throw new TomlParseError(lineNum, `expected key = "value", got: ${line}`);
    }
    const key = kvMatch[1]!;
    const valuePart = kvMatch[2]!;
    const valueMatch = valuePart.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*$/);
    if (!valueMatch) {
      throw new TomlParseError(lineNum, `expected quoted string value, got: ${valuePart}`);
    }
    const value = (valueMatch[1] ?? valueMatch[2])!;
    currentProfile[key] = unescapeTomlString(value);
  }

  // Reference currentName to avoid unused-variable complaints from strict tsc.
  void currentName;

  return profiles;
}

function findUnquotedHash(line: string): number {
  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && inQuote) {
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === "#") return i;
    }
  }
  return -1;
}

function unescapeTomlString(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return "\\" + c; // leave unknown escapes literal
    }
  });
}

export interface LoadProfileOptions {
  /** Profile name. Default: from MCP_COORDINATOR_PROFILE env var, else "default". */
  profileName?: string;
  /** Override config.toml path. Default: ~/.mcp-coordinator/config.toml */
  configPath?: string;
}

/**
 * Load and return one profile from config.toml. Returns null if the
 * config file doesn't exist (operator just isn't using profile config).
 * Throws ProfileNotFoundError if the file exists but the named profile is absent.
 */
export async function loadProfile(opts: LoadProfileOptions = {}): Promise<Profile | null> {
  const configPath =
    opts.configPath ?? path.join(os.homedir(), ".mcp-coordinator", "config.toml");
  const profileName =
    opts.profileName ?? process.env.MCP_COORDINATOR_PROFILE ?? "default";

  let content: string;
  try {
    content = await fs.promises.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const profiles = parseProfilesToml(content);
  const profile = profiles[profileName];
  if (!profile) {
    throw new ProfileNotFoundError(profileName, Object.keys(profiles));
  }
  return profile;
}
