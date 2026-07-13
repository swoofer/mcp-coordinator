import { describe, it, expect } from "vitest";
import {
  AdminValidationError,
  validateNameField,
  validateAllowlistField,
  validateRoleField,
  validatePathParam,
  validateUpdateBody,
} from "../../src/admin/validate.js";

describe("AdminValidationError", () => {
  it("is an instance of Error and has name 'AdminValidationError'", () => {
    const err = new AdminValidationError("MISSING_FIELD", "name");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdminValidationError);
    expect(err.name).toBe("AdminValidationError");
  });

  it("sets .code and .field correctly when field is provided", () => {
    const err = new AdminValidationError("WRONG_TYPE", "display_name");
    expect(err.code).toBe("WRONG_TYPE");
    expect(err.field).toBe("display_name");
    expect(err.message).toBe("WRONG_TYPE:display_name");
  });

  it("omits the field portion of message when no field is given", () => {
    const err = new AdminValidationError("EMPTY_BODY");
    expect(err.code).toBe("EMPTY_BODY");
    expect(err.field).toBeUndefined();
    expect(err.message).toBe("EMPTY_BODY");
  });

  it("does NOT echo user input in the message (PATCH 11)", () => {
    // The constructor only accepts a code + optional field name (both static),
    // never the user-supplied value. Confirm message has the documented shape.
    const err = new AdminValidationError("TOO_LONG", "name");
    expect(err.message).toBe("TOO_LONG:name");
    // No way for a runtime payload like "<script>" to appear in the message.
    expect(err.message).not.toMatch(/<|>|script/i);
  });
});

describe("validateNameField", () => {
  it("accepts a normal string and returns it unchanged", () => {
    expect(validateNameField("Acme Corp", "name")).toBe("Acme Corp");
  });

  it("rejects undefined with MISSING_FIELD", () => {
    expect(() => validateNameField(undefined, "name")).toThrow(AdminValidationError);
    try {
      validateNameField(undefined, "name");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("MISSING_FIELD");
      expect((e as AdminValidationError).field).toBe("name");
    }
  });

  it("rejects null with MISSING_FIELD", () => {
    try {
      validateNameField(null, "name");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("MISSING_FIELD");
    }
  });

  it("rejects non-string values with WRONG_TYPE", () => {
    for (const bad of [42, true, [], {}, Symbol("x")]) {
      try {
        validateNameField(bad, "name");
        expect.fail("expected throw");
      } catch (e) {
        expect((e as AdminValidationError).code).toBe("WRONG_TYPE");
      }
    }
  });

  it("rejects empty string with TOO_SHORT", () => {
    try {
      validateNameField("", "name");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("TOO_SHORT");
    }
  });

  it("rejects too-long UTF-8 with TOO_LONG (byte length, not char count)", () => {
    const longStr = "a".repeat(201);
    try {
      validateNameField(longStr, "name");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("TOO_LONG");
    }
  });

  it("accepts a string with exactly maxBytes bytes", () => {
    const exact = "a".repeat(200);
    expect(validateNameField(exact, "name")).toBe(exact);
  });

  it("uses UTF-8 byte length, not char count: 'café' is 5 bytes/4 chars", () => {
    // "café" — c(1) + a(1) + f(1) + é(2) = 5 bytes
    expect(Buffer.byteLength("café", "utf8")).toBe(5);
    expect("café".length).toBe(4);

    // Accepted under maxBytes=5
    expect(validateNameField("café", "name", 5)).toBe("café");

    // Rejected under maxBytes=4
    try {
      validateNameField("café", "name", 4);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("TOO_LONG");
    }
  });

  it("rejects control bytes \\x00, \\x01, \\x1F with CONTROL_BYTES", () => {
    for (const bad of ["\x00", "ok\x00", "\x01", "abc\x1f"]) {
      try {
        validateNameField(bad, "name");
        expect.fail("expected throw");
      } catch (e) {
        expect((e as AdminValidationError).code).toBe("CONTROL_BYTES");
      }
    }
  });

  it("rejects DEL (\\x7F) with CONTROL_BYTES", () => {
    try {
      validateNameField("a\x7fb", "name");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("CONTROL_BYTES");
    }
  });

  it("accepts whitespace control bytes: \\t \\n \\r", () => {
    expect(validateNameField("a\tb", "name")).toBe("a\tb");
    expect(validateNameField("a\nb", "name")).toBe("a\nb");
    expect(validateNameField("a\rb", "name")).toBe("a\rb");
  });

  it("rejects \\v (0x0B) and \\f (0x0C) as control bytes", () => {
    try {
      validateNameField("a\vb", "name");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("CONTROL_BYTES");
    }
    try {
      validateNameField("a\fb", "name");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("CONTROL_BYTES");
    }
  });
});

