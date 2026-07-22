// Redis infrastructure for multi-instance mode.
//
// Opt-in and default-preserving: everything here activates only when
// COORDINATOR_REDIS_URL is set (same pattern as COORDINATOR_MQTT_EMBEDDED for
// the external broker). Without it, all consumers keep their in-memory
// single-instance implementations unchanged.
//
// Upstream alignment: this module implements the exact Redis patterns from
// docs/ops/single-instance-constraints.md §"Phase 5 plan" — SET NX EX locks
// (sweeper leader election, boot migration), INCR+EXPIRE (rate limiter),
// SETEX (membership cache), pub/sub (token-epoch bump). No client library is
// mandated upstream ("Redis or compatible"); we use the official `redis`
// (node-redis v5) client.

import { createClient } from "redis";

export type RedisClient = ReturnType<typeof createClient>;

export interface RedisHandles {
  /** Main client: commands, locks, publishes. */
  client: RedisClient;
  /** Dedicated subscriber connection (Redis requires a separate connection
   *  for subscribe mode). */
  subscriber: RedisClient;
  url: string;
  close(): Promise<void>;
}

interface MinimalLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Connect the main + subscriber clients. Throws if the initial connection
 * fails (startup should fail loudly on a misconfigured URL — same philosophy
 * as bootPhase2 env validation).
 *
 * Logger is optional because the boot-migration lock needs Redis BEFORE the
 * services logger exists (initDatabase runs inside createServices); we fall
 * back to console for the rare pre-boot error.
 */
export async function connectRedis(url: string, logger?: MinimalLogger): Promise<RedisHandles> {
  const log: MinimalLogger = logger ?? {
    info: (o, m) => console.log(m ?? o),
    warn: (o, m) => console.warn(m ?? o, o),
    error: (o, m) => console.error(m ?? o, o),
  };
  const client = createClient({ url });
  // node-redis emits 'error' events on connection loss; without a listener
  // they become uncaught exceptions. Reconnection is automatic.
  client.on("error", (err) => log.error({ err }, "Redis client error"));
  await client.connect();

  const subscriber = client.duplicate();
  subscriber.on("error", (err) => log.error({ err }, "Redis subscriber error"));
  await subscriber.connect();

  log.info({ url }, "Redis connected");
  return {
    client,
    subscriber,
    url,
    close: async () => {
      // quit() flushes pending commands then closes; destroy on failure.
      try {
        await subscriber.quit();
      } catch {
        subscriber.destroy();
      }
      try {
        await client.quit();
      } catch {
        client.destroy();
      }
    },
  };
}

/**
 * Try to take a lock: SET key owner NX EX ttl (single round trip, atomic).
 * Returns true when this owner holds the lock.
 */
export async function acquireLock(
  client: RedisClient,
  key: string,
  ttlSeconds: number,
  owner: string,
): Promise<boolean> {
  const res = await client.set(key, owner, { NX: true, EX: ttlSeconds });
  return res === "OK";
}

/**
 * Acquire OR renew: succeeds when the lock is free (NX) or already held by
 * this owner (renews the TTL). This is the leader-election gate shape — the
 * incumbent leader keeps leading across ticks; on crash the TTL expires and
 * another instance takes over within ttlSeconds.
 *
 * Note: the acquire→get→expire renewal path below is NOT atomic (three
 * round trips). That's an intentionally accepted trade-off for this
 * idempotent sweeper lease — a lost race just means a tick is skipped or
 * double-run, both harmless (see Sweeper.tick's comment). Do not reuse this
 * helper for a mutual-exclusion critical section; `withLock` deliberately
 * only uses the atomic `acquireLock` + Lua `releaseLock` path for that.
 */
export async function acquireOrRenewLock(
  client: RedisClient,
  key: string,
  ttlSeconds: number,
  owner: string,
): Promise<boolean> {
  if (await acquireLock(client, key, ttlSeconds, owner)) return true;
  const holder = await client.get(key);
  if (holder === owner) {
    await client.expire(key, ttlSeconds);
    return true;
  }
  return false;
}

/** Compare-and-delete release (Lua) — never deletes another owner's lock
 *  (e.g. after our TTL expired and someone else acquired it). */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function releaseLock(client: RedisClient, key: string, owner: string): Promise<void> {
  try {
    await client.eval(RELEASE_LUA, { keys: [key], arguments: [owner] });
  } catch {
    /* best-effort: TTL is the backstop */
  }
}

/**
 * Serialize a critical section across instances (boot migrations: the
 * "PRAGMA user_version write race" from single-instance-constraints.md).
 * Waits up to maxWaitMs for the lock, runs fn, releases. The TTL is the
 * crash backstop — a dying holder frees the lock within ttlSeconds.
 */
export async function withLock<T>(
  client: RedisClient,
  key: string,
  ttlSeconds: number,
  owner: string,
  fn: () => T | Promise<T>,
  opts?: { retryMs?: number; maxWaitMs?: number },
): Promise<T> {
  const retryMs = opts?.retryMs ?? 500;
  const maxWaitMs = opts?.maxWaitMs ?? 60_000;
  const deadline = Date.now() + maxWaitMs;
  while (!(await acquireLock(client, key, ttlSeconds, owner))) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for lock ${key} after ${maxWaitMs}ms`);
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }
  try {
    return await fn();
  } finally {
    await releaseLock(client, key, owner);
  }
}
