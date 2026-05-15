import { describe, it, expect } from "vitest";
import {
  bearerAuthHeader,
  oauthError,
  appError,
} from "../../src/http/response-contract.js";
import { withRequestId } from "../../src/auth/request-id.js";

describe("response-contract: bearerAuthHeader", () => {
  it("returns bare realm when called with no args", () => {
    expect(bearerAuthHeader()).toBe('Bearer realm="coordinator"');
  });

  it("adds error code when err provided", () => {
    expect(bearerAuthHeader("invalid_token")).toBe(
      'Bearer realm="coordinator", error="invalid_token"',
    );
  });

  it("adds error_description when description provided", () => {
    expect(bearerAuthHeader("invalid_token", "Token expired")).toBe(
      'Bearer realm="coordinator", error="invalid_token", error_description="Token expired"',
    );
  });

  it("adds scope when scope provided (insufficient_scope)", () => {
    expect(
      bearerAuthHeader("insufficient_scope", "Admin scope required", "admin"),
    ).toBe(
      'Bearer realm="coordinator", error="insufficient_scope", error_description="Admin scope required", scope="admin"',
    );
  });

  it("escapes embedded double quotes in description", () => {
    const h = bearerAuthHeader("invalid_token", 'has a " in it');
    expect(h).toBe(
      'Bearer realm="coordinator", error="invalid_token", error_description="has a \\" in it"',
    );
  });

  it("escapes backslashes in description (backslash escaped first)", () => {
    const h = bearerAuthHeader("invalid_token", "has a \\ in it");
    expect(h).toBe(
      'Bearer realm="coordinator", error="invalid_token", error_description="has a \\\\ in it"',
    );
  });

  it("description without an error code is still included", () => {
    // Optional but defensive: description is appended even without err.
    const h = bearerAuthHeader(undefined, "no error code");
    expect(h).toBe(
      'Bearer realm="coordinator", error_description="no error code"',
    );
  });

  it("scope without description is included", () => {
    const h = bearerAuthHeader("insufficient_scope", undefined, "admin");
    expect(h).toBe(
      'Bearer realm="coordinator", error="insufficient_scope", scope="admin"',
    );
  });
});

describe("response-contract: oauthError", () => {
  it("returns bare envelope when only error code provided", () => {
    expect(oauthError("invalid_grant")).toEqual({ error: "invalid_grant" });
  });

  it("includes description when provided", () => {
    expect(oauthError("invalid_grant", "expired")).toEqual({
      error: "invalid_grant",
      error_description: "expired",
    });
  });

  it("includes error_uri when provided", () => {
    expect(
      oauthError("invalid_grant", "expired", "https://example/docs"),
    ).toEqual({
      error: "invalid_grant",
      error_description: "expired",
      error_uri: "https://example/docs",
    });
  });

  it("includes error_uri without description when description omitted", () => {
    // Pass undefined description but include uri.
    expect(
      oauthError("invalid_request", undefined, "https://example/docs"),
    ).toEqual({
      error: "invalid_request",
      error_uri: "https://example/docs",
    });
  });
});

describe("response-contract: appError", () => {
  it("includes request_id: null outside withRequestId", () => {
    const body = appError("X", "msg");
    expect(body).toEqual({
      code: "X",
      message: "msg",
      request_id: null,
    });
  });

  it("inside withRequestId has the matching request_id", () => {
    withRequestId("req-abc-123", () => {
      const body = appError("X", "msg");
      expect(body).toEqual({
        code: "X",
        message: "msg",
        request_id: "req-abc-123",
      });
    });
  });

  it("includes details when provided", () => {
    const body = appError("E_BAD", "bad input", { field: "name" });
    expect(body).toEqual({
      code: "E_BAD",
      message: "bad input",
      request_id: null,
      details: { field: "name" },
    });
  });

  it("omits details when not provided", () => {
    const body = appError("E_BAD", "bad input");
    expect("details" in body).toBe(false);
  });
});