describe("validateAllowlistField", () => {
  it("accepts null explicitly (clears the value)", () => {
    expect(validateAllowlistField(null, "github_org")).toBeNull();
  });

  it("accepts a valid string and returns it", () => {
    expect(validateAllowlistField("my-org", "github_org")).toBe("my-org");
  });

  it("rejects undefined with MISSING_FIELD", () => {
    try {
      validateAllowlistField(undefined, "github_org");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("MISSING_FIELD");
    }
  });

  it("rejects non-string non-null with WRONG_TYPE", () => {
    try {
      validateAllowlistField(123, "github_org");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("WRONG_TYPE");
    }
  });

  it("rejects empty string with TOO_SHORT", () => {
    try {
      validateAllowlistField("", "github_org");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("TOO_SHORT");
    }
  });

  it("rejects control bytes with CONTROL_BYTES", () => {
    try {
      validateAllowlistField("a\x00b", "github_org");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("CONTROL_BYTES");
    }
  });

  it("rejects too-long strings with TOO_LONG (custom maxBytes)", () => {
    try {
      validateAllowlistField("a".repeat(10), "github_org", 5);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("TOO_LONG");
    }
  });
});

describe("validateRoleField", () => {
  it("accepts 'admin' and 'member'", () => {
    expect(validateRoleField("admin")).toBe("admin");
    expect(validateRoleField("member")).toBe("member");
  });

  it("rejects other strings (agent, service, ADMIN) with INVALID_ROLE", () => {
    for (const bad of ["agent", "service", "ADMIN", "Member", "owner", ""]) {
      try {
        validateRoleField(bad);
        expect.fail("expected throw");
      } catch (e) {
        expect((e as AdminValidationError).code).toBe("INVALID_ROLE");
      }
    }
  });

  it("rejects null/undefined/non-string with INVALID_ROLE", () => {
    for (const bad of [null, undefined, 0, true, {}]) {
      try {
        validateRoleField(bad);
        expect.fail("expected throw");
      } catch (e) {
        expect((e as AdminValidationError).code).toBe("INVALID_ROLE");
      }
    }
  });

  it("uses a custom field name in the error when provided", () => {
    try {
      validateRoleField("nope", "user_role");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).field).toBe("user_role");
      expect((e as AdminValidationError).message).toBe("INVALID_ROLE:user_role");
    }
  });
});

describe("validatePathParam", () => {
  it("accepts alphanumerics, underscore, hyphen", () => {
    expect(validatePathParam("abc123")).toBe("abc123");
    expect(validatePathParam("a_b-c")).toBe("a_b-c");
    expect(validatePathParam("ABC")).toBe("ABC");
  });

  it("accepts a UUID-like string", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(validatePathParam(uuid)).toBe(uuid);
  });

  it("accepts the maximum length (64 chars)", () => {
    const maxLen = "a".repeat(64);
    expect(validatePathParam(maxLen)).toBe(maxLen);
  });

  it("rejects empty with BAD_ID", () => {
    try {
      validatePathParam("");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("BAD_ID");
    }
  });

  it("rejects strings containing '/'", () => {
    try {
      validatePathParam("abc/def");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("BAD_ID");
    }
  });

  it("rejects strings containing '?'", () => {
    try {
      validatePathParam("abc?d");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("BAD_ID");
    }
  });

  it("rejects strings containing '#'", () => {
    try {
      validatePathParam("abc#d");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("BAD_ID");
    }
  });

  it("rejects strings longer than 64 chars", () => {
    try {
      validatePathParam("a".repeat(65));
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("BAD_ID");
    }
  });

  it("uses a custom field name when provided", () => {
    try {
      validatePathParam("bad/id", "org_id");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).field).toBe("org_id");
    }
  });
});

describe("validateUpdateBody", () => {
  it("accepts a body with a subset of allowed fields", () => {
    const body: Record<string, unknown> = { name: "x" };
    expect(() => validateUpdateBody(body, ["name", "display_name"] as const)).not.toThrow();
  });

  it("accepts a body with all allowed fields", () => {
    const body: Record<string, unknown> = { name: "x", display_name: "y" };
    expect(() => validateUpdateBody(body, ["name", "display_name"] as const)).not.toThrow();
  });

  it("rejects an empty body with EMPTY_BODY", () => {
    const body: Record<string, unknown> = {};
    try {
      validateUpdateBody(body, ["name"] as const);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("EMPTY_BODY");
      expect((e as AdminValidationError).field).toBeUndefined();
    }
  });

  it("rejects an unknown field with UNKNOWN_FIELD and includes the key name", () => {
    const body: Record<string, unknown> = { name: "x", evil: "y" };
    try {
      validateUpdateBody(body, ["name"] as const);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("UNKNOWN_FIELD");
      expect((e as AdminValidationError).field).toBe("evil");
    }
  });

  it("rejects when ALL fields are unknown", () => {
    const body: Record<string, unknown> = { foo: 1, bar: 2 };
    try {
      validateUpdateBody(body, ["name"] as const);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AdminValidationError).code).toBe("UNKNOWN_FIELD");
    }
  });
});
