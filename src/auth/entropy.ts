// Boot-time secret entropy check. Refuses obvious garbage:
// - all-zero / all-same-byte buffers
// - dictionary words ("change-me", "secret", "password", "default")
// - low Shannon entropy
//
// Used by T29 boot validation. Returns void; throws on rejection.

const DICTIONARY = new Set([
  "change-me",
  "changeme",
  "change_me",
  "secret",
  "password",
  "passw0rd",
  "default",
  "test",
  "dev",
  "12345678",
  "abcdefgh",
]);

/**
 * Minimum word length for the *substring* half of the dictionary check (#386).
 *
 * The dictionary is applied two ways. A secret that **is** a listed word is
 * always refused, whatever its length. A secret that merely **contains** one is
 * refused only when the word is long enough that an accidental collision is not
 * a real event.
 *
 * Without that floor the two short entries rejected legitimate secrets: a
 * 44-character `openssl rand -base64 32` collides with "dev" or "test"
 * about once in 900 (measured, 222 hits over 200k samples, 97% of them "dev"),
 * and `mcp-coordinator doctor` recommends exactly that recipe in its own hint.
 * The failure was doubly misleading: it reported a weak secret where there was
 * only a substring collision, and the same function gates boot.
 *
 * At 6 characters the longest remaining risk is "secret", around one in 27
 * million — measured at 0 over 300k samples — while every embedded-weak-word
 * case the rule exists for ("mypassword123", "xxchange-mexx") is still refused.
 * Matching on equality alone would have let those four through, which is why
 * the substring half is kept rather than dropped.
 */
const MIN_SUBSTRING_MATCH_LEN = 6;

export function assertSecretEntropy(buf: Buffer, minBits: number = 128): void {
  if (buf.length === 0) throw new Error("secret entropy: empty buffer");

  // 1. All-same-byte rejection
  const first = buf[0];
  if (buf.every((b) => b === first)) {
    throw new Error("secret entropy: all bytes identical");
  }

  // 2. Dictionary word rejection (case-insensitive)
  const asString = buf.toString("utf8").toLowerCase();
  for (const word of DICTIONARY) {
    const isTheWord = asString === word;
    const embedsTheWord = word.length >= MIN_SUBSTRING_MATCH_LEN && asString.includes(word);
    if (isTheWord || embedsTheWord) {
      throw new Error(`secret entropy: contains dictionary word "${word}"`);
    }
  }

  // 3. Shannon entropy estimate (bits per byte * length).
  // For uniform random bytes, expected entropy ~ 8 bits/byte. We require
  // (minBits / length) bits/byte, so for default 128 bits and a 32-byte
  // secret that's 4 bits/byte -- well below random, but catches structured
  // input like repeated patterns or ASCII-only secrets.
  const counts = new Map<number, number>();
  for (const b of buf) counts.set(b, (counts.get(b) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  const totalBits = h * buf.length;
  if (totalBits < minBits) {
    throw new Error(`secret entropy: ${totalBits.toFixed(1)} bits estimated, minimum ${minBits}`);
  }
}
