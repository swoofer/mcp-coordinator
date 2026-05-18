/**
 * T12c: Module-level accessor for the boot-resolved encryption status, so
 * the /health/ready handler (and any future observer) can read it without
 * coupling to the boot lifecycle. Mirrors the `getAuditQueue()` pattern.
 *
 * Lifecycle:
 *   - boot calls `setEncryptionStatus(...)` once, from `buildWrappedProvider`
 *     in `src/boot-encryption.ts`, after `runEncryptionGuards` resolves the
 *     mode + fingerprint.
 *   - `getEncryptionStatus()` returns null when boot has not (yet) called
 *     `setEncryptionStatus` — health handler treats this as "encryption
 *     block unknown" and omits the field entirely.
 *   - `clearEncryptionStatus()` is a TEST-ONLY teardown — production callers
 *     never reset module state.
 */
import { decryptFailuresCounter } from "./metrics.js";

export interface EncryptionStatus {
  enabled: boolean;
  key_source: "env" | "absent";
  key_fingerprint: string | null;
}

let _status: EncryptionStatus | null = null;

/** Called once at boot from `buildWrappedProvider`. NEVER call from a request handler. */
export function setEncryptionStatus(status: EncryptionStatus): void {
  _status = status;
}

/** Test-only teardown — clears the module-level status so subsequent tests start clean. */
export function clearEncryptionStatus(): void {
  _status = null;
}

/**
 * Returns the current encryption status augmented with the lifetime decrypt-
 * failure counter total (summed across all `error_class` label buckets), or
 * null when boot has not set the status.
 *
 * Async because `prom-client`'s `Counter.get()` returns a Promise.
 */
export async function getEncryptionStatus(): Promise<{
  enabled: boolean;
  key_source: "env" | "absent";
  key_fingerprint: string | null;
  decrypt_failures_total: number;
} | null> {
  if (_status === null) return null;
  const metric = await decryptFailuresCounter.get();
  // Sum across all label values (different error_class buckets). Counter
  // with no observed increments returns values=[], yielding total=0.
  // prom-client guarantees every hashmap entry has a numeric `value`, so
  // no defensive fallback needed here (and one would defeat 100% branch).
  const total = metric.values.reduce(
    (sum: number, v: { value: number }) => sum + v.value,
    0,
  );
  return {
    enabled: _status.enabled,
    key_source: _status.key_source,
    key_fingerprint: _status.key_fingerprint,
    decrypt_failures_total: total,
  };
}
