// T09 — unit tests for dashboard/public/admin-strings.js.
//
// Coverage target: 100% (per-file threshold in vitest.config.ts).
// The module is plain ES — we import it directly with the .js extension
// since vitest's resolver handles that for ESM packages (`"type":"module"`
// in package.json).

import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module without .d.ts; runtime shape is what we assert.
import { STRINGS, t } from "../../dashboard/public/admin-strings.js";

describe("admin-strings.js", () => {
  describe("STRINGS table shape", () => {
    it("exposes the documented top-level sections", () => {
      // Sanity check — these are the section names referenced by the spec
      // and by the admin pages (T10–T12). Renaming any of them is a
      // breaking change that should force a deliberate test update.
      expect(STRINGS).toHaveProperty("pages");
      expect(STRINGS).toHaveProperty("errors");
      expect(STRINGS).toHaveProperty("validation");
      expect(STRINGS).toHaveProperty("actions");
      expect(STRINGS).toHaveProperty("toasts");
    });
  });

  describe("t() — happy path", () => {
    it("resolves a known leaf path", () => {
      expect(t("pages.orgs.title")).toBe("Orgs");
    });

    it("resolves an error-table entry", () => {
      expect(t("errors.LAST_ADMIN")).toBe(
        "Cannot demote the last admin. Promote another user first.",
      );
    });

    it("accepts an empty vars object when no placeholders are present", () => {
      // Regression guard: t() must not crash when vars defaulted to {}.
      expect(t("errors.LAST_ADMIN", {})).toBe(
        "Cannot demote the last admin. Promote another user first.",
      );
    });
  });

  describe("t() — interpolation", () => {
    it("interpolates {name} placeholders", () => {
      expect(t("toasts.welcome", { name: "Alice" })).toBe("Welcome, Alice.");
    });

    it("coerces numeric vars to strings", () => {
      // String() coercion path — guards against `${num}` surprises.
      expect(t("toasts.welcome", { name: 42 })).toBe("Welcome, 42.");
    });

    it("leaves the placeholder literal when the var is missing", () => {
      // Missing var → render `{name}` literally so the bug is visible in
      // the UI rather than silently dropping to "Welcome, undefined.".
      expect(t("toasts.welcome", {})).toBe("Welcome, {name}.");
    });

    it("treats null-valued vars as missing", () => {
      expect(t("toasts.welcome", { name: null as unknown as string })).toBe(
        "Welcome, {name}.",
      );
    });
  });

  describe("t() — error/miss paths", () => {
    it("returns the path itself for an unknown top-level section", () => {
      // Typo helper: surface the bad path in the UI for fast diagnosis.
      expect(t("missing.key")).toBe("missing.key");
    });

    it("returns the path itself for a partially-valid path", () => {
      expect(t("pages.orgs.no_such_field")).toBe(
        "pages.orgs.no_such_field",
      );
    });

    it("returns the path itself when traversal hits a non-object", () => {
      // "pages.orgs.title" resolves to a string, so ".extra" can't descend.
      expect(t("pages.orgs.title.extra")).toBe("pages.orgs.title.extra");
    });

    it("returns the path itself when the resolved value is not a string", () => {
      // Resolving to the section object itself (no leaf) should miss.
      expect(t("pages")).toBe("pages");
    });

    it("works without a vars argument at all", () => {
      // Default-parameter branch — invokes the function with arity 1.
      expect(t("actions.save")).toBe("Save");
    });
  });
});
