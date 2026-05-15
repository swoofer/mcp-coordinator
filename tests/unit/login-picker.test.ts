import { describe, it, expect } from "vitest";
import { renderLoginPicker } from "../../src/auth/pages/login-picker.html.js";

describe("renderLoginPicker", () => {
  it("renders one button per provider in insertion order", () => {
    const html = renderLoginPicker(["github", "google", "oidc"]);
    const githubIdx = html.indexOf("/auth/login?provider=github");
    const googleIdx = html.indexOf("/auth/login?provider=google");
    const oidcIdx = html.indexOf("/auth/login?provider=oidc");
    expect(githubIdx).toBeGreaterThan(-1);
    expect(googleIdx).toBeGreaterThan(-1);
    expect(oidcIdx).toBeGreaterThan(-1);
    expect(githubIdx).toBeLessThan(googleIdx);
    expect(googleIdx).toBeLessThan(oidcIdx);
  });

  it("uses friendly labels for known providers", () => {
    const html = renderLoginPicker(["github", "google", "oidc"]);
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Single Sign-On");
  });

  it("title-cases unknown provider names", () => {
    const html = renderLoginPicker(["okta", "azure-ad"]);
    expect(html).toContain("Continue with Okta");
    expect(html).toContain("Continue with Azure Ad");
  });

  it("escapes provider names in href and label", () => {
    // A name containing an HTML special char must not leak as raw markup.
    // (The registry would reject this in practice; the test asserts the
    // picker's defense-in-depth escaping.)
    const html = renderLoginPicker(['evil"><script>alert(1)</script>']);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes accessible group label", () => {
    const html = renderLoginPicker(["github", "google"]);
    expect(html).toMatch(/role="group"/);
    expect(html).toMatch(/aria-label="Sign-in providers"/);
  });

  it("emits valid HTML5 doctype + lang attribute", () => {
    const html = renderLoginPicker(["github"]);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
  });

  it("returns empty button list when no providers given (edge case)", () => {
    // handleAuthLogin never calls renderLoginPicker with size=0, but
    // the function should not throw if it ever does.
    const html = renderLoginPicker([]);
    expect(html).not.toContain("/auth/login?provider=");
    expect(html).toContain("<title>Sign in");
  });
});
