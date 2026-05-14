// Stable `code` discriminants let callers branch on error kind without
// relying on `instanceof` across module boundaries (NR3 stable-codes pattern).
// `name` is set explicitly so it survives minification.

export class IdPTokenRevoked extends Error {
  readonly code = "IDP_TOKEN_REVOKED" as const;
  constructor(message = "IdP access token revoked") {
    super(message);
    this.name = "IdPTokenRevoked";
  }
}

export class IdPTransientError extends Error {
  readonly code = "IDP_TRANSIENT" as const;
  constructor(message = "IdP transiently unavailable") {
    super(message);
    this.name = "IdPTransientError";
  }
}

export class IdPScopeInsufficient extends Error {
  readonly code = "IDP_SCOPE_INSUFFICIENT" as const;
  readonly requiredScope: string;
  constructor(requiredScope: string, message?: string) {
    super(message ?? `IdP missing required scope: ${requiredScope}`);
    this.name = "IdPScopeInsufficient";
    this.requiredScope = requiredScope;
  }
}

export class ProviderCapabilityError extends Error {
  readonly code = "PROVIDER_CAPABILITY_MISSING" as const;
  readonly capability: string;
  constructor(capability: string, message?: string) {
    super(message ?? `Provider does not support capability: ${capability}`);
    this.name = "ProviderCapabilityError";
    this.capability = capability;
  }
}
