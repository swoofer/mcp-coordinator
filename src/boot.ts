import type Database from "better-sqlite3";
import { assertSecretEntropy } from "./auth/entropy.js";
import { deriveStateBindingKey } from "./auth/crypto-keys.js";
import { buildJwtKeyRegistry } from "./auth/jwt-keys.js";
import { GitHubProvider } from "./auth/providers/github.js";
import { GitHubAppProvider } from "./auth/providers/github-app.js";
import { GoogleProvider } from "./auth/providers/google.js";
import { OIDCProvider } from "./auth/providers/oidc.js";
import { ProviderRegistry } from "./auth/providers/registry.js";
import { MembershipCache, type SharedMembershipStore } from "./auth/membership-cache.js";
import { RateLimiter, type IRateLimiter } from "./auth/rate-limit.js";
import { RedisRateLimiter } from "./auth/rate-limit-redis.js";
import { acquireOrRenewLock, type RedisHandles } from "./infra/redis.js";
import { randomUUID } from "node:crypto";
import { initAuditQueue, getAuditQueue, audit } from "./security/audit.js";
import { initPhase2Auth } from "./auth.js";
import { bumpTokenEpochAllUsers } from "./auth/token-epoch.js";
import { realClock, type Clock } from "./auth/clock.js";
import { Sweeper } from "./sweeper/index.js";
import type { AuthHandlerContext } from "./auth/context.js";
import { createLogger, type Logger } from "./observability/logger.js";
import {
  loadEncryptionKey,
  runEncryptionGuards,
  buildWrappedProvider,
  registerPlaintextReminder,
  BootValidationError,
} from "./boot-encryption.js";

// Re-export so existing consumers (tests, serve-http, etc.) keep working.
export { BootValidationError };

// T29: Phase 2 boot. This module is the integration glue that activates
// Phase 2 features on the live HTTP server. It is the ONLY module (besides
// org-settings.ts shim and cookies.ts pre-shim escape hatch) allowed to read
// process.env.COORDINATOR_* directly — that's its job, and the lint allowlist
// reflects that (see scripts/lint-no-direct-env-in-auth.sh).
//
// Refs: V3 §4 env list, V4 §16.3 (NR12 restore detection), V3 §B-NEW-4
// (bootstrap org row).

export interface Phase2BootOptions {
  /** When false (default), Phase 2 is not initialized; bootPhase2 returns null. */
  enabled: boolean;
  db: Database.Database;
  clock?: Clock;
  /** Phase 5 multi-instance: when set (COORDINATOR_REDIS_URL), the rate
   *  limiter, membership cache and sweeper switch to their Redis-backed /
   *  leader-elected variants. Absent = in-memory single-instance (unchanged). */
  redis?: RedisHandles;
}

export interface Phase2Bootstrap {
  context: AuthHandlerContext;
  sweeper: Sweeper;
  shutdown: () => Promise<void>;
}

/**
 * Injectable dependencies for bootPhase2 (T01 plan V2). All fields are
 * optional — when omitted, each resolves to the existing global default
 * (opts.db / process.env / a freshly-created Pino logger). Tests inject
 * fakes to exercise boot in isolation from process state.
 */
