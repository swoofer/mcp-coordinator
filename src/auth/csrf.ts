import crypto from "node:crypto";

// 256-bit random CSRF token (RFC 4648 base64url; URL-safe; ~43 chars unpadded).
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Random double-submit verification.
// SameSite=Strict + __Host- + CSP carry the rest of the CSRF defense
// (see V4 spec patches CUT 2 - HMAC binding was cut as over-engineering).
//
// crypto.timingSafeEqual throws on unequal-length inputs (which would
// leak length via the throw vs. compare time delta). Guard with an
// explicit length check first so both branches return cleanly.
export function verifyCsrfToken(
  cookieValue: string | undefined,
  formValue: string | undefined,
): boolean {
  if (!cookieValue || !formValue) return false;
  const cookieBuf = Buffer.from(cookieValue, "utf8");
  const formBuf = Buffer.from(formValue, "utf8");
  if (cookieBuf.length !== formBuf.length) return false;
  return crypto.timingSafeEqual(cookieBuf, formBuf);
}
