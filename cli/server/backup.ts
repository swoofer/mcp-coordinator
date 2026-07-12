import { Command } from "commander";
import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { create as tarCreate } from "tar";
import { getConfigDir, loadConfig } from "../config.js";

interface BackupOpts {
  output?: string;
  dataDir?: string;
  force?: boolean;
}

/**
 * Format a timestamp suitable for filenames: YYYY-MM-DD-HHMMSS (UTC).
 */
function timestampSlug(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Returns true if a process with the given pid is currently alive.
 * On both POSIX and Windows, sending signal 0 acts as a liveness probe
 * (it raises ESRCH if the process is dead, EPERM if alive but not ours).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission — still "alive".
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/**
 * Check whether the coordinator daemon appears to be running.
 * Returns the pid if alive, or null otherwise.
 */
export function getRunningCoordinatorPid(configDir: string): number | null {
  const pidPath = join(configDir, "server.pid");
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (Number.isNaN(pid)) return null;
  return isProcessAlive(pid) ? pid : null;
}

/**
 * Recursively walk a directory and yield relative file paths.
 * Used purely for reporting (file count) — tar handles the actual packing.
 */
async function countFiles(root: string): Promise<number> {
  const { readdir, stat } = await import("fs/promises");
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  };
  if (existsSync(root)) await walk(root);
  return count;
}

/**
 * Build the list of entries (relative to configDir) we want to include in the
 * tarball. We deliberately keep the layout flat — the same paths used at
 * runtime — so a `tar -xzf` into `~/.mcp-coordinator/` is a valid restore.
 *
 * NOTE on live backups: this command refuses to run while the coordinator is
 * up because better-sqlite3's WAL journal may have uncommitted writes that
 * file-copy will miss. For online backups, switch to SQLite's Online Backup
 * API (`db.backup(path)` from better-sqlite3) and snapshot config.json
 * separately — see docs/superpowers/working/v04/backup-integration.md.
 */
function buildEntries(configDir: string, dataDirAbsolute: string): string[] {
  const entries: string[] = [];
  if (existsSync(join(configDir, "config.json"))) entries.push("config.json");

  // The data dir might live outside ~/.mcp-coordinator (custom --data-dir).
  // tar's `cwd` option can only point at one directory, so when the data dir
  // is non-default we pack it under its absolute path inside the archive
  // (preserving structure for round-trip restore via --data-dir).
  const defaultDataDir = join(configDir, "data");
  if (resolve(dataDirAbsolute) === resolve(defaultDataDir) && existsSync(defaultDataDir)) {
    entries.push("data");
  }
  return entries;
}

export function createServerBackupCommand(): Command {
  return new Command("backup")
    .description("Snapshot the coordinator config + SQLite database to a tar.gz archive")
    .option("--output <path>", "Output tarball path (default ./mcp-coordinator-backup-<ts>.tar.gz)")
    .option("--data-dir <path>", "Data directory to back up (overrides config.server.data_dir)")
    .option("--force", "Skip the running-coordinator safety check")
    .action(async (opts: BackupOpts) => {
      const configDir = getConfigDir();
      const config = loadConfig(configDir);
      const dataDir = resolve(
        opts.dataDir ?? process.env.COORDINATOR_DATA_DIR ?? config.server.data_dir,
      );

      // Safety: refuse when the daemon is up. WAL writes might be in flight.
      const runningPid = getRunningCoordinatorPid(configDir);
      if (runningPid !== null && !opts.force) {
        console.error(`Coordinator is running (PID ${runningPid}).`);
        console.error("Refusing to back up: live SQLite WAL writes may be in flight.");
        console.error("Either stop it first ('mcp-coordinator server stop') or pass --force.");
        process.exit(1);
      }

      if (!existsSync(configDir)) {
        console.error(`No coordinator config directory at ${configDir} — nothing to back up.`);
        process.exit(1);
      }

      const ts = timestampSlug();
      const outputPath = resolve(
        opts.output ?? join(process.cwd(), `mcp-coordinator-backup-${ts}.tar.gz`),
      );

      const defaultDataDir = join(configDir, "data");
      const dataIsCustom = resolve(dataDir) !== resolve(defaultDataDir);

      // Pack ~/.mcp-coordinator entries from configDir as cwd.
      const entries = buildEntries(configDir, dataDir);

      // For custom data dirs, pack them under their absolute path so restore
      // can reproduce the original location (or be redirected with --data-dir).
      const customDataEntries: { cwd: string; entry: string }[] = [];
      if (dataIsCustom && existsSync(dataDir)) {
        customDataEntries.push({ cwd: resolve(dataDir, ".."), entry: basename(dataDir) });
      }

      if (entries.length === 0 && customDataEntries.length === 0) {
        console.error("Nothing to back up: no config.json and no data directory found.");
        process.exit(1);
      }

      // First archive pass: config + default data (if any).
      if (entries.length > 0) {
        await tarCreate({ gzip: true, file: outputPath, cwd: configDir, portable: true }, entries);
      }

      // Second pass for a custom data dir — append into the same archive.
      // tar's gzip mode doesn't support append, so we re-create instead by
      // extracting the previous entries and re-packing. Simpler path: emit
      // a sibling .data.tar.gz when custom dir is in use, and document it.
      if (customDataEntries.length > 0) {
        const dataArchive = outputPath.replace(/\.tar\.gz$/, ".data.tar.gz");
        for (const { cwd, entry } of customDataEntries) {
          await tarCreate({ gzip: true, file: dataArchive, cwd, portable: true }, [entry]);
        }
        console.log(`Custom data dir packed separately: ${dataArchive}`);
      }

      // outputPath only exists if entries.length > 0; report on whichever
      // archive(s) we actually produced.
      const reportPath =
        entries.length > 0 ? outputPath : outputPath.replace(/\.tar\.gz$/, ".data.tar.gz");
      const sizeBytes = existsSync(reportPath) ? statSync(reportPath).size : 0;
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
      const fileCount =
        (existsSync(join(configDir, "config.json")) ? 1 : 0) +
        (await countFiles(dataIsCustom ? dataDir : defaultDataDir));

      console.log("Backup complete.");
      console.log(`  Archive:   ${reportPath}`);
      console.log(`  Size:      ${sizeMB} MB (${sizeBytes} bytes)`);
      console.log(`  Files:     ${fileCount}`);
      console.log(`  ConfigDir: ${configDir}`);
      console.log(`  DataDir:   ${dataDir}${dataIsCustom ? " (custom)" : ""}`);
    });
}