export interface BootPhase2Deps {
  db?: Database.Database;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

const MIN_JWT_SECRET_BITS = 128;
const RESTORE_DETECTION_STALE_THRESHOLD_S = 300; // 5 minutes
const DRAIN_TIMEOUT_MS = 5000;

/**
 * Phase 2 boot. Returns null if COORDINATOR_OAUTH_ENABLED != "true" (Phase 1
 * compatibility). On enabled-true, validates env, composes ServerContext,
 * runs NR12 restore detection, starts sweeper, wires audit queue +
 * authenticateRequest cookie path.
 *
 * Throws on validation failure — boot must NOT silently activate with
 * weak/missing secrets.
 */
export function bootPhase2(opts: Phase2BootOptions, deps?: BootPhase2Deps): Phase2Bootstrap | null {
  if (!opts.enabled) return null;

  const clock = opts.clock ?? realClock;
  // T01 plan V2: resolve injectable deps with ?? fallback to existing
  // globals so existing callers (which pass no deps) are unaffected.
  const db = deps?.db ?? opts.db;
  const env = deps?.env ?? process.env;
  const logger = deps?.logger ?? createLogger({ level: "silent" });

  // architecture-10: the entire Phase 2 subsystem (src/auth/, src/admin/)
  // bypasses the DatabaseAdapter abstraction via a cast to the
  // better-sqlite3 surface and relies on better-sqlite3-only APIs (e.g.
  // `transaction().immediate()`) that bun:sqlite does not implement. The
  // GitHub Releases binaries are Bun-compiled (see src/database.ts's Bun
  // detection at initDatabase()), so Bun + OAuth enabled is a combination
  // that has never been exercised end to end and risks an untested runtime
  // failure deep in a request handler rather than a clear boot error. Fail
  // fast here, before any Phase 2 env validation or DB access, so the
  // operator gets one unambiguous error instead of a cryptic crash later.
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    throw new BootValidationError(
      "OAuth (Phase 2) is not supported on the Bun runtime: the auth/admin " +
        "subsystem uses better-sqlite3 APIs absent from bun:sqlite. Run the " +
        "Node build (npm/Docker) with OAuth, or disable " +
        "COORDINATOR_OAUTH_ENABLED on the Bun binary.",
    );
  }

  // 1. Required env vars (V3 §4). Only the JWT secret and public URL are
  //    unconditionally required. IdP provider credentials are optional so a
  //    Google-only (or OIDC-only) deployment can boot; at least one provider
  //    must still end up registered — enforced after all providers wire up.
  const jwtSecret = readRequiredEnv(env, "COORDINATOR_JWT_SECRET");
  const publicUrl = readRequiredEnv(env, "COORDINATOR_PUBLIC_URL");

  // GitHub OAuth App credentials: optional, both-or-neither (like Google).
  const githubClientId = readOptionalEnv(env, "COORDINATOR_GITHUB_CLIENT_ID");
  const githubClientSecret = readOptionalEnv(env, "COORDINATOR_GITHUB_CLIENT_SECRET");
  if (Boolean(githubClientId) !== Boolean(githubClientSecret)) {
    throw new BootValidationError(
      "COORDINATOR_GITHUB_CLIENT_ID and COORDINATOR_GITHUB_CLIENT_SECRET must both be set, or both unset",
    );
  }
  const githubConfigured = Boolean(githubClientId && githubClientSecret);

  // COORDINATOR_GITHUB_ORG is the OAuth-App membership allowlist. Required
  // iff the GitHub OAuth App is configured (without it, GitHub sign-in
  // matches no org and every GitHub login is denied). Ignored otherwise.
  const githubOrg = githubConfigured ? readRequiredEnv(env, "COORDINATOR_GITHUB_ORG") : undefined;

  logger.debug({ public_url: publicUrl }, "bootPhase2: env resolved");

  // 2. Validate PUBLIC_URL format. http:// non-localhost requires an explicit
  //    COORDINATOR_INSECURE_COOKIES=true override to pass THIS check — see
  //    V3 §4.2 and src/auth/cookies.ts. securite-auth-05: despite the name,
  //    the flag does NOT drop the Secure flag from Phase 2 session/CSRF
  //    cookies — those are __Host--prefixed (hostCookie() in cookies.ts),
  //    which RFC 6265bis mandates always carry Secure. The flag only
  //    widens THIS boot gate; warnOnInsecureCookiesFlag() below disarms the
  //    footgun (operator boots successfully over http:// non-localhost,
  //    then every Set-Cookie is silently dropped by the browser).
  validatePublicUrl(publicUrl, env);
  warnOnInsecureCookiesFlag(env, logger);

  // 3. Validate JWT secret entropy (T08b assertSecretEntropy).
  const secretBuf = Buffer.from(jwtSecret, "utf8");
  assertSecretEntropy(secretBuf, MIN_JWT_SECRET_BITS);

  // 4. Bootstrap orgs row(s) are seeded later (step 6b), once we know which
  //    providers are configured — GitHub seeds allowlist_github_org, Google
  //    seeds allowlist_idp_org_id. See ensureBootstrapOrg below.

  // 5. NR12 restore detection — refuse boot if audit_log is more than
  //    5 minutes stale relative to wall clock, unless explicitly overridden.
  performRestoreCheck(db, clock, env);

  // 6. Compose Phase 2 components.
  const stateBindingKey = deriveStateBindingKey(secretBuf);

