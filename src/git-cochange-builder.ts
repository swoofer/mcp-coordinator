// src/git-cochange-builder.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { getDb } from "./database.js";
import { normalizePath } from "./path-normalize.js";
import { silentLogger, type Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

const DEFAULT_DENYLIST = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.lock$/,
  /\/dist\//,
  /\/build\//,
  /\/\.next\//,
  /\/__snapshots__\//,
  /\.min\.js$/,
  /\.map$/,
  /\/coverage\//,
  /\/node_modules\//,
  /\.snap$/,
];

// Same number the sweeper uses (src/sweeper/index.ts CIRCUIT_BREAK_THRESHOLD).
// Same class of problem -- a periodic task whose backing store has gone away --
// so an operator who has learned one threshold has learned both.
const SCHEDULER_CIRCUIT_BREAK_THRESHOLD = 5;

interface BuilderOpts {
  repoRoot: string;
  sinceDays?: number;
  maxCount?: number;
  timeoutMs?: number;
  refreshMs?: number;
  retryMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

export class GitCochangeBuilder {
  private repoRoot: string;
  private sinceDays: number;
  private maxCount: number;
  private timeoutMs: number;
  private refreshMs: number;
  private retryMs: number;
  private log: Logger;
  private metrics?: Metrics;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private schedulerFailures = 0;
  private schedulerCircuitOpen = false;

  constructor(opts: BuilderOpts) {
    this.repoRoot = opts.repoRoot;
    this.sinceDays = opts.sinceDays ?? 7;
    this.maxCount = opts.maxCount ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.refreshMs = opts.refreshMs ?? 1800000;
    this.retryMs = opts.retryMs ?? 300000;
    this.log = opts.logger || silentLogger;
    this.metrics = opts.metrics;
  }

