import { describe, it, expect } from "vitest";
import {
  IdPTokenRevoked,
  IdPTransientError,
  IdPScopeInsufficient,
  ProviderCapabilityError,
} from "../../src/auth/providers/errors.js";
import type {
  IdPProvider,
  ExchangeCodeResult,
  DeviceCodeResponse,
  DevicePollResult,
  UserId,
  OrgId,
  Jti,
  FamilyId,
  DeviceCode,
  UserCode,
} from "../../src/auth/providers/types.js";

describe("IdP error classes", () => {
  it("IdPTokenRevoked: constructs, has stable code, instanceof works", () => {
    const e = new IdPTokenRevoked();
    expect(e).toBeInstanceOf(IdPTokenRevoked);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("IDP_TOKEN_REVOKED");
    expect(e.name).toBe("IdPTokenRevoked");
    expect(e.message).toBe("IdP access token revoked");
  });

  it("IdPTokenRevoked: accepts custom message", () => {
    const e = new IdPTokenRevoked("custom reason");
    expect(e.message).toBe("custom reason");
    expect(e.code).toBe("IDP_TOKEN_REVOKED");
  });

  it("IdPTransientError: constructs, has stable code, instanceof works", () => {
    const e = new IdPTransientError();
    expect(e).toBeInstanceOf(IdPTransientError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("IDP_TRANSIENT");
    expect(e.name).toBe("IdPTransientError");
  });

  it("IdPScopeInsufficient: carries requiredScope and has stable code", () => {
    const e = new IdPScopeInsufficient("read:org");
    expect(e).toBeInstanceOf(IdPScopeInsufficient);
    expect(e.code).toBe("IDP_SCOPE_INSUFFICIENT");
    expect(e.requiredScope).toBe("read:org");
    expect(e.name).toBe("IdPScopeInsufficient");
    expect(e.message).toContain("read:org");
  });

  it("IdPScopeInsufficient: accepts custom message override", () => {
    const e = new IdPScopeInsufficient("read:org", "need higher scope");
    expect(e.requiredScope).toBe("read:org");
    expect(e.message).toBe("need higher scope");
  });

  it("ProviderCapabilityError: carries capability and has stable code", () => {
    const e = new ProviderCapabilityError("device_flow");
    expect(e).toBeInstanceOf(ProviderCapabilityError);
    expect(e.code).toBe("PROVIDER_CAPABILITY_MISSING");
    expect(e.capability).toBe("device_flow");
    expect(e.name).toBe("ProviderCapabilityError");
    expect(e.message).toContain("device_flow");
  });

  it("error classes are mutually distinct via instanceof", () => {
    const revoked = new IdPTokenRevoked();
    const transient = new IdPTransientError();
    expect(revoked).not.toBeInstanceOf(IdPTransientError);
    expect(transient).not.toBeInstanceOf(IdPTokenRevoked);
  });
});

describe("IdPProvider interface shape", () => {
  it("a minimal provider can be constructed with only the required members", () => {
    const minimal: IdPProvider = {
      name: "minimal",
      buildAuthUrl: () => "https://idp.example/auth",
      exchangeCode: async (): Promise<ExchangeCodeResult> => ({
        user: { idp_user_id: "u-1", email: "u1@example.com" },
        accessToken: "tok-1",
      }),
    };
    expect(minimal.name).toBe("minimal");
    expect(minimal.listMemberships).toBeUndefined();
    expect(minimal.requestDeviceCode).toBeUndefined();
    expect(minimal.pollDeviceToken).toBeUndefined();
  });

  it("a full provider can implement all optional methods", () => {
    const full: IdPProvider = {
      name: "full",
      buildAuthUrl: () => "https://idp.example/auth",
      exchangeCode: async () => ({
        user: { idp_user_id: "u-2", email: "u2@example.com" },
        accessToken: "tok-2",
      }),
      listMemberships: async () => ["org-a", "org-b"],
      requestDeviceCode: async (): Promise<DeviceCodeResponse> => ({
        device_code: "dc",
        user_code: "WDJB-MJHT",
        verification_uri: "https://idp.example/device",
        expires_in: 900,
        interval: 5,
      }),
      pollDeviceToken: async (): Promise<DevicePollResult> => ({
        status: "authorization_pending",
      }),
    };
    expect(typeof full.listMemberships).toBe("function");
    expect(typeof full.requestDeviceCode).toBe("function");
    expect(typeof full.pollDeviceToken).toBe("function");
  });

  it("DevicePollResult granted variant carries user and accessToken", async () => {
    const granted: DevicePollResult = {
      status: "granted",
      user: { idp_user_id: "u-3", email: "u3@example.com" },
      accessToken: "tok-3",
    };
    expect(granted.status).toBe("granted");
    if (granted.status === "granted") {
      expect(granted.user.idp_user_id).toBe("u-3");
      expect(granted.accessToken).toBe("tok-3");
    }
  });
});

describe("branded ID types", () => {
  // These are compile-time tests: tsc --noEmit is the assertion engine.
  // The `@ts-expect-error` directives below would themselves error if the
  // types ever became structurally assignable.
  it("branded types are nominal at the type level", () => {
    const u: UserId = "u-1" as UserId;
    const o: OrgId = "o-1" as OrgId;
    const j: Jti = "j-1" as Jti;
    const f: FamilyId = "f-1" as FamilyId;
    const dc: DeviceCode = "dc-1" as DeviceCode;
    const uc: UserCode = "WDJB-MJHT" as UserCode;

    // @ts-expect-error UserId is not assignable to OrgId
    const wrong1: OrgId = u;
    // @ts-expect-error OrgId is not assignable to UserId
    const wrong2: UserId = o;
    // @ts-expect-error Jti is not assignable to FamilyId
    const wrong3: FamilyId = j;
    // @ts-expect-error DeviceCode is not assignable to UserCode
    const wrong4: UserCode = dc;
    // @ts-expect-error a plain string cannot satisfy UserId without a cast
    const wrong5: UserId = "raw-string";

    // Reference the values so the compiler does not flag them as unused.
    void wrong1;
    void wrong2;
    void wrong3;
    void wrong4;
    void wrong5;
    void f;
    void uc;

    // At runtime brands are erased: the underlying value is just a string.
    expect(typeof u).toBe("string");
    expect(typeof o).toBe("string");
  });
});