  // Optional prev secret for rotation overlap (v0.8.1+). When set, registers
  // under kid "hs256-v0" verify-only so existing sessions don't immediately
  // 401 when JWT_SECRET is rotated. See docs/ops/key-rotation.md.
  let prevSecretBuf: Buffer | undefined;
  const prevSecret = env.COORDINATOR_JWT_SECRET_PREV;
  if (prevSecret && prevSecret.trim() !== "") {
    // Entropy validation: prev MUST also meet the bar (operators should never
    // rotate FROM a weak secret either — the entropy check applies to both).
    prevSecretBuf = Buffer.from(prevSecret, "utf8");
    assertSecretEntropy(prevSecretBuf, MIN_JWT_SECRET_BITS);
  }
  const signingKeys = buildJwtKeyRegistry(secretBuf, prevSecretBuf);
  // Phase 5: Redis-backed swaps via the pre-marked DI seams. Without redis,
  // the in-memory implementations are constructed exactly as before.
  const rateLimiter: IRateLimiter = opts.redis
    ? new RedisRateLimiter(opts.redis.client, clock)
    : new RateLimiter(clock);
  // performance-06: sweep() existed but nothing ever called it, so `buckets`
  // grew unbounded (one entry per unauth'd IP/key hitting rate-limited
  // endpoints). Wire it here, next to construction. Only the in-memory
  // RateLimiter needs this — the Redis-backed limiter relies on native key
  // TTLs and has no sweeper of its own.
  if (rateLimiter instanceof RateLimiter) {
    rateLimiter.startSweeper();
  }
  const sharedMembershipStore: SharedMembershipStore | undefined = opts.redis
    ? {
        get: (key) => opts.redis!.client.get(`coordinator:mc:${key}`),
        setex: async (key, ttlS, value) => {
          await opts.redis!.client.setEx(`coordinator:mc:${key}`, ttlS, value);
        },
      }
    : undefined;
  const membershipCache = new MembershipCache(clock, undefined, sharedMembershipStore);

  // GHES support (v0.8.1-P2): both optional. Unset/empty → GitHubProvider
  // defaults (github.com / api.github.com) take over. Conditional spread so we
  // never pass undefined into the config object — the constructor's `?? DEFAULT`
  // fallback only fires when the key is absent.
  const githubAuthBaseUrl = env.COORDINATOR_GITHUB_AUTH_BASE_URL?.trim();
  const githubApiBaseUrl = env.COORDINATOR_GITHUB_API_BASE_URL?.trim();
  if (githubAuthBaseUrl) {
    validateGithubBaseUrl(githubAuthBaseUrl, "COORDINATOR_GITHUB_AUTH_BASE_URL");
  }
  if (githubApiBaseUrl) {
    validateGithubBaseUrl(githubApiBaseUrl, "COORDINATOR_GITHUB_API_BASE_URL");
  }
  // T45 (v0.9.0): provider registry. Each provider registers iff its env
  // vars are present. The picker UI activates (T48) whenever
  // providers.size() > 1; the FIRST registered provider is the implicit
  // default. GitHub registers first when configured, so it stays the
  // default for existing GitHub deployments; a Google-only deployment gets
  // Google as its default. At least one provider is required (checked below).
  const providers = new ProviderRegistry();

  if (githubConfigured) {
    providers.register(
      new GitHubProvider({
        clientId: githubClientId!,
        clientSecret: githubClientSecret!,
        ...(githubAuthBaseUrl ? { authBaseUrl: githubAuthBaseUrl } : {}),
        ...(githubApiBaseUrl ? { apiBaseUrl: githubApiBaseUrl } : {}),
      }),
    );
  }

  // T47 (v0.9.0): GoogleProvider. Opt-in via env. Both client_id and
  // client_secret are required; presence of only one is a config error
  // so the deployment fails closed at boot rather than half-registering.
  const googleClientId = env.COORDINATOR_GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.COORDINATOR_GOOGLE_CLIENT_SECRET?.trim();
  if (googleClientId || googleClientSecret) {
    if (!googleClientId || !googleClientSecret) {
      throw new BootValidationError(
        "COORDINATOR_GOOGLE_CLIENT_ID and COORDINATOR_GOOGLE_CLIENT_SECRET must both be set, or both unset",
      );
    }
    providers.register(
      new GoogleProvider({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      }),
    );
  }
  const googleConfigured = Boolean(googleClientId && googleClientSecret);

