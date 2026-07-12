export type ValidationCode =
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "TOO_LONG"
  | "TOO_SHORT"
  | "CONTROL_BYTES"
  | "INVALID_ROLE"
  | "UNKNOWN_FIELD"
  | "EMPTY_BODY"
  | "BAD_ID";

export class AdminValidationError extends Error {
  readonly code: ValidationCode;
  readonly field?: string;
  constructor(code: ValidationCode, field?: string) {
    // CRITICAL (PATCH 11): never echo user input in the message.
    // Code-only message; callers add request_id for cross-reference.
    super(field ? `${code}:${field}` : code);
    this.name = "AdminValidationError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Validate a string field. Reject if not a string, too long (>maxBytes UTF-8),
 * too short (<1 byte), or contains control bytes (\x00-\x1F except \t \n \r).
 */
export function validateNameField(value: unknown, field: string, maxBytes = 200): string {
  if (value === undefined || value === null) {
    throw new AdminValidationError("MISSING_FIELD", field);
  }
  if (typeof value !== "string") {
    throw new AdminValidationError("WRONG_TYPE", field);
  }
  if (value.length === 0) {
    throw new AdminValidationError("TOO_SHORT", field);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new AdminValidationError("TOO_LONG", field);
  }
  // Reject control bytes except whitespace-ish (\t \n \r still allowed;
  // \v \f rejected; everything <0x20 except those rejected). Also reject DEL (0x7F).
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      throw new AdminValidationError("CONTROL_BYTES", field);
    }
    if (c === 0x7f) {
      throw new AdminValidationError("CONTROL_BYTES", field);
    }
  }
  return value;
}

/**
 * Validate a nullable allowlist field. null is explicitly allowed (clears the value).
 * Same rules as validateNameField otherwise.
 */
export function validateAllowlistField(
  value: unknown,
  field: string,
  maxBytes = 200,
): string | null {
  if (value === null) return null;
  return validateNameField(value, field, maxBytes);
}

/**
 * Validate a role assignment.
 */
export function validateRoleField(value: unknown, field = "role"): "admin" | "member" {
  if (value !== "admin" && value !== "member") {
    throw new AdminValidationError("INVALID_ROLE", field);
  }
  return value;
}

/**
 * Validate URL path param (org id or user id). Must be ASCII alphanumerics +
 * underscore + hyphen, 1-64 chars. Rejects empty or anything with `/`, `?`, `#`.
 */
export function validatePathParam(value: string, field = "id"): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new AdminValidationError("BAD_ID", field);
  }
  return value;
}

/**
 * Validate that the body has at least one of the allowed-update fields, and
 * no unknown fields.
 */
export function validateUpdateBody<T extends Record<string, unknown>>(
  body: T,
  allowedFields: readonly (keyof T)[],
): void {
  const keys = Object.keys(body);
  if (keys.length === 0) {
    throw new AdminValidationError("EMPTY_BODY");
  }
  for (const key of keys) {
    if (!allowedFields.includes(key as keyof T)) {
      throw new AdminValidationError("UNKNOWN_FIELD", key);
    }
  }
  // At least one allowed field present (since keys.length > 0 and none are unknown)
}
