import { describe, it, expect } from "vitest";
import { assessPlanQuality } from "../../src/plan-quality.js";

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
    const result = assessPlanQuality("Modifier le fichier pour amÃ©liorer les performances");
    expect(result.mode).toBe("discovery");
    expect(result.score).toBeLessThan(2);
  });

  it("returns with_plan for specific plan", () => {
    const result = assessPlanQuality(
      "Ajouter un champ optionnel role_permissions: string[] dans src/shared/types.ts Ã  l'interface User. CrÃ©er un type UserPublic sans ce champ pour les routes API dans src/api/routes.ts.",
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
      "Ajouter refreshToken dans src/auth/middleware.ts aprÃ¨s createToken",
    );
    expect(result.mode).toBe("with_plan");
    expect(result.score).toBeGreaterThanOrEqual(2);
  });

  it("BUG: concrete_approach is false when plan starts with vague word but contains concrete actions", () => {
    // "Fix the module by adding a new validation handler in src/auth/validate.ts and creating
    //  a separate error boundary for the login flow that replaces the old middleware"
    // The vaguePatterns regex anchors at ^ so "fix" at the start negates concrete_approach
    // even though the plan clearly contains concrete actions (adding, creating, replaces)
    const plan =
      "Fix the module by adding a new validation handler in src/auth/validate.ts and creating a separate error boundary for the login flow that replaces the old middleware";
    const result = assessPlanQuality(plan);
    expect(result.checks.mentions_files).toBe(true);
    expect(result.checks.sufficient_detail).toBe(true);
    // BUG: concrete_approach should be true (plan contains "adding", "creating", "replaces")
    // but vaguePatterns.test returns true because plan starts with "Fix", so
    // concrete_approach = concretePatterns.test(plan) && !vaguePatterns.test(plan) â†’ false
    expect(result.checks.concrete_approach).toBe(true);
  });

  it("BUG: concrete_approach is false for 'Update by implementing new cache in src/cache/redis.ts with wrapper pattern for all existing calls'", () => {
    const plan =
      "Update by implementing new cache in src/cache/redis.ts with wrapper pattern for all existing calls to the database layer";
    const result = assessPlanQuality(plan);
    // "implement" and "wrapper" are concrete, but "Update" at start triggers vaguePatterns
    expect(result.checks.concrete_approach).toBe(true);
  });
});