  // COORDINATOR_GOOGLE_WORKSPACE_DOMAIN seeds the Google allowlist org
  // (orgs.allowlist_idp_org_id = the Workspace hosted-domain `hd` claim), so
  // a Google-only deployment can bootstrap its first admin without hand-
  // inserting a row. Meaningless without Google configured — fail closed.
  const googleWorkspaceDomain = readOptionalEnv(env, "COORDINATOR_GOOGLE_WORKSPACE_DOMAIN");
  if (googleWorkspaceDomain && !googleConfigured) {
    throw new BootValidationError(
      "COORDINATOR_GOOGLE_WORKSPACE_DOMAIN is set but Google OAuth is not configured " +
        "(set COORDINATOR_GOOGLE_CLIENT_ID and COORDINATOR_GOOGLE_CLIENT_SECRET)",
    );
  }

  // T54 (v0.10.0): GitHubAppProvider. Opt-in via env; both client_id +
  // client_secret required together, same fail-closed pattern as Google.
  // GHES base URLs are SHARED with GitHubProvider since GitHub Apps and
  // OAuth Apps live at the same hostnames in GHES.
  const githubAppClientId = env.COORDINATOR_GITHUB_APP_CLIENT_ID?.trim();
  const githubAppClientSecret = env.COORDINATOR_GITHUB_APP_CLIENT_SECRET?.trim();
  const githubAppName = env.COORDINATOR_GITHUB_APP_NAME?.trim();
  // T57: COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE controls whether
  // the allowlist drives off /user/orgs (default) or
  // /user/installations (App-footprint-as-allowlist). Validated only
  // when the App provider is registered.
  const githubAppAllowlistSource = env.COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE?.trim();
  if (githubAppClientId || githubAppClientSecret) {
    if (!githubAppClientId || !githubAppClientSecret) {
      throw new BootValidationError(
        "COORDINATOR_GITHUB_APP_CLIENT_ID and COORDINATOR_GITHUB_APP_CLIENT_SECRET must both be set, or both unset",
      );
    }
    let allowlistSourceParsed: "user_orgs" | "user_installations" | undefined;
    if (githubAppAllowlistSource) {
      if (
        githubAppAllowlistSource !== "user_orgs" &&
        githubAppAllowlistSource !== "user_installations"
      ) {
        throw new BootValidationError(
          `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE must be "user_orgs" or "user_installations", got "${githubAppAllowlistSource}"`,
        );
      }
      allowlistSourceParsed = githubAppAllowlistSource;
    }
    providers.register(
      new GitHubAppProvider({
        clientId: githubAppClientId,
        clientSecret: githubAppClientSecret,
        ...(githubAuthBaseUrl ? { authBaseUrl: githubAuthBaseUrl } : {}),
        ...(githubApiBaseUrl ? { apiBaseUrl: githubApiBaseUrl } : {}),
        ...(githubAppName ? { name: githubAppName } : {}),
        ...(allowlistSourceParsed ? { allowlistSource: allowlistSourceParsed } : {}),
      }),
    );
  }

  // T48 (v0.9.0): generic OIDC. Opt-in via env; issuer_url + client_id
  // + client_secret are all required if ANY is set, same fail-closed
  // posture as Google. Discovery doc is fetched lazily at first use.
  const oidcIssuerUrl = env.COORDINATOR_OIDC_ISSUER_URL?.trim();
  const oidcClientId = env.COORDINATOR_OIDC_CLIENT_ID?.trim();
  const oidcClientSecret = env.COORDINATOR_OIDC_CLIENT_SECRET?.trim();
  // T58: optional groups-claim path enables the "id_token_groups"
  // allowlist strategy. Common values: "groups", "realm_access.roles".
  const oidcGroupsClaim = env.COORDINATOR_OIDC_GROUPS_CLAIM?.trim();
  if (oidcIssuerUrl || oidcClientId || oidcClientSecret) {
    if (!oidcIssuerUrl || !oidcClientId || !oidcClientSecret) {
      throw new BootValidationError(
        "COORDINATOR_OIDC_ISSUER_URL, COORDINATOR_OIDC_CLIENT_ID, and COORDINATOR_OIDC_CLIENT_SECRET must all be set together",
      );
    }
    // Validate issuer URL is http(s) and parseable -- catch typos at
    // boot rather than at first /auth/login.
    try {
      const parsed = new URL(oidcIssuerUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new BootValidationError(
          `COORDINATOR_OIDC_ISSUER_URL must be http:// or https://, got ${parsed.protocol}`,
        );
      }
    } catch (err) {
      if (err instanceof BootValidationError) throw err;
      throw new BootValidationError(
        `COORDINATOR_OIDC_ISSUER_URL is not a valid URL: ${oidcIssuerUrl}`,
      );
    }
    providers.register(
      new OIDCProvider({
        clientId: oidcClientId,
        clientSecret: oidcClientSecret,
        issuerUrl: oidcIssuerUrl,
        ...(oidcGroupsClaim ? { groupsClaim: oidcGroupsClaim } : {}),
      }),
    );
  }

