// T25 — CLI verb `mcp-coordinator service-token`. Admin-only.
//
// Ships `issue`, `list`, and `revoke` end-to-end against the admin HTTP
// endpoints (POST/GET /api/admin/service-tokens and POST /api/admin/
// service-tokens/<jti>/revoke).
import { Command } from "commander";

interface IssueOpts {
  user: string;
  org: string;
  scope: string;
  ttl: string;
  reason: string;
  server: string;
  adminToken?: string;
  json?: boolean;
}

interface ListOpts {
  server: string;
  adminToken?: string;
  user?: string;
  org?: string;
  activeOnly: boolean;
  json?: boolean;
}

interface IssuedToken {
  jti: string;
  access_token: string;
  expires_at: string;
}

/**
 * Render an issued token for stdout. `--json` emits a single JSON object
 * (script/CI-parseable); default is the human-readable key/value block.
 * The "store it securely" warning is NOT part of this — the caller routes it
 * to stderr in JSON mode so stdout stays clean JSON.
 */
export function formatIssuedToken(result: IssuedToken, json: boolean): string {
  if (json) return JSON.stringify(result) + "\n";
  return (
    "Service token issued:\n" +
    `  jti:          ${result.jti}\n` +
    `  access_token: ${result.access_token}\n` +
    `  expires_at:   ${result.expires_at}\n`
  );
}

/**
 * Render a token list for stdout. `--json` emits a JSON array (empty array
 * when there are none); default is a TSV table (or a "(no service tokens)"
 * line).
 */
export function formatTokenList(tokens: ListedToken[], json: boolean): string {
  if (json) return JSON.stringify(tokens) + "\n";
  if (tokens.length === 0) return "(no service tokens)\n";
  let out = "JTI\tUSER\tORG\tSTATUS\tEXPIRES_AT\n";
  for (const t of tokens) {
    out += `${t.jti}\t${t.user_id}\t${t.org_id}\t${t.status}\t${t.expires_at}\n`;
  }
  return out;
}

interface RevokeOpts {
  jti: string;
  server: string;
  adminToken?: string;
}

interface ListedToken {
  jti: string;
  user_id: string;
  org_id: string;
  family_id: string;
  expires_at: string | number;
  created_at: string | number;
  last_used_at: string | number | null;
  revoked_at: string | number | null;
  revoked_reason: string | null;
  status: "active" | "revoked" | "expired";
}

export function createServiceTokensCommand(): Command {
  const cmd = new Command("service-token");
  cmd.description("Manage service tokens (admin only)");

  cmd
    .command("issue")
    .description("Issue a new service token")
    .requiredOption("--user <id>", "Target user ID")
    .requiredOption("--org <id>", "Target org ID")
    .requiredOption("--scope <scope>", "Token scope (read|write|admin)")
    .requiredOption("--ttl <duration>", "TTL (e.g., 30d, 168h)")
    .requiredOption("--reason <text>", "Reason for issuance (>=10 chars)")
    .option("--server <url>", "Coordinator URL", "http://localhost:3000")
    .option("--admin-token <token>", "Admin Bearer token (or set COORDINATOR_ADMIN_TOKEN env)")
    .option("--json", "Emit a JSON object instead of the human-readable block", false)
    .action(async (opts: IssueOpts) => {
      const adminToken = opts.adminToken ?? process.env.COORDINATOR_ADMIN_TOKEN;
      if (!adminToken) {
        process.stderr.write("Error: --admin-token required or set COORDINATOR_ADMIN_TOKEN\n");
        process.exit(1);
      }
      const response = await fetch(`${opts.server}/api/admin/service-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: opts.user,
          org_id: opts.org,
          scope: opts.scope,
          ttl: opts.ttl,
          reason: opts.reason,
        }),
      });
      if (!response.ok) {
        process.stderr.write(`Error ${response.status}: ${await response.text()}\n`);
        process.exit(1);
      }
      const result = (await response.json()) as IssuedToken;
      process.stdout.write(formatIssuedToken(result, opts.json ?? false));
      const warning = "WARNING: Store the access_token securely -- it cannot be retrieved again.\n";
      // Keep stdout clean JSON in --json mode; route the advisory to stderr.
      if (opts.json) process.stderr.write(warning);
      else process.stdout.write("\n" + warning);
    });

  cmd
    .command("list")
    .description("List service tokens (admin-only)")
    .option("--server <url>", "Coordinator URL", "http://localhost:3000")
    .option("--admin-token <token>", "Admin Bearer token (or set COORDINATOR_ADMIN_TOKEN env)")
    .option("--user <id>", "Filter by target user ID")
    .option("--org <id>", "Filter by target org ID")
    .option("--active-only", "Only show non-revoked tokens", false)
    .option("--json", "Emit a JSON array instead of the TSV table", false)
    .action(async (opts: ListOpts) => {
      const adminToken = opts.adminToken ?? process.env.COORDINATOR_ADMIN_TOKEN;
      if (!adminToken) {
        process.stderr.write("Error: --admin-token required or set COORDINATOR_ADMIN_TOKEN\n");
        process.exit(1);
      }
      const u = new URL("/api/admin/service-tokens", opts.server);
      if (opts.user) u.searchParams.set("user", opts.user);
      if (opts.org) u.searchParams.set("org", opts.org);
      if (opts.activeOnly) u.searchParams.set("active_only", "true");

      const response = await fetch(u, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) {
        process.stderr.write(`Error ${response.status}: ${await response.text()}\n`);
        process.exit(1);
      }
      const body = (await response.json()) as { tokens: ListedToken[] };
      process.stdout.write(formatTokenList(body.tokens, opts.json ?? false));
    });

  cmd
    .command("revoke")
    .description("Revoke a service token (admin-only)")
    .requiredOption("--jti <jti>", "Token jti")
    .option("--server <url>", "Coordinator URL", "http://localhost:3000")
    .option("--admin-token <token>", "Admin Bearer token (or set COORDINATOR_ADMIN_TOKEN env)")
    .action(async (opts: RevokeOpts) => {
      const adminToken = opts.adminToken ?? process.env.COORDINATOR_ADMIN_TOKEN;
      if (!adminToken) {
        process.stderr.write("Error: --admin-token required or set COORDINATOR_ADMIN_TOKEN\n");
        process.exit(1);
      }
      const u = new URL(
        `/api/admin/service-tokens/${encodeURIComponent(opts.jti)}/revoke`,
        opts.server,
      );
      const response = await fetch(u, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (response.status === 404) {
        process.stderr.write("Error: token not found or already revoked\n");
        process.exit(1);
      }
      if (!response.ok) {
        process.stderr.write(`Error ${response.status}: ${await response.text()}\n`);
        process.exit(1);
      }
      process.stdout.write(`Revoked: ${opts.jti}\n`);
    });

  return cmd;
}
