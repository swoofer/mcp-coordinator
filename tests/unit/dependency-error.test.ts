import { describe, it, expect } from "vitest";
import { explainDependencyFailure, missingModuleFrom } from "../../cli/dependency-error.js";

/**
 * issue #282 — a broken node_modules used to kill the daemon on twelve lines of
 * cjs/loader internals naming `@babel/runtime`, a package nobody declared, four
 * levels below `mqtt`. The repair is one command; finding it took twenty
 * minutes.
 */
describe("missingModuleFrom", () => {
  it("reads the CJS loader phrasing — the shape #282 actually produced", () => {
    const err = Object.assign(
      new Error("Cannot find module '@babel/runtime/helpers/defineProperty'"),
      {
        code: "MODULE_NOT_FOUND",
      },
    );
    expect(missingModuleFrom(err)).toBe("@babel/runtime/helpers/defineProperty");
  });

  it("reads the ESM loader phrasing", () => {
    const err = Object.assign(
      new Error("Cannot find package 'mqtt' imported from /app/dist/src/serve-http.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(missingModuleFrom(err)).toBe("mqtt");
  });

  it("recognises the code even when the message is unusual", () => {
    const err = Object.assign(new Error("something else entirely"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(missingModuleFrom(err)).toBe("unknown");
  });

  it("returns null for an unrelated error", () => {
    expect(missingModuleFrom(new Error("EADDRINUSE: address already in use"))).toBeNull();
    expect(missingModuleFrom(new TypeError("x is not a function"))).toBeNull();
    expect(missingModuleFrom(undefined)).toBeNull();
  });
});

describe("explainDependencyFailure", () => {
  const err = Object.assign(
    new Error("Cannot find module '@babel/runtime/helpers/defineProperty'"),
    {
      code: "MODULE_NOT_FOUND",
    },
  );

  it("names the missing package and the one command that fixes it", () => {
    const out = explainDependencyFailure(err)!;
    expect(out).toContain("@babel/runtime/helpers/defineProperty");
    expect(out).toContain("pnpm install --frozen-lockfile");
  });

  it("says it is probably not the operator's code", () => {
    // The twenty minutes went into suspecting the repo. The message should
    // spend one line preventing that.
    expect(explainDependencyFailure(err)!).toMatch(/not your code/i);
  });

  it("points at doctor, which diagnoses it without a failed start", () => {
    expect(explainDependencyFailure(err)!).toContain("doctor");
  });

  it("returns null for anything else, so the caller rethrows untouched", () => {
    // Load-bearing: swallowing an unrelated crash behind a "run pnpm install"
    // banner sends the operator down the wrong path — the exact failure this
    // is meant to fix, merely relocated.
    expect(explainDependencyFailure(new Error("EADDRINUSE"))).toBeNull();
  });
});