  // 6a. At least one IdP provider must be configured — otherwise /auth/login
  //     has nothing to redirect to (getDefault() === null → 500). Fail closed.
  if (providers.size() === 0) {
    throw new BootValidationError(
      "At least one IdP provider must be configured when COORDINATOR_OAUTH_ENABLED=true: " +
        "set COORDINATOR_GITHUB_CLIENT_ID/SECRET, COORDINATOR_GOOGLE_CLIENT_ID/SECRET, " +
        "COORDINATOR_GITHUB_APP_CLIENT_ID/SECRET, or the COORDINATOR_OIDC_* vars",
    );
  }

  // 6b. Seed bootstrap allowlist org row(s) (idempotent) so the first sign-in
  //     matches an org and becomes admin. GitHub → allowlist_github_org;
  //     Google → allowlist_idp_org_id (Workspace hosted-domain). V3 §B-NEW-4.
  ensureBootstrapOrg(db, { githubOrg, idpOrg: googleWorkspaceDomain });

  // 7. Initialize audit queue (Tier 2 buffered writes; T11b).
  initAuditQueue(db);

  // 7b. Phase 3 (T06a): load master key + run encryption-mode strict guards.
  //     Sits AFTER initAuditQueue so the optional `audit` hook lands in the
  //     real queue, and AFTER performRestoreCheck so we don't tear down rows
  //     a restore would have invalidated anyway. T06b will wrap the raw
  //     provider with first-encrypt fingerprint persistence; T06c adds the
  //     plaintext-bypass reminder. For now we only attach the raw provider.
  const encKey = loadEncryptionKey(env, logger);
  const encInit = runEncryptionGuards({ db, env, logger, audit }, encKey);
  // T06b: wrap the raw provider so the first encrypt() persists the key
  // fingerprint to system_config (idempotent) + emits encryption.config.loaded.
  // In passthrough mode (keyFingerprint=null), buildWrappedProvider returns
  // the raw PassthroughEncryption instance unchanged (reference-equal).
  const wrappedProvider = buildWrappedProvider({
    rawProvider: encInit.rawProvider,
    keyFingerprint: encInit.keyFingerprint,
    fingerprintAlreadyPersisted: encInit.fingerprintAlreadyPersisted,
    db,
    audit,
  });

  // T06c: when no encryption key is set, log a startup warning at the
  // appropriate level + register a 24h recurring reminder. Returns a
  // teardown invoked from Phase2Bootstrap.shutdown to clear the interval.
  const stopReminder = registerPlaintextReminder({ env, logger }, encKey);

  // 8. Wire authenticateRequest cookie path (Scenario 5, spec §9.5).
  initPhase2Auth({ db, signingKeys, publicUrl });

  // 9. Compose AuthHandlerContext for dispatchAuthRoutes.
  const context: AuthHandlerContext = {
    db,
    clock,
    providers,
    rateLimiter,
    publicUrl,
    stateBindingKey,
    signingKeys,
    membershipCache,
    encryptionProvider: wrappedProvider,
    encryptionKeyFingerprint: encInit.keyFingerprint,
  };

