import { describe, it, expect } from "vitest";
import { assessPlanQuality } from "../../src/plan-quality.js";

/**
 * #351 — this file was stored double-encoded UTF-8 with a BOM, so every
 * accented character in a fixture was mojibake: "améliorer" sat on disk as
 * "amÃ©liorer", "Créer" as "CrÃ©er". The test on the `cré` stem therefore
 * exercised nothing — it passed on "Ajouter" alone, and the one stem with an
 * accent trap had zero real coverage. Fixed here, with the trap itself pinned.
 *
 * Three tests were also titled "BUG:" and commented against a `vaguePatterns`
 * regex that does not exist in src/plan-quality.ts (zero occurrences). The
 * assertions were valid regression guards; only the titles lied about why.
 */

describe("PlanQuality", () => {
  it("returns discovery for null plan", () => {
    const result = assessPlanQuality(null);
    expect(result.mode).toBe("discovery");
    expect(result.score).toBe(0);
  });

  it("returns discovery for empty plan", () => {
    const result = assessPlanQuality("");
    expect(result.mode).toBe("discovery");
  });

  it("returns discovery for vague plan", () => {
    const result = assessPlanQuality("Modifier le fichier pour améliorer les performances");
    expect(result.mode).toBe("discovery");
    expect(result.score).toBeLessThan(2);
  });

  it("returns with_plan for specific plan", () => {
    const result = assessPlanQuality(
      "Ajouter un champ optionnel role_permissions: string[] dans src/shared/types.ts à l'interface User. Créer un type UserPublic sans ce champ pour les routes API dans src/api/routes.ts.",
    );
    expect(result.mode).toBe("with_plan");
    expect(result.score).toBeGreaterThanOrEqual(2);
    expect(result.checks.mentions_files).toBe(true);
    expect(result.checks.concrete_approach).toBe(true);
    expect(result.checks.sufficient_detail).toBe(true);
  });

  it("returns discovery for short plan without files", () => {
    const result = assessPlanQuality("Refactorer le module auth");
    expect(result.mode).toBe("discovery");
  });

  it("returns with_plan when 2 of 3 checks pass", () => {
    // Mentions files + concrete approach but short
    const result = assessPlanQuality(
      "Ajouter refreshToken dans src/auth/middleware.ts après createToken",
    );
    expect(result.mode).toBe("with_plan");
    expect(result.score).toBeGreaterThanOrEqual(2);
  });

  it("a leading vague word does not disqualify a plan full of concrete actions", () => {
    // Regression guard. An earlier implementation ANDed the concrete check
    // with a `vaguePatterns` regex anchored at ^, so a plan opening on "Fix"
    // scored concrete_approach false however concrete the rest was. That
    // regex is gone; this pins that it stays gone.
    const plan =
      "Fix the module by adding a new validation handler in src/auth/validate.ts and creating a separate error boundary for the login flow that replaces the old middleware";
    const result = assessPlanQuality(plan);
    expect(result.checks.mentions_files).toBe(true);
    expect(result.checks.sufficient_detail).toBe(true);
    expect(result.checks.concrete_approach).toBe(true);
  });

  it("the same holds for a plan opening on 'Update'", () => {
    const plan =
      "Update by implementing new cache in src/cache/redis.ts with wrapper pattern for all existing calls to the database layer";
    const result = assessPlanQuality(plan);
    expect(result.checks.concrete_approach).toBe(true);
  });
});

describe("PlanQuality — accents (#351)", () => {
  // The mojibake hid this entirely: `cré` was the one stem whose match
  // depended on an accent, and no test exercised it.
  it("recognises créer, accented or not", () => {
    const accented = assessPlanQuality("créer un type UserPublic dans src/api/routes.ts");
    const bare = assessPlanQuality("creer un type UserPublic dans src/api/routes.ts");
    expect(accented.checks.concrete_approach).toBe(true);
    expect(bare.checks.concrete_approach).toBe(true);
  });

  it("recognises implémenter, accented or not", () => {
    // This one was already symmetric — `implémen` and `implement` both listed.
    // Pinned so the two stay consistent with each other.
    for (const plan of [
      "implémenter la validation dans src/auth/validate.ts",
      "implementer la validation dans src/auth/validate.ts",
    ]) {
      expect(assessPlanQuality(plan).checks.concrete_approach).toBe(true);
    }
  });

  it("still says no when there is no action verb at all", () => {
    // The point is not that every verb should match — measured, the verb
    // decides 0 of 40 realistic verdicts. It is that the accent should not.
    const result = assessPlanQuality("Le module auth et son fichier src/auth/index.ts");
    expect(result.checks.concrete_approach).toBe(false);
  });
});

describe("PlanQuality — the 20-word threshold (#351)", () => {
  // Documented rather than changed. Measured over 83 real plans, truncating
  // the same text at 20 vs 25 words swings the verdict from 36 % with_plan to
  // 87 %. The threshold is calibrated against nothing — no repo has a non-empty
  // threads.plan row and no doc shows a plan example — but no gate depends on
  // the verdict either, so recalibrating would be guessing with a schema
  // migration attached. This pins current behaviour so a future change is
  // deliberate rather than accidental.
  const twentyWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");

  it("20 words is not sufficient detail; 21 is", () => {
    expect(assessPlanQuality(twentyWords).checks.sufficient_detail).toBe(false);
    expect(assessPlanQuality(`${twentyWords} more`).checks.sufficient_detail).toBe(true);
  });

  it("a short plan that names a file and an action still passes", () => {
    // The instrument's real weakness: it cannot tell a good short plan from a
    // bad one. It gets this one right because two checks carry it.
    const result = assessPlanQuality("Ajouter refreshToken dans src/auth/middleware.ts");
    expect(result.checks.sufficient_detail).toBe(false);
    expect(result.mode).toBe("with_plan");
  });
});
