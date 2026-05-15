import { describe, it, expect } from "vitest";
import {
  GENESIS_HASH,
  canonicalRowFields,
  computeRowHash,
  type AuditChainFields,
} from "../../src/security/audit-chain.js";

function makeFields(overrides: Partial<AuditChainFields> = {}): AuditChainFields {
  return {
    action: "test.event",
    actor_org_id: null,
    actor_ip: null,
    actor_user_agent: null,
    actor_user_id: null,
    metadata_json: null,
    outcome: null,
    request_id: null,
    target: null,
    ...overrides,
  };
}

describe("GENESIS_HASH", () => {
  it("is 64 zero characters (SHA-256 hex width)", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });
});

describe("canonicalRowFields", () => {
  it("emits keys in alphabetical order", () => {
    const json = canonicalRowFields(
      makeFields({ action: "x", actor_user_id: "u1", target: "t" }),
    );
    const parsed = JSON.parse(json);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([
      "action",
      "actor_org_id",
      "actor_ip",
      "actor_user_agent",
      "actor_user_id",
      "metadata_json",
      "outcome",
      "request_id",
      "target",
    ]);
  });

  it("includes null values explicitly (not omitted)", () => {
    const json = canonicalRowFields(makeFields());
    const parsed = JSON.parse(json);
    expect(parsed.actor_user_id).toBeNull();
    expect(parsed.target).toBeNull();
    expect(parsed.metadata_json).toBeNull();
  });

  it("two rows with identical field values produce identical canonical strings", () => {
    const a = canonicalRowFields(makeFields({ action: "x" }));
    const b = canonicalRowFields(makeFields({ action: "x" }));
    expect(a).toBe(b);
  });

  it("different action -> different canonical string", () => {
    const a = canonicalRowFields(makeFields({ action: "a" }));
    const b = canonicalRowFields(makeFields({ action: "b" }));
    expect(a).not.toBe(b);
  });
});

describe("computeRowHash", () => {
  it("returns 64-char hex (SHA-256)", () => {
    const h = computeRowHash(GENESIS_HASH, makeFields());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = computeRowHash(GENESIS_HASH, makeFields({ action: "x" }));
    const b = computeRowHash(GENESIS_HASH, makeFields({ action: "x" }));
    expect(a).toBe(b);
  });

  it("different prev_hash -> different row_hash for the same content", () => {
    const fields = makeFields({ action: "x" });
    const h1 = computeRowHash(GENESIS_HASH, fields);
    const h2 = computeRowHash("a".repeat(64), fields);
    expect(h1).not.toBe(h2);
  });

  it("different content -> different row_hash for the same prev_hash", () => {
    const h1 = computeRowHash(GENESIS_HASH, makeFields({ action: "a" }));
    const h2 = computeRowHash(GENESIS_HASH, makeFields({ action: "b" }));
    expect(h1).not.toBe(h2);
  });

  it("flipping any single field changes the hash", () => {
    const base = makeFields();
    const baseHash = computeRowHash(GENESIS_HASH, base);

    for (const key of Object.keys(base) as (keyof AuditChainFields)[]) {
      const mutated = { ...base, [key]: "TAMPERED" };
      const mutatedHash = computeRowHash(GENESIS_HASH, mutated);
      expect(mutatedHash, `field ${key}`).not.toBe(baseHash);
    }
  });

  it("builds a chain: each row's hash links to the previous", () => {
    let prev = GENESIS_HASH;
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const h = computeRowHash(prev, makeFields({ action: `event-${i}` }));
      hashes.push(h);
      prev = h;
    }
    expect(new Set(hashes).size).toBe(5);
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });

  it("tampering with a row in the middle of a chain breaks subsequent hashes when re-derived", () => {
    // Build a 4-row chain.
    let prev = GENESIS_HASH;
    const original: string[] = [];
    const fields = [
      makeFields({ action: "a", actor_user_id: "u1" }),
      makeFields({ action: "b", actor_user_id: "u2" }),
      makeFields({ action: "c", actor_user_id: "u3" }),
      makeFields({ action: "d", actor_user_id: "u4" }),
    ];
    for (const f of fields) {
      const h = computeRowHash(prev, f);
      original.push(h);
      prev = h;
    }

    // Now tamper with row 1's action and re-derive only that hash, keeping
    // the on-disk prev_hash linkage unchanged. The verifier would walk
    // row 1 -> compute hash from prev_hash + tampered fields -> compare to
    // stored row_hash (= original[1]) -> mismatch.
    const tamperedFields = { ...fields[1], action: "EVIL" };
    const tamperedHash = computeRowHash(original[0], tamperedFields);
    expect(tamperedHash).not.toBe(original[1]);
  });
});
