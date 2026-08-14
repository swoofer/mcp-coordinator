import { Command } from "commander";
import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import { join, resolve } from "path";
import { extract as tarExtract, list as tarList } from "tar";
import { getConfigDir } from "../config.js";
import { getRunningCoordinatorPid } from "./backup.js";

interface RestoreOpts {
  force?: boolean;
  // commander auto-derives `backup` from `--no-backup`; default is true.
  backup?: boolean;
  dataDir?: string;
}

function timestampSlug(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Inspect the tarball without extracting and return the list of top-level
 * entries (file or dir names). Used to validate structure before touching
 * the user's existing config dir.
 */
async function listTarballEntries(tarPath: string): Promise<string[]> {
  const entries: string[] = [];
  await tarList({
    file: tarPath,
    onReadEntry: (entry) => {
      // Trailing slash on dirs — strip it, take the first path segment only.
      const head = entry.path.replace(/\\/g, "/").split("/")[0];
      if (head && !entries.includes(head)) entries.push(head);
    },
  });
  return entries;
}

export function createServerRestoreCommand(): Command {
  return new Command("restore")
    .description("Restore a coordinator config + database snapshot from a tar.gz archive")
    .argument("<tarball>", "Path to the backup .tar.gz produced by 'mcp-coordinator server backup'")
    .option("--force", "Skip the running-coordinator safety check")
    .option("--no-backup", "Do not snapshot the existing config dir before overwriting")
    .option("--data-dir <path>", "Override data directory (rarely needed)")
    .action(async (tarballArg: string, opts: RestoreOpts) => {
      const tarPath = resolve(tarballArg);
      if (!existsSync(tarPath)) {
        console.error(`Tarball not found: ${tarPath}`);
        process.exit(1);
      }

      const tarStat = statSync(tarPath);
      if (!tarStat.isFile()) {
        console.error(`Not a regular file: ${tarPath}`);
        process.exit(1);
      }

      const configDir = getConfigDir();

      // Safety: refuse when the daemon is running so we don't clobber an
      // open SQLite handle (would corrupt the WAL on the daemon side).
      const runningPid = getRunningCoordinatorPid(configDir);
      if (runningPid !== null && !opts.force) {
        console.error(`Coordinator is running (PID ${runningPid}).`);
        console.error("Refusing to restore: stop the coordinator first or pass --force.");
        process.exit(1);
      }

      // Validate tarball contents BEFORE moving anything aside.
      let entries: string[];
      try {
        entries = await listTarballEntries(tarPath);
      } catch (err) {
        console.error(`Failed to read tarball: ${(err as Error).message}`);
        process.exit(1);
      }

      const hasConfig = entries.includes("config.json");
      const hasData = entries.includes("data");
      if (!hasConfig && !hasData) {
        console.error("Tarball does not contain expected entries (config.json or data/).");
        console.error(`Top-level entries found: ${entries.join(", ") || "(none)"}`);
        process.exit(1);
      }

      // Snapshot the existing config dir before overwriting.
      // commander auto-flips `--no-backup` -> opts.backup = false. The default
      // value is `true` (the option is registered with .option("--no-backup")
      // below, which makes commander seed `opts.backup = true`).
      const shouldSnapshot = opts.backup !== false;
      let snapshotPath: string | null = null;
      if (shouldSnapshot && existsSync(configDir)) {
        snapshotPath = `${configDir}.bak-${timestampSlug()}`;
        renameSync(configDir, snapshotPath);
        console.log(`Existing config moved aside: ${snapshotPath}`);
      }

      // Recreate the target dir and extract.
      mkdirSync(configDir, { recursive: true });
      try {
        await tarExtract({ file: tarPath, cwd: configDir });
      } catch (err) {
        console.error(`Extraction failed: ${(err as Error).message}`);
        // Try to roll back the snapshot if we made one.
        if (snapshotPath !== null && existsSync(snapshotPath)) {
          // Best-effort, and unconditional: whatever the half-finished
          // extraction left behind is moved aside rather than inspected.
          const failedPath = `${configDir}.failed-${timestampSlug()}`;
          try {
            renameSync(configDir, failedPath);
            renameSync(snapshotPath, configDir);
            // Name the quarantined directory — it holds the partial extraction,
            // and without the path there is no way to inspect or delete it.
            console.error("Rolled back to previous config dir.");
            console.error(`  partial extraction moved to: ${failedPath}`);
          } catch {
            console.error(`Manual recovery required — snapshot at: ${snapshotPath}`);
          }
        }
        process.exit(1);
      }

      console.log("Restore complete.");
      console.log(`  Source:    ${tarPath}`);
      console.log(`  ConfigDir: ${configDir}`);
      console.log(
        `  Restored:  ${entries.filter((e) => e === "config.json" || e === "data").join(", ")}`,
      );
      if (snapshotPath !== null) {
        console.log(`  Previous:  ${snapshotPath}  (delete once verified)`);
      }
      if (opts.dataDir !== undefined) {
        console.log(
          `  Note:      --data-dir was provided but restore extracts to default location.\n` +
            `             Update config.json or COORDINATOR_DATA_DIR if you need a non-default path.`,
        );
      }
    });
}
