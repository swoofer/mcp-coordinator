import { describe, it, expect } from "vitest";
import { assertAllowedEndpointOrigin } from "../../src/auth/providers/oidc.js";
import { parseExtraOrigins, isLoopbackHostname } from "../../src/boot.js";

/**
 * issue #304 — the discovery document decides where the client_secret goes.
 *
 * `getDiscovery()` cross-checked only the document's own `issuer` field, then
 * took `authorization_endpoint`, `token_endpoint` and `jwks_uri` verbatim. That
 * check protects nothing: whoever controls the document controls `issuer` too,
 * so it passes for free. The reproduction in the issue served a document whose
 * issuer matched exactly and whose token_endpoint pointed at a collector, and
 * watched the client_secret, the code and the PKCE verifier arrive there.
 */
const ISSUER = "https://idp.example.com";

describe("assertAllowedEndpointOrigin", () => {
  it("accepts an endpoint on the issuer's own origin", () => {
    expect(() =>
      assertAllowedEndpointOrigin("token_endpoint", `${ISSUER}/oauth2/token`, ISSUER),
    ).not.toThrow();
  });

  it("accepts a sub-path — Keycloak realms live several segments deep", () => {
    expect(() =>
      assertAllowedEndpointOrigin(
        "token_endpoint",
        "https://kc.example.com/realms/x/protocol/openid-connect/token",
        "https://kc.example.com",
      ),
    ).not.toThrow();
  });

  it("refuses the attack from the issue: same issuer field, foreign token endpoint", () => {
    expect(() =>
      assertAllowedEndpointOrigin("token_endpoint", "http://127.0.0.1:3221/steal", ISSUER),
    ).toThrow(/not the issuer's origin/);
  });

  it("refuses a different port on the same host — an origin is scheme+host+port", () => {
    expect(() =>
      assertAllowedEndpointOrigin("token_endpoint", "https://idp.example.com:8443/token", ISSUER),
    ).toThrow(/not the issuer's origin/);
  });

  it("refuses cloud metadata and internal addresses without an IP denylist", () => {
    // Worth stating: these fall out of the origin rule, they are not special
    // cases. The collector in the reproduction was on a PUBLIC ip, which is
    // why an IP-range guard would not have stopped the actual attack.
    for (const bad of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/token",
      "http://[::1]:9/token",
    ]) {
      expect(() => assertAllowedEndpointOrigin("token_endpoint", bad, ISSUER)).toThrow();
    }
  });

  it("accepts a declared extra origin — Google really does split its endpoints", () => {
    // accounts.google.com issues; oauth2.googleapis.com serves the token
    // endpoint; www.googleapis.com serves the JWKS. Refusing that outright
    // would make the guard unusable against a real IdP.
    const issuer = "https://accounts.google.com";
    const extra = ["https://oauth2.googleapis.com", "https://www.googleapis.com"];
    expect(() =>
      assertAllowedEndpointOrigin(
        "token_endpoint",
        "https://oauth2.googleapis.com/token",
        issuer,
        extra,
      ),
    ).not.toThrow();
    expect(() =>
      assertAllowedEndpointOrigin(
        "jwks_uri",
        "https://www.googleapis.com/oauth2/v3/certs",
        issuer,
        extra,
      ),
    ).not.toThrow();
  });

  it("still refuses an origin the operator did NOT declare", () => {
    expect(() =>
      assertAllowedEndpointOrigin(
        "token_endpoint",
        "https://evil.example.com/token",
        "https://accounts.google.com",
        ["https://oauth2.googleapis.com"],
      ),
    ).toThrow(/not the issuer's origin/);
  });

  it("names the escape hatch in the error, so a legitimate split is fixable", () => {
    expect(() =>
      assertAllowedEndpointOrigin("jwks_uri", "https://cdn.example.net/keys", ISSUER),
    ).toThrow(/COORDINATOR_OIDC_EXTRA_ORIGINS/);
  });

  it("rejects an unparseable endpoint rather than letting it through", () => {
    expect(() => assertAllowedEndpointOrigin("token_endpoint", "not a url", ISSUER)).toThrow(
      /not a valid URL/,
    );
  });
});

describe("parseExtraOrigins", () => {
  it("defaults to strict: unset and empty both mean issuer-origin only", () => {
    expect(parseExtraOrigins(undefined)).toEqual([]);
    expect(parseExtraOrigins("")).toEqual([]);
    expect(parseExtraOrigins("  ,  ")).toEqual([]);
  });

  it("splits and trims a comma-separated list", () => {
    expect(parseExtraOrigins("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("isLoopbackHostname", () => {
  it("recognises the forms an e2e fixture or a local Keycloak actually uses", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.0.53", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });

  it("does not treat a routable host as loopback", () => {
    for (const h of ["idp.example.com", "10.0.0.1", "169.254.169.254", "127acme.example.com"]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

/**
 * Found in adversarial review of the fix above, all three reproduced before
 * being fixed. A security guard whose own review finds nothing is a guard
 * nobody attacked.
 */
describe("holes found reviewing the guard itself (#304)", () => {
  it("refuses an endpoint with no usable origin, whatever the allowlist says", () => {
    // data:, file: and every other non-special scheme serialise to the literal
    // string "null". Membership questions must never be asked about them.
    for (const bad of ["data:application/json,{}", "file:///etc/passwd"]) {
      expect(() => assertAllowedEndpointOrigin("token_endpoint", bad, ISSUER)).toThrow(
        /no usable origin/,
      );
    }
  });

  it("refuses an allowlist entry written without a scheme", () => {
    // `oauth2.googleapis.com:443` is how people spell an origin, and it parses
    // to "null" — which would then have matched every data:/file: endpoint a
    // poisoned document could name. A typo must not widen the guard.
    expect(() =>
      assertAllowedEndpointOrigin("token_endpoint", `${ISSUER}/token`, ISSUER, [
        "oauth2.googleapis.com:443",
      ]),
    ).toThrow(/no usable origin/);
  });

  it("a scheme typo in the allowlist is refused, not silently accepted", () => {
    expect(() =>
      assertAllowedEndpointOrigin("token_endpoint", `${ISSUER}/token`, ISSUER, [
        "htps://oauth2.googleapis.com",
      ]),
    ).toThrow(/no usable origin/);
  });
});

describe("isLoopbackHostname — names that merely look numeric (#304)", () => {
  it("does not treat a registrable name starting with 127. as loopback", () => {
    // The first version prefix-matched the string, so these public DNS names
    // were handed the http exemption. `nip.io` resolves for anyone.
    for (const h of ["127.evil.example.com", "127.0.0.1.nip.io", "127.example"]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });

  it("accepts the loopback spellings a real deployment uses", () => {
    for (const h of ["localhost", "localhost.", "127.0.0.1", "127.0.0.53", "::1", "[::1]"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });

  it("accepts IPv4-mapped loopback in both spellings", () => {
    expect(isLoopbackHostname("[::ffff:127.0.0.1]")).toBe(true);
    expect(isLoopbackHostname("::ffff:7f00:1")).toBe(true);
  });

  it("does not accept a mapped address outside 127/8", () => {
    expect(isLoopbackHostname("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackHostname("::ffff:a00:1")).toBe(false);
  });

  it("does not accept an ordinary IPv6 address", () => {
    // Not ::1 and not IPv4-mapped: a global-unicast or link-local address is
    // as routable as any name, and must not inherit the http exemption.
    expect(isLoopbackHostname("2001:db8::1")).toBe(false);
    expect(isLoopbackHostname("[fe80::1]")).toBe(false);
    expect(isLoopbackHostname("::")).toBe(false);
  });
});

describe("parseExtraOrigins — fail at boot, not at first login (#304)", () => {
  it("rejects an entry with no scheme", () => {
    expect(() => parseExtraOrigins("oauth2.googleapis.com")).toThrow(/not a valid URL/);
  });

  it("rejects an entry that parses to an opaque origin", () => {
    expect(() => parseExtraOrigins("oauth2.googleapis.com:443")).toThrow(/no usable origin/);
  });

  it("still accepts a well-formed list", () => {
    expect(parseExtraOrigins("https://oauth2.googleapis.com, https://www.googleapis.com")).toEqual([
      "https://oauth2.googleapis.com",
      "https://www.googleapis.com",
    ]);
  });
});
