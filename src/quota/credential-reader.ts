// OAuth credential access for Claude Code — reads the "Claude Code-credentials"
// secret stored by the Claude Code CLI and extracts the accessToken.
//
// macOS is the only platform with a real implementation; Linux and Windows
// stubs throw NotImplementedError so the coordinator can start on those
// platforms (the quota endpoint simply returns 503 — see quota-cache.ts /
// serve-http.ts for the fallback path that keeps raids running without a
// quota guardrail).

import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

export class NotImplementedError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`Claude OAuth credential reader not implemented for platform "${platform}" yet`);
    this.name = "NotImplementedError";
  }
}

export interface CredentialReader {
  readClaudeOAuthToken(): Promise<string>;
}

/**
 * macOS implementation: shells out to `security find-generic-password` against
 * the Claude Code-credentials entry in the user's Keychain, then parses the
 * JSON blob the CLI stored.
 */
export class MacOSCredentialReader implements CredentialReader {
  async readClaudeOAuthToken(): Promise<string> {
    let stdout: string;
    try {
      // -s = service, -w = print password only (the stored JSON blob).
      const result = await execFileP("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ]);
      stdout = result.stdout;
    } catch (err) {
      throw new Error(
        `security CLI failed — Keychain entry likely missing (${(err as Error).message})`,
      );
    }

    const raw = stdout.trim();
    if (!raw) throw new Error("Keychain returned empty credential blob");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Keychain credential is not valid JSON: ${(err as Error).message}`);
    }

    const token = extractAccessToken(parsed);
    if (!token) throw new Error("claudeAiOauth.accessToken missing or empty");
    return token;
  }
}

export class LinuxCredentialReader implements CredentialReader {
  // TODO: probably `secret-tool lookup` via libsecret, or read from
  //       ~/.config/claude-code/credentials.json — verify Claude Code's
  //       actual storage layout on Linux before implementing.
  async readClaudeOAuthToken(): Promise<string> {
    throw new NotImplementedError("linux");
  }
}

export class WindowsCredentialReader implements CredentialReader {
  // TODO: likely the Windows Credential Manager via `cmdkey` or a native
  //       binding — verify where Claude Code stores its OAuth token on Win
  //       before implementing.
  async readClaudeOAuthToken(): Promise<string> {
    throw new NotImplementedError("win32");
  }
}

/**
 * Whether this platform has a real credential reader behind it. macOS is the
 * only one; the Linux and Windows classes exist so the coordinator can boot,
 * and throw NotImplementedError the moment they are used.
 *
 * #341: /api/quota answers 503 either way, but 'this machine cannot do it'
 * and 'the fetch failed' are different facts, and only the first one means
 * the dashboard should stop showing an error the operator cannot act on.
 */
export function isCredentialReaderSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export function createCredentialReader(
  platform: NodeJS.Platform = process.platform,
): CredentialReader {
  switch (platform) {
    case "darwin":
      return new MacOSCredentialReader();
    case "linux":
      return new LinuxCredentialReader();
    case "win32":
      return new WindowsCredentialReader();
    default:
      throw new NotImplementedError(platform);
  }
}

function extractAccessToken(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const token = (oauth as Record<string, unknown>).accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}