  // 10. Start sweeper (60s cadence; T28).
  // Phase 5: leader-elected behind Redis — `SET NX EX` lease (TTL 90s >
  // 60s tick so the incumbent renews; on crash another instance takes over
  // within the TTL). Without redis: unconditional, as before.
  const sweeperOwner = `sweeper-${randomUUID()}`;
  const sweeper = new Sweeper(
    db,
    clock,
    opts.redis
      ? () => acquireOrRenewLock(opts.redis!.client, "coordinator:sweeper:leader", 90, sweeperOwner)
      : undefined,
  );
  sweeper.start();

  // 11. Emit config.boot audit (Tier 1, never drop).
  audit("config.boot", {
    tier: 1,
    metadata: {
      public_url: publicUrl,
      providers: providers.names(),
      github_org: githubOrg ?? null,
      google_workspace_domain: googleWorkspaceDomain ?? null,
    },
  });

  // 11b. Emit config.key_rotation audit when a prev secret is configured
  // (Tier 1; v0.8.1 rotation-overlap support). rotated_at is advisory
  // only — the audit captures the operator-supplied timestamp for
  // correlation across deployments. "unset" sentinel when not provided.
  if (prevSecretBuf) {
    const rotatedAt = env.COORDINATOR_JWT_SECRET_PREV_ROTATED_AT ?? "unset";
    audit("config.key_rotation", {
      tier: 1,
      metadata: {
        rotated_at: rotatedAt,
        current_kid: "hs256-v1",
        prev_kid: "hs256-v0",
      },
    });
  }

  return {
    context,
    sweeper,
    shutdown: async () => {
      // T06c: clear the plaintext-reminder interval first (idempotent,
      // safe across multiple shutdown invocations in tests).
      stopReminder();
      // performance-06: stop the RateLimiter bucket sweeper alongside the
      // other Phase 2 timers. stopSweeper() is idempotent. Only the
      // in-memory limiter has a sweeper to stop.
      if (rateLimiter instanceof RateLimiter) {
        rateLimiter.stopSweeper();
      }
      sweeper.stop();
      await sweeper.drain(DRAIN_TIMEOUT_MS);
      const queue = getAuditQueue();
      if (queue) {
        queue.drain(DRAIN_TIMEOUT_MS);
      }
    },
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new BootValidationError(`${key} is required when COORDINATOR_OAUTH_ENABLED=true`);
  }
  return value;
}

/** Like readRequiredEnv but returns undefined (never throws) when absent or blank. */
function readOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value && value.trim() !== "" ? value : undefined;
}

function validatePublicUrl(url: string, env: NodeJS.ProcessEnv): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BootValidationError(`COORDINATOR_PUBLIC_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BootValidationError(
      `COORDINATOR_PUBLIC_URL must be http:// or https://, got ${parsed.protocol}`,
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalhost(parsed.hostname) &&
    env.COORDINATOR_INSECURE_COOKIES !== "true"
  ) {
    throw new BootValidationError(
      `COORDINATOR_PUBLIC_URL=${url} uses http:// for non-localhost; ` +
        `set COORDINATOR_INSECURE_COOKIES=true to override (NOT recommended for production)`,
    );
  }
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// securite-auth-05: COORDINATOR_INSECURE_COOKIES=true is a footgun as
// currently named/documented — it reads as "make cookies work over plain
// HTTP", but it only relaxes the validatePublicUrl() boot gate above.
// Phase 2 session/CSRF cookies go through hostCookie() (src/auth/cookies.ts),
// which hardcodes `Secure` unconditionally because the __Host- prefix
// requires it (RFC 6265bis §4.1.3) — getCookieSecureFlag() exists in that
// module but nothing wires it into hostCookie(), so the flag never actually
// changes cookie output. Net effect if an operator sets this for a real
// http:// non-localhost deployment: boot succeeds, but every Set-Cookie is
// silently dropped by the browser (Secure cookie over a non-HTTPS origin)
// and auth just doesn't work, with nothing in the logs to explain why —
// until this warning. Emitted unconditionally (not just for the
// non-localhost case) since a developer relying on it for local HTTP dev
// against a non-localhost hostname (e.g. a LAN IP or a *.local name) hits
// the exact same silent failure.
function warnOnInsecureCookiesFlag(env: NodeJS.ProcessEnv, logger: Logger): void {
  if (env.COORDINATOR_INSECURE_COOKIES !== "true") return;
  logger.warn(
    "COORDINATOR_INSECURE_COOKIES=true is set. This does NOT make Phase 2 " +
      "cookies insecure-friendly: session/CSRF cookies are __Host--prefixed " +
      "and ALWAYS set Secure regardless of this flag (RFC 6265bis). It only " +
      "bypasses the COORDINATOR_PUBLIC_URL http://-non-localhost boot check. " +
      "Serving Phase 2 over plain HTTP on a non-localhost origin means " +
      "browsers will silently reject those cookies and auth will appear " +
      "broken. Dev-only; never set this in production.",
  );
}

