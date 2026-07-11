# Upgrade notes

Breaking changes and manual steps required when upgrading between versions.

## Unreleased — JWT `typ` claim enforcement (security fix `securite-auth-01`)

**Breaking:** Access tokens and refresh tokens now carry a `typ` claim
(`"access"` / `"refresh"`) and the server rejects any token whose `typ` does
not match the context it is presented in. This closes a token-type confusion
where a stolen refresh token could be replayed as a session/access credential.

**Impact on upgrade:** Sessions and refresh tokens issued **before** this
release contain no `typ` claim and are rejected fail-closed. On deploy, **all
active users are forced to re-authenticate** and in-flight refresh operations
fail once. There is no data loss; users simply log in again.

**Action required:** None beyond expecting the one-time mass re-login. If you
run behind a load balancer with sticky sessions, consider draining before
deploy to avoid user-visible mid-request failures.
