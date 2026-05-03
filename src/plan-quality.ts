export interface PlanQualityResult {
  mode: "with_plan" | "discovery";
  score: number;       // 0-3
  checks: {
    mentions_files: boolean;
    concrete_approach: boolean;
    sufficient_detail: boolean;
  };
  original_plan: string | null;
}

export function assessPlanQuality(plan: string | null | undefined): PlanQualityResult {
  if (!plan || plan.trim().length === 0) {
    return {
      mode: "discovery",
      score: 0,
      checks: { mentions_files: false, concrete_approach: false, sufficient_detail: false },
      original_plan: null,
    };
  }

  const trimmed = plan.trim();

  // Check 1: Mentions specific files (paths with extensions or slashes)
  const mentions_files = /\w+\/\w+|\.\w{2,4}\b/.test(trimmed);

  // Check 2: Concrete approach — the plan contains concrete action verbs
  // anywhere. Match word stems (no trailing \b) so inflected forms like
  // "adding", "creating", "replaces", "implementing" are recognized.
  // A leading vague word ("Fix", "Update") does NOT disqualify a plan that
  // otherwise describes concrete actions.
  const concretePatterns = /\b(ajout|cré|creat|add|split|extract|replac|remplac|implémen|implement|supprim|delet|remov|migr|wrap)/i;
  const concrete_approach = concretePatterns.test(trimmed);

  // Check 3: Sufficient detail (more than 20 words)
  const wordCount = trimmed.split(/\s+/).length;
  const sufficient_detail = wordCount > 20;

  const score = [mentions_files, concrete_approach, sufficient_detail].filter(Boolean).length;

  return {
    mode: score >= 2 ? "with_plan" : "discovery",
    score,
    checks: { mentions_files, concrete_approach, sufficient_detail },
    original_plan: trimmed,
  };
}
