import { createHmac } from "node:crypto";

/**
 * HMAC label pinned per V3 PATCH 17. Same label used at every audit emission
 * site so operators can correlate failures across log lines. Changing the
 * label would re-pseudonymize every historical user — treat as a stable
 * public constant.
 */
const HMAC_LABEL = "mcc-audit-pseudonym-v1";

/**
 * Returns the 16-hex-char HMAC pseudonym for a user_id, suitable for
 * embedding in audit metadata in place of the raw id. Deterministic —
 * same user_id always produces the same pseudonym. Pseudonyms are NOT
 * secret (they appear in logs), but they let operators correlate without
 * exposing raw identifiers.
 *
 * SHA-256 truncated to 16 hex chars (= 64 bits): collision probability
 * negligible at the audit-volume scales Phase 2 ships at (~1e6 events).
 */
export function pseudonym(userId: string): string {
  return createHmac("sha256", HMAC_LABEL).update(userId).digest("hex").slice(0, 16);
}
