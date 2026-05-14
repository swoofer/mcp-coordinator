// T25 — CLI verb `mcp-coordinator service-token`. Admin-only.
//
// Currently ships `issue` end-to-end (calls POST /api/admin/service-tokens).
// `list` + `revoke` are stub subcommands that print a SQL workaround until
// the GET/POST-revoke admin endpoints land in a follow-up task.
import { Command } from "commander";

interface IssueOpts {
  user: string;
  org: string;
  scope: string;
  ttl: string;
  reason: string;
  server: string;
  adminToken?: string;
}

interface ListOpts {
  server: string;
  adminToken?: string;
  activeOnly: boolean;
}

interface RevokeOpts {
  jti: string;
  server: string;
  adminToken?: string;
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
    .option(
      "--admin-token <token>",
      "Admin Bearer token (or set COORDINATOR_ADMIN_TOKEN env)",
    )
    .action(async (opts: IssueOpts) => {
      const adminToken = opts.adminToken ?? process.env.COORDINATOR_ADMIN_TOKEN;
      if (!adminToken) {
        process.stderr.write(
          "Error: --admin-token required or set COORDINATOR_ADMIN_TOKEN\n",
        );
        process.exit(1);
      }
      const response = await fetch(
        `${opts.server}/api/admin/service-tokens`,
        {
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
        },
      );
      if (!response.ok) {
        process.stderr.write(
          `Error ${response.status}: ${await response.text()}\n`,
        );
        process.exit(1);
      }
      const result = (await response.json()) as {
        jti: string;
        access_token: string;
        expires_at: string;
      };
      process.stdout.write("Service token issued:\n");
      process.stdout.write(`  jti:          ${result.jti}\n`);
      process.stdout.write(`  access_token: ${result.access_token}\n`);
      process.stdout.write(`  expires_at:   ${result.expires_at}\n`);
      process.stdout.write(
        "\nWARNING: Store the access_token securely -- it cannot be retrieved again.\n",
      );
    });

  cmd
    .command("list")
    .description("List service tokens (DEFERRED: see SQL workaround)")
    .option("--server <url>", "Coordinator URL", "http://localhost:3000")
    .option("--admin-token <token>", "Admin Bearer token")
    .option("--active-only", "Only show non-revoked tokens", false)
    .action((_opts: ListOpts) => {
      process.stdout.write(
        [
          "list: deferred to a follow-up task.",
          "Workaround (sqlite3 cli against coordinator.db):",
          "  SELECT jti, user_id, org_id, expires_at, revoked_at, revoked_reason",
          "  FROM refresh_tokens",
          "  WHERE family_id LIKE 'service:%'",
          "  ORDER BY created_at DESC;",
          "",
        ].join("\n"),
      );
    });

  cmd
    .command("revoke")
    .description("Revoke a service token (DEFERRED: see SQL workaround)")
    .requiredOption("--jti <jti>", "Token jti")
    .option("--server <url>", "Coordinator URL", "http://localhost:3000")
    .option("--admin-token <token>", "Admin Bearer token")
    .action((opts: RevokeOpts) => {
      process.stdout.write(
        [
          "revoke: deferred to a follow-up task.",
          "Workaround (sqlite3 cli against coordinator.db):",
          `  UPDATE refresh_tokens`,
          `    SET revoked_at = strftime('%s','now'), revoked_reason = 'admin'`,
          `    WHERE jti = '${opts.jti}' AND family_id LIKE 'service:%';`,
          "",
        ].join("\n"),
      );
    });

  return cmd;
}