  /** Build once. Resolves after persistence. */
  async build(orgId: string): Promise<void> {
    const db = getDb();
    const setMeta = (k: string, v: string) =>
      db
        .prepare("INSERT OR REPLACE INTO git_cochange_meta (org_id, k, v) VALUES (?, ?, ?)")
        .run(orgId, k, v);

    if (!existsSync(path.join(this.repoRoot, ".git"))) {
      this.log.info({}, "Layer 4 unavailable: no .git");
      setMeta("available", "false");
      this.metrics?.gitCochangeBuilds.inc({ outcome: "failed" });
      return;
    }

    if (existsSync(path.join(this.repoRoot, ".git", "shallow"))) {
      this.log.info({}, "Layer 4 unavailable: shallow clone");
      setMeta("available", "false");
      this.metrics?.gitCochangeBuilds.inc({ outcome: "shallow_skipped" });
      return;
    }

    let stdout: string | null = null;
    try {
      stdout = await this.runGitLog();
    } catch (err) {
      this.log.warn({ err }, "git log failed");
      setMeta("available", "false");
      setMeta("last_error", String((err as Error).message));
      this.metrics?.gitCochangeBuilds.inc({ outcome: "failed" });
      return;
    }

    if (stdout === "TIMEOUT") {
      setMeta("available", "stale_partial");
      this.log.warn({}, "git log timed out — Layer 4 stale_partial");
      this.metrics?.gitCochangeBuilds.inc({ outcome: "timeout" });
      return;
    }

    const { pairs, totalCommits } = this.parseLog(stdout);

    // Dynamic predictor cap: any file appearing in > 40% of effective commits is
    // excluded as a *predictor* (still allowed as a *target*). Prevents hotspot files
    // like config or barrel index from saturating co-change with every other file.
    const PREDICTOR_CAP_RATIO = 0.4;
    const fileCommitCount = new Map<string, number>();
    for (const key of pairs.keys()) {
      const [a, b] = key.split("|");
      fileCommitCount.set(a, (fileCommitCount.get(a) ?? 0) + (pairs.get(key) ?? 0));
      fileCommitCount.set(b, (fileCommitCount.get(b) ?? 0) + (pairs.get(key) ?? 0));
    }
    const promiscuous = new Set<string>();
    for (const [file, count] of fileCommitCount) {
      // count is total times the file appeared in any pair; max possible is roughly
      // (totalCommits) per file. Use raw count / totalCommits as an approximation
      // of the file's commit frequency.
      if (totalCommits > 0 && count / totalCommits > PREDICTOR_CAP_RATIO) {
        promiscuous.add(file);
      }
    }

    if (promiscuous.size > 0) {
      this.log.info(
        { count: promiscuous.size, files: Array.from(promiscuous) },
        "Layer 4 dynamic predictor cap excluded files",
      );
    }

    // Scope the DELETE to this org only — never wipe another org's rows.
    db.prepare("DELETE FROM git_cochange WHERE org_id = ?").run(orgId);
    const stmt = db.prepare(
      "INSERT INTO git_cochange (org_id, file_a, file_b, count, total_commits, computed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    );
    const insertMany = db.transaction(() => {
      for (const [key, count] of pairs.entries()) {
        const [a, b] = key.split("|");
        // Skip pairs where EITHER file is a promiscuous predictor (file is allowed
        // as target only, but a pair where it's a predictor is dropped). For the
        // index entry to be useful, both files must be non-promiscuous predictors.
        if (promiscuous.has(a) || promiscuous.has(b)) continue;
        // issue #275: git reports true-case paths; the rest of the schema
        // stores the normalized form. Layer 4 is looked up by the SAME
        // declared path the other layers use, so this key has to match --
        // otherwise normalizing the declared side would fix Layers 1/2 and
        // break co-change instead. The table is wiped and rebuilt on every
        // refresh (the DELETE above), so no migration is needed.
        const na = normalizePath(this.repoRoot, a);
        const nb = normalizePath(this.repoRoot, b);
        if (na < nb) stmt.run(orgId, na, nb, count, totalCommits);
        else if (nb < na) stmt.run(orgId, nb, na, count, totalCommits);
      }
    });
    insertMany();
    setMeta("available", "true");
    setMeta("last_built_at", new Date().toISOString());
    this.metrics?.gitCochangeBuilds.inc({ outcome: "success" });
    this.metrics?.gitCochangePairs.set(pairs.size);
  }

  /** Query co-change partners for a file, scoped to the given org. */
  query(
    orgId: string,
    filePath: string,
  ): Array<{
    org_id: string;
    file_a: string;
    file_b: string;
    count: number;
    total_commits: number;
    computed_at: string;
  }> {
    const db = getDb();
    return db
      .prepare(
        `SELECT org_id, file_a, file_b, count, total_commits, computed_at FROM git_cochange
       WHERE org_id = ? AND (file_a = ? OR file_b = ?)
       ORDER BY count DESC LIMIT 50`,
      )
      .all(orgId, filePath, filePath) as Array<{
      org_id: string;
      file_a: string;
      file_b: string;
      count: number;
      total_commits: number;
      computed_at: string;
    }>;
  }

  private runGitLog(): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "log",
        `--max-count=${this.maxCount}`,
        "--diff-filter=AMRD",
        `--since=${this.sinceDays} days ago`,
        "--no-renames",
        "--pretty=format:%H",
        "--name-only",
        "-z",
      ];
      const proc = spawn("git", args, { cwd: this.repoRoot });
      let buf = "";
      const timer = setTimeout(() => {
        proc.kill();
        resolve("TIMEOUT");
      }, this.timeoutMs);
      proc.stdout.on("data", (c) => (buf += c.toString("utf-8")));
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(buf);
        else reject(new Error(`git log exit ${code}`));
      });
    });
  }

  private parseLog(stdout: string): { pairs: Map<string, number>; totalCommits: number } {
    // git log -z --pretty=format:%H --name-only output format:
    // Each commit entry: <SHA>\n<file1>\0<file2>\0...\0
    // Between commits the NUL separator also acts as delimiter.
    // We split on NUL first, then detect SHA boundaries within tokens.

    const tokens = stdout.split("\0").filter((t) => t.length > 0);
    const pairs = new Map<string, number>();
    let totalCommits = 0;
    let currentFiles: string[] = [];

    const flush = () => {
      if (currentFiles.length === 0) return;
      // Skip massive commits (likely sweeps)
      if (currentFiles.length > 200) {
        currentFiles = [];
        return;
      }
      // Apply denylist
      const eligible = currentFiles.filter((f) => !DEFAULT_DENYLIST.some((re) => re.test(f)));
      for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
          const [a, b] =
            eligible[i] < eligible[j] ? [eligible[i], eligible[j]] : [eligible[j], eligible[i]];
          const key = `${a}|${b}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
      }
      totalCommits++;
      currentFiles = [];
    };

    // SHA pattern: 40 hex chars
    const shaRe = /^([0-9a-f]{40})\n(.*)$/s;

    for (const t of tokens) {
      // Each token after splitting on \0 may look like:
      // "\nSHA40\npath" (commit boundary with preceding newline)
      // "SHA40\npath"  (commit boundary at start)
      // "path"         (file path continuation)
      // "\nSHA40"      (SHA only, no file on same token)

      // Strip leading newlines to normalize
      const stripped = t.replace(/^\n+/, "");

      const shaMatch = stripped.match(shaRe);
      if (shaMatch) {
        // We found a SHA — flush the previous commit's files
        flush();
        const trailingPath = shaMatch[2].trim();
        if (trailingPath) currentFiles.push(trailingPath);
      } else {
        // Check if this token itself IS a SHA (no file attached, happens when
        // --pretty=format:%H emits the SHA on its own NUL-terminated chunk)
        const pureSha = stripped.match(/^[0-9a-f]{40}$/);
        if (pureSha) {
          flush();
        } else {
          // It's a file path (or part of one); newlines indicate embedded commit
          // boundaries when a file is on the same NUL chunk as the next SHA.
          // Handle the case where "path\nSHA\npath" might appear.
          const parts = stripped.split("\n");
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;
            if (/^[0-9a-f]{40}$/.test(part)) {
              flush();
            } else {
              currentFiles.push(part);
            }
          }
        }
      }
    }
    flush();
    return { pairs, totalCommits };
  }

  /** Schedule a refresh loop. unref() so it doesn't keep the loop alive. */
  startScheduler(orgId: string): void {
    this.schedulerFailures = 0;
    this.schedulerCircuitOpen = false;
    this.metrics?.gitCochangeSchedulerCircuitOpen.set(0);

    const tick = async () => {
      try {
        await this.build(orgId);
        this.schedulerFailures = 0;
        this.timer = setTimeout(tick, this.refreshMs);
      } catch (err) {
        this.recordSchedulerFailure(orgId, err);
        if (this.schedulerCircuitOpen) {
          this.timer = null;
          return;
        }
        this.timer = setTimeout(tick, this.retryMs);
      }
      if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
    };
    // First build after 5s grace
    this.timer = setTimeout(tick, 5000);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * build() instruments every failure it catches itself -- a missing .git, a
   * shallow clone, a git log that fails or times out all get a counter, a
   * meta row and a log line. So the only errors that reach the scheduler are
   * the ones build() does *not* catch: getDb() and the SQLite writes.
   *
   * Those are the severe end of the range, and until #368 they were the only
   * ones with no counter, no meta row and no bound on how long the loop would
   * keep retrying -- one warn line every retryMs (5 min by default), forever.
   */
  private recordSchedulerFailure(orgId: string, err: unknown): void {
    this.schedulerFailures++;
    this.metrics?.gitCochangeBuilds.inc({ outcome: "scheduler_error" });
    this.metrics?.gitCochangeSchedulerFailures.inc();

    // The likeliest way to land here is the database being unreachable, which
    // is also what persisting the reason needs. Recording the failure must
    // never become a second failure.
    try {
      const stmt = getDb().prepare(
        "INSERT OR REPLACE INTO git_cochange_meta (org_id, k, v) VALUES (?, ?, ?)",
      );
      stmt.run(orgId, "available", "false");
      stmt.run(orgId, "last_error", String((err as Error)?.message ?? err));
    } catch (metaErr) {
      this.log.warn({ err: metaErr }, "could not persist git_cochange scheduler failure");
    }

    if (this.schedulerFailures >= SCHEDULER_CIRCUIT_BREAK_THRESHOLD) {
      this.schedulerCircuitOpen = true;
      this.metrics?.gitCochangeSchedulerCircuitOpen.set(1);
      this.log.error(
        { err, consecutive_failures: this.schedulerFailures },
        "git_cochange refresh loop stopped: circuit breaker open. Layer 4 stays at its last built state; restart the coordinator once the database is reachable.",
      );
      return;
    }

    this.log.warn(
      { err, consecutive_failures: this.schedulerFailures },
      "git_cochange build failed, retrying",
    );
  }

  /** Consecutive scheduler failures; 0 after any successful build. */
  getSchedulerFailureCount(): number {
    return this.schedulerFailures;
  }

  /** True once the refresh loop has given up. Surfaced on /health/ready. */
  isSchedulerCircuitOpen(): boolean {
    return this.schedulerCircuitOpen;
  }

  stopScheduler(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
