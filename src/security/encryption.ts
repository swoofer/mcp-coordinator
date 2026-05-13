export interface EncryptionContext {
  org_id: string;
  column: string;
}

export interface EncryptionProvider {
  /** Encrypt a value for storage. Returns base64 ciphertext in real impls. */
  encrypt(plaintext: string, context: EncryptionContext): string;
  /** Decrypt a base64 ciphertext. Throws on wrong key / corruption. */
  decrypt(ciphertext: string, context: EncryptionContext): string;
  /** Stable HMAC for indexing on encrypted columns without leaking plaintext. */
  hmac(value: string, context: EncryptionContext): string;
}

export class PassthroughEncryption implements EncryptionProvider {
  encrypt(p: string, _context: EncryptionContext): string { return p; }
  decrypt(c: string, _context: EncryptionContext): string { return c; }
  hmac(v: string, _context: EncryptionContext): string { return v; }
}
