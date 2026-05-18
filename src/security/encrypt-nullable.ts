import type { EncryptionProvider, EncryptionContext } from "./encryption.js";

export function encryptNullable(
  provider: EncryptionProvider,
  value: string | null | undefined,
  context: EncryptionContext,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return provider.encrypt(value, context);
}

export function decryptNullable(
  provider: EncryptionProvider,
  value: string | null,
  context: EncryptionContext,
): string | null {
  if (value === null) return null;
  return provider.decrypt(value, context);
}
