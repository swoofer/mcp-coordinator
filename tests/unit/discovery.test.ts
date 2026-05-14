import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildDiscoveryDoc, handleDiscovery } from "../../src/discovery.js";

function makeRes() {
  return {
    headers: undefined as Record<string, string> | undefined,
    status: 0,
    body: "",
    writeHead(s: number, h: Record<string, string>) {
      this.status = s;
      this.headers = h;
    },
    end(b: string) {
      this.body = b;
    },
  };
}

describe("buildDiscoveryDoc", () => {
  const url = "https://coord.example.com";

  it("returns all required RFC 8414 fields", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc).toHaveProperty("issuer");
    expect(doc).toHaveProperty("authorization_endpoint");
    expect(doc).toHaveProperty("token_endpoint");
    expect(doc).toHaveProperty("device_authorization_endpoint");
    expect(doc).toHaveProperty("revocation_endpoint");
    expect(doc).toHaveProperty("userinfo_endpoint");
    expect(doc).toHaveProperty("grant_types_supported");
    expect(doc).toHaveProperty("response_types_supported");
    expect(doc).toHaveProperty("code_challenge_methods_supported");
    expect(doc).toHaveProperty("token_endpoint_auth_methods_supported");
    expect(doc).toHaveProperty("revocation_endpoint_auth_methods_supported");
    expect(doc).toHaveProperty("service_documentation");
    expect(doc).toHaveProperty("id_token_signing_alg_values_supported");
  });

  it("strips trailing slash from publicUrl", () => {
    const doc = buildDiscoveryDoc("https://coord.example.com/");
    expect(doc.issuer).toBe("https://coord.example.com");
    expect(doc.authorization_endpoint).toBe("https://coord.example.com/auth/login");
  });

  it("token_endpoint_auth_methods_supported is exactly ['none'] (V4 FIX 12)", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("revocation_endpoint_auth_methods_supported is exactly ['none']", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("code_challenge_methods_supported is exactly ['S256'] (no 'plain')", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.code_challenge_methods_supported).not.toContain("plain");
  });

  it("issuer === publicUrl (after slash strip)", () => {
    expect(buildDiscoveryDoc(url).issuer).toBe(url);
    expect(buildDiscoveryDoc(`${url}/`).issuer).toBe(url);
  });

  it("grant_types_supported includes authorization_code, refresh_token, and device_code URN", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ]);
  });

  it("response_types_supported is ['code'] (no implicit, no token)", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.response_types_supported).not.toContain("token");
    expect(doc.response_types_supported).not.toContain("id_token");
  });

  it("id_token_signing_alg_values_supported is ['HS256'] (Phase 2 jose pinning)", () => {
    const doc = buildDiscoveryDoc(url);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["HS256"]);
  });
});

describe("handleDiscovery", () => {
  const url = "https://coord.example.com";

  it("writes 200 status", () => {
    const r = makeRes();
    handleDiscovery({} as IncomingMessage, r as unknown as ServerResponse, url);
    expect(r.status).toBe(200);
  });

  it("sets Content-Type: application/json; charset=utf-8", () => {
    const r = makeRes();
    handleDiscovery({} as IncomingMessage, r as unknown as ServerResponse, url);
    expect(r.headers!["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("sets Cache-Control with max-age=86400 (24h)", () => {
    const r = makeRes();
    handleDiscovery({} as IncomingMessage, r as unknown as ServerResponse, url);
    expect(r.headers!["Cache-Control"]).toBe("public, max-age=86400");
  });

  it("body is JSON-parseable and equals buildDiscoveryDoc(publicUrl)", () => {
    const r = makeRes();
    handleDiscovery({} as IncomingMessage, r as unknown as ServerResponse, url);
    const parsed = JSON.parse(r.body);
    expect(parsed).toEqual(buildDiscoveryDoc(url));
  });
});
