import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  type EncryptionProvider,
  type EncryptionContext,
  MalformedCiphertext,
  DEKUnwrapFailed,
  DataDecryptFailed,
  UnknownCipherVersion,
} from "./encryption.js";

const PREFIX_V1 = "enc:v1:";
const VERSION_RE = /^enc:v([1-9]\d{0,2}):/; // PATCH 13: 1-999, no leading zeros
const ALG = "aes-256-gcm";

export class EnvelopeEncryption implements EncryptionProvider {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error(
        `EnvelopeEncryption requires a 32-byte master key for AES-256 (got ${masterKey.length}). ` +
          `Generate with: openssl rand -base64 32`,
      );
    }
  }

  encrypt(plaintext: string, context: EncryptionContext): string {
    const dek = randomBytes(32);
    const nonceData = randomBytes(12);
    const cipherData = createCipheriv(ALG, dek, nonceData);
    cipherData.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([
      cipherData.update(plaintext, "utf8"),
      cipherData.final(),
    ]);
    const tagData = cipherData.getAuthTag();

    const nonceDek = randomBytes(12);
    const cipherDek = createCipheriv(ALG, this.masterKey, nonceDek);
    const wrappedDek = Buffer.concat([cipherDek.update(dek), cipherDek.final()]);
    const tagDek = cipherDek.getAuthTag();
    const wrappedDekBlob = Buffer.concat([nonceDek, tagDek, wrappedDek]);

    dek.fill(0);
    const blob = Buffer.concat([wrappedDekBlob, nonceData, tagData, ciphertext]);
    return PREFIX_V1 + blob.toString("base64url");
  }

  decrypt(ciphertext: string, context: EncryptionContext): string {
    const versionMatch = VERSION_RE.exec(ciphertext);
    if (!versionMatch) {
      // No enc:vN: prefix — caller may handle as plaintext (legacy lazy-migration path).
      // But if it starts with literal "enc:v" without matching the strict regex (e.g., enc:v01:, enc:v0:),
      // throw MalformedCiphertext to distinguish from "actually plaintext".
      if (ciphertext.startsWith("enc:v")) {
        throw new MalformedCiphertext(
          `ciphertext has enc:v prefix but version is malformed (must be enc:v1: through enc:v999: with no leading zeros)`,
        );
      }
      return ciphertext;
    }
    const version = versionMatch[1];
    if (version !== "1") {
      throw new UnknownCipherVersion(
        `Cannot decrypt enc:v${version}: prefix. This daemon only understands enc:v1:. ` +
          `Upgrade or roll back the daemon to the version that wrote this row.`,
      );
    }

    let blob: Buffer;
    // Node's Buffer.from base64url is lenient and does not throw on invalid input;
    // this catch is defensive for engines that may tighten validation in the future.
    try {
      blob = Buffer.from(ciphertext.slice(PREFIX_V1.length), "base64url");
    } /* c8 ignore start */ catch (cause) {
      throw new MalformedCiphertext("base64url decode failed", { cause });
    } /* c8 ignore stop */
    if (blob.length < 88) {
      throw new MalformedCiphertext(
        `ciphertext too short (got ${blob.length} bytes, need >=88)`,
      );
    }

    const nonceDek = blob.subarray(0, 12);
    const tagDek = blob.subarray(12, 28);
    const wrappedDek = blob.subarray(28, 60);
    const nonceData = blob.subarray(60, 72);
    const tagData = blob.subarray(72, 88);
    const dataCt = blob.subarray(88);

    let dek: Buffer;
    try {
      const decipherDek = createDecipheriv(ALG, this.masterKey, nonceDek);
      decipherDek.setAuthTag(tagDek);
      dek = Buffer.concat([decipherDek.update(wrappedDek), decipherDek.final()]);
    } catch (cause) {
      throw new DEKUnwrapFailed(
        "wrapped DEK authentication failed — wrong master key or corrupted wrap header",
        { cause },
      );
    }

    try {
      const decipherData = createDecipheriv(ALG, dek, nonceData);
      decipherData.setAuthTag(tagData);
      decipherData.setAAD(this.aad(context));
      const pt = Buffer.concat([decipherData.update(dataCt), decipherData.final()]);
      return pt.toString("utf8");
    } catch (cause) {
      throw new DataDecryptFailed(
        "ciphertext authentication failed — data corruption or AAD mismatch (cross-row/column swap?)",
        { cause },
      );
    } finally {
      dek.fill(0);
    }
  }

  private aad(context: EncryptionContext): Buffer {
    const org = Buffer.from(context.org_id, "utf8");
    const col = Buffer.from(context.column, "utf8");
    const usr = Buffer.from(context.user_id, "utf8");
    if (org.length > 65535 || col.length > 65535 || usr.length > 65535) {
      throw new Error("EncryptionContext field too long for AAD (>65535 bytes)");
    }
    const buf = Buffer.alloc(1 + 2 + org.length + 2 + col.length + 2 + usr.length);
    let o = 0;
    buf.writeUInt8(0x01, o);
    o += 1;
    buf.writeUInt16BE(org.length, o);
    o += 2;
    org.copy(buf, o);
    o += org.length;
    buf.writeUInt16BE(col.length, o);
    o += 2;
    col.copy(buf, o);
    o += col.length;
    buf.writeUInt16BE(usr.length, o);
    o += 2;
    usr.copy(buf, o);
    o += usr.length;
    return buf;
  }
}
