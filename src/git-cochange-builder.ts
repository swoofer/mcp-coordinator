// src/git-cochange-builder.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { getDb } from "./database.js";
import { silentLogger, type Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

const DEFAULT_DENYLIST = [
  /package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/, /\.lock$/,
  /\/dist\//, /\/build\//, /\/\.next\//, /\/__snapshots__\//,
  /\.min\.js$/, /\.map$/, /\/coverage\//, /\/node_modules\//, /\.snap$/,
];

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
  async build(): Promise<void> {
    const db = getDb();
    const setMeta = (k: string, v: string) =>
      db.prepare("INSERT OR REPLACE INTO git_cochange_meta (k, v) VALUES (?, ?)").run(k, v);

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
    try { stdout = await this.runGitLog(); }
    catch (err) {
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

    db.exec("DELETE FROM git_cochange");
    const stmt = db.prepare(
      "INSERT INTO git_cochange (file_a, file_b, count, total_commits, computed_at) VALUES (?, ?, ?, ?, datetime('now'))"
    );
    const insertMany = db.transaction(() => {
      for (const [key, count] of pairs.entries()) {
        const [a, b] = key.split("|");
        if (a < b) stmt.run(a, b, count, totalCommits);
      }
    });
    insertMany();
    setMeta("available", "true");
    setMeta("last_built_at", new Date().toISOString());
    this.metrics?.gitCochangeBuilds.inc({ outcome: "success" });
    this.metrics?.gitCochangePairs.set(pairs.size);
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
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
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

    const tokens = stdout.split("\0").filter(t => t.length > 0);
    const pairs = new Map<string, number>();
    let totalCommits = 0;
    let currentFiles: string[] = [];

    const flush = () => {
      if (currentFiles.length === 0) return;
      // Skip massive commits (likely sweeps)
      if (currentFiles.length > 200) { currentFiles = []; return; }
      // Apply denylist
      const eligible = currentFiles.filter(f => !DEFAULT_DENYLIST.some(re => re.test(f)));
      for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
          const [a, b] = eligible[i] < eligible[j] ? [eligible[i], eligible[j]] : [eligible[j], eligible[i]];
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
  startScheduler(): void {
    const tick = async () => {
      try {
        await this.build();
        this.timer = setTimeout(tick, this.refreshMs);
      } catch (err) {
        this.log.warn({ err }, "build failed, retrying");
        this.timer = setTimeout(tick, this.retryMs);
      }
      if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
    };
    // First build after 5s grace
    this.timer = setTimeout(tick, 5000);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
