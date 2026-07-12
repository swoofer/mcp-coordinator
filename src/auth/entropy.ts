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
    if (asString === word || asString.includes(word)) {
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
