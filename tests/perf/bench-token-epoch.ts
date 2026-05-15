/* eslint-disable no-console */
/**
 * T33 perf bench — readTokenEpoch() direct DB read (V4 CUT 1).
 *
 * Measures the per-request cost of reading users.token_epoch on the
 * indexed PK lookup. Phase 2 deliberately skipped caching (V4 CUT 1) —
 * better-sqlite3 sync SELECT on a PK should stay in microseconds. This
 * bench confirms that assumption against a 1K-row users table with a
 * mixed access pattern (random user_id per iteration so PK index pages
 * aren't trivially hot in CPU cache).
 *
 * In-memory better-sqlite3.
 */
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { readTokenEpoch } from "../../src/auth/token-epoch.js";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (path: string) => Database.Database;

const USERS_SCHEMA = `
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    primary_org_id  TEXT NOT NULL REFERENCES orgs(id),
    email           TEXT NOT NULL,
    idp_provider    TEXT NOT NULL,
    idp_user_id     TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member',
    token_epoch     INTEGER NOT NULL DEFAULT 0
  );
`;

function seedUsers(db: Database.Database, count: number): string[] {
  db.exec(USERS_SCHEMA);
  db.prepare("INSERT INTO orgs (id, name) VALUES ('org-perf', 'Perf')").run();
  const ids: string[] = [];
  const insert = db.prepare(
    `INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id, role, token_epoch)
     VALUES (?, 'org-perf', ?, 'github', ?, 'member', ?)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `u-perf-${i}`;
      ids.push(id);
      insert.run(id, `${id}@example.com`, `gh-${i}`, (i * 7) & 0xff);
    }
  });
  tx();
  return ids;
}

async function main(): Promise<void> {
  const N = parseInt(process.env.BENCH_N ?? "100000", 10);
  const USERS = parseInt(process.env.BENCH_USERS ?? "1000", 10);
  const WARMUP = Math.min(1000, Math.floor(N / 100));

  const db = new DatabaseCtor(":memory:");
  const ids = seedUsers(db, USERS);

  // Pre-compute a random access sequence so RNG cost isn't measured.
  // Deterministic seed via a small LCG; doesn't need to be cryptographic.
  const seq = new Uint32Array(N);
  let s = 0xc0ffee;
  for (let i = 0; i < N; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    seq[i] = s % USERS;
  }

  // Warmup.
  for (let i = 0; i < WARMUP; i++) readTokenEpoch(db, ids[seq[i]!]!);

  const lat = new Float64Array(N);
  const totalStart = performance.now();
  for (let i = 0; i < N; i++) {
    const id = ids[seq[i]!]!;
    const start = process.hrtime.bigint();
    const epoch = readTokenEpoch(db, id);
    const dt = Number(process.hrtime.bigint() - start);
    lat[i] = dt;
    if (typeof epoch !== "number") throw new Error(`unexpected epoch type: ${typeof epoch}`);
  }
  const totalMs = performance.now() - totalStart;

  const sorted = Array.from(lat).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(N * 0.50)]!;
  const p95 = sorted[Math.floor(N * 0.95)]!;
  const p99 = sorted[Math.floor(N * 0.99)]!;
  const throughput = (N / totalMs) * 1000;

  console.log("\ntoken-epoch:");
  console.log(`  N=${N}, users=${USERS}, total=${totalMs.toFixed(1)}ms`);
  console.log(`  p50=${p50.toFixed(0)}ns, p95=${p95.toFixed(0)}ns, p99=${p99.toFixed(0)}ns`);
  console.log(`  throughput=${throughput.toFixed(1)} ops/sec`);

  const summary = {
    bench: "token-epoch",
    n: N,
    users: USERS,
    p50_ns: Number(p50.toFixed(0)),
    p95_ns: Number(p95.toFixed(0)),
    p99_ns: Number(p99.toFixed(0)),
    p50_us: Number((p50 / 1000).toFixed(3)),
    p99_us: Number((p99 / 1000).toFixed(3)),
    throughput_ops_per_sec: Number(throughput.toFixed(1)),
    total_ms: Number(totalMs.toFixed(1)),
  };
  console.log("JSON_SUMMARY: " + JSON.stringify(summary));

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