// GHES env-var validator. Same format check as PUBLIC_URL — must parse + must
// be http(s). Unlike PUBLIC_URL we do NOT enforce localhost-or-https here: a
// GHES instance commonly lives on https://github.<corp>, and a private dev
// GHES could legitimately run on plain http for testing.
function validateGithubBaseUrl(url: string, varName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BootValidationError(`${varName} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BootValidationError(`${varName} must be http:// or https://, got ${parsed.protocol}`);
  }
}

function ensureBootstrapOrg(
  db: Database.Database,
  opts: { githubOrg?: string; idpOrg?: string },
): void {
  // Per V3 §B-NEW-4: seed a bootstrap org row for each configured allowlist
  // strategy so the first sign-in can match an org and become admin.
  if (opts.githubOrg) seedAllowlistOrg(db, "allowlist_github_org", opts.githubOrg);
  if (opts.idpOrg) seedAllowlistOrg(db, "allowlist_idp_org_id", opts.idpOrg);
}

/**
 * Insert one orgs row keyed on the given allowlist column if none matches
 * (case-insensitive). Idempotent — re-running boot with the same env is a
 * no-op. `column` is a trusted internal literal (never user input), so
 * interpolating it into the SQL is safe.
 */
function seedAllowlistOrg(
  db: Database.Database,
  column: "allowlist_github_org" | "allowlist_idp_org_id",
  value: string,
): void {
  const existing = db.prepare(`SELECT id FROM orgs WHERE LOWER(${column}) = LOWER(?)`).get(value);
  if (!existing) {
    const suffix = Math.random().toString(36).slice(2, 10);
    db.prepare(`INSERT INTO orgs (id, name, ${column}) VALUES (?, ?, ?)`).run(
      `org-${value}-${suffix}`,
      value,
      value,
    );
  }
}

interface MaxEpochRow {
  max_epoch: string | null;
}

function performRestoreCheck(db: Database.Database, clock: Clock, env: NodeJS.ProcessEnv): void {
  // NR12: compare max audit_log.created_at (ISO string) to wall clock.
  // If > 5 min stale → refuse boot UNLESS COORDINATOR_ALLOW_RESTORE=true.
  const row = db
    .prepare("SELECT MAX(strftime('%s', created_at)) AS max_epoch FROM audit_log")
    .get() as MaxEpochRow | undefined;

  const maxEpoch = row?.max_epoch ? Number(row.max_epoch) : null;
  if (maxEpoch === null) return; // empty audit log = fresh deployment

  const now = clock.now();
  const staleSeconds = now - maxEpoch;
  if (staleSeconds <= RESTORE_DETECTION_STALE_THRESHOLD_S) return; // healthy

  if (env.COORDINATOR_ALLOW_RESTORE !== "true") {
    throw new BootValidationError(
      `Restore suspected: audit_log timestamps lag wall-clock by ${staleSeconds}s ` +
        `(threshold: ${RESTORE_DETECTION_STALE_THRESHOLD_S}s). ` +
        `Set COORDINATOR_ALLOW_RESTORE=true after verifying this is a deliberate ` +
        `restore, then unset after boot.`,
    );
  }

  // ALLOW_RESTORE=true: bump every user's token_epoch + emit recovery audits.
  // This invalidates ALL existing sessions across the restored corpus.
  bumpTokenEpochAllUsers(db);
  audit("recovery.token_epoch_global_bump", {
    tier: 1,
    metadata: { stale_seconds: staleSeconds },
  });
  audit("recovery.completed", {
    tier: 1,
    metadata: {
      stale_seconds: staleSeconds,
      threshold_seconds: RESTORE_DETECTION_STALE_THRESHOLD_S,
    },
  });
}
