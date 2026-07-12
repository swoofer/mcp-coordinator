import type { AppErrorEnvelope, OAuthErrorEnvelope } from "./types.js";

/** Base class for all coordinator SDK errors. */
export abstract class CoordinatorError extends Error {
  abstract readonly code: string;
  readonly httpStatus: number;
  readonly requestId: string | null;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    httpStatus: number,
    requestId: string | null,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.details = details;
  }
}

export class UnauthorizedError extends CoordinatorError {
  readonly code = "UNAUTHORIZED" as const;
}

export class ForbiddenError extends CoordinatorError {
  readonly code = "FORBIDDEN" as const;
}

export class RateLimitedError extends CoordinatorError {
  readonly code = "RATE_LIMITED" as const;
  readonly retryAfterSeconds: number | null;
  constructor(
    message: string,
    httpStatus: number,
    requestId: string | null,
    retryAfterSeconds: number | null,
    details?: Record<string, unknown>,
  ) {
    super(message, httpStatus, requestId, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotInAllowlistError extends CoordinatorError {
  readonly code = "NOT_IN_ALLOWLIST" as const;
}

export class UserNotProvisionedError extends CoordinatorError {
  readonly code = "USER_NOT_PROVISIONED" as const;
}

export class LoginLockedError extends CoordinatorError {
  readonly code = "LOGIN_LOCKED" as const;
  readonly retryAfterSeconds: number | null;
  constructor(
    message: string,
    httpStatus: number,
    requestId: string | null,
    retryAfterSeconds: number | null,
    details?: Record<string, unknown>,
  ) {
    super(message, httpStatus, requestId, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class IdpUnavailableError extends CoordinatorError {
  readonly code = "IDP_UNAVAILABLE" as const;
}

export class IdpTokenRevokedError extends CoordinatorError {
  readonly code = "IDP_TOKEN_REVOKED" as const;
}

export class InvalidStateError extends CoordinatorError {
  readonly code = "INVALID_STATE" as const;
}

export class StateAlreadyConsumedError extends CoordinatorError {
  readonly code = "STATE_ALREADY_CONSUMED" as const;
}

export class StateExpiredError extends CoordinatorError {
  readonly code = "STATE_EXPIRED" as const;
}

export class CsrfFailedError extends CoordinatorError {
  readonly code = "CSRF_FAILED" as const;
}

export class NotFoundError extends CoordinatorError {
  readonly code = "NOT_FOUND" as const;
}

/** Generic fallback for unknown error codes. */
export class UnknownCoordinatorError extends CoordinatorError {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    httpStatus: number,
    requestId: string | null,
    details?: Record<string, unknown>,
  ) {
    super(message, httpStatus, requestId, details);
    this.code = code;
  }
}

/** OAuth token-endpoint errors per RFC 6749 §5.2. */
export class OAuthError extends Error {
  readonly oauthError: string;
  readonly errorDescription?: string;
  readonly errorUri?: string;
  readonly httpStatus: number;
  constructor(env: OAuthErrorEnvelope, httpStatus: number) {
    super(env.error_description ?? env.error);
    this.name = "OAuthError";
    this.oauthError = env.error;
    this.errorDescription = env.error_description;
    this.errorUri = env.error_uri;
    this.httpStatus = httpStatus;
  }
}

/** Factory: maps a response envelope to the right subclass. */
export function makeCoordinatorError(
  envelope: AppErrorEnvelope,
  httpStatus: number,
  retryAfterSeconds: number | null = null,
): CoordinatorError {
  const code = envelope.code;
  switch (code) {
    case "UNAUTHORIZED":
      return new UnauthorizedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "FORBIDDEN":
      return new ForbiddenError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "RATE_LIMITED":
      return new RateLimitedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        retryAfterSeconds,
        envelope.details,
      );
    case "NOT_IN_ALLOWLIST":
      return new NotInAllowlistError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "USER_NOT_PROVISIONED":
      return new UserNotProvisionedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "LOGIN_LOCKED":
      return new LoginLockedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        retryAfterSeconds,
        envelope.details,
      );
    case "IDP_UNAVAILABLE":
      return new IdpUnavailableError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "IDP_TOKEN_REVOKED":
      return new IdpTokenRevokedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "INVALID_STATE":
      return new InvalidStateError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "STATE_ALREADY_CONSUMED":
      return new StateAlreadyConsumedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "STATE_EXPIRED":
      return new StateExpiredError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "CSRF_FAILED":
      return new CsrfFailedError(
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
    case "NOT_FOUND":
      return new NotFoundError(envelope.message, httpStatus, envelope.request_id, envelope.details);
    default:
      return new UnknownCoordinatorError(
        code,
        envelope.message,
        httpStatus,
        envelope.request_id,
        envelope.details,
      );
  }
}
