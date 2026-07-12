export interface EncryptionContext {
  org_id: string;
  column: "idp_access_token" | "idp_refresh_token";
  user_id: string;
}

export interface EncryptionProvider {
  /** Encrypt a value for storage. Returns base64 ciphertext in real impls. */
  encrypt(plaintext: string, context: EncryptionContext): string;
  /** Decrypt a base64 ciphertext. Throws on wrong key / corruption. */
  decrypt(ciphertext: string, context: EncryptionContext): string;
}

export class PassthroughEncryption implements EncryptionProvider {
  encrypt(p: string, _context: EncryptionContext): string {
    return p;
  }
  decrypt(c: string, _context: EncryptionContext): string {
    return c;
  }
}

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecryptionError";
  }
}

export class MalformedCiphertext extends DecryptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MalformedCiphertext";
  }
}

export class DEKUnwrapFailed extends DecryptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DEKUnwrapFailed";
  }
}

export class DataDecryptFailed extends DecryptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataDecryptFailed";
  }
}

export class UnknownCipherVersion extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnknownCipherVersion";
  }
}
