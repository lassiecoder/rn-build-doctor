import {
  FindingSchema,
  type DraftFinding,
  type Finding,
  type Severity,
  type Confidence,
} from "../reports/schema.js";
import { logRules, postRules, projectRules } from "./registry.js";
import type { PostRule, Rule, RuleContext } from "./rule.js";

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export interface RunOptions {
  /** Which rule sets to run. */
  project?: boolean;
  logs?: boolean;
  rules?: { project?: Rule[]; log?: Rule[]; post?: PostRule[] };
}

function internalError(ruleId: string, error: unknown): DraftFinding {
  return {
    ruleId: "internal.rule-error",
    title: `Rule ${ruleId} failed to run`,
    severity: "info",
    confidence: "high",
    platforms: ["common"],
    explanation: `The rule threw an unexpected error and was skipped: ${(error as Error)?.message ?? String(error)}. Other results are unaffected.`,
    evidence: [],
    nextSteps: [
      "Please report this at the project's issue tracker with the report attached (after reviewing it).",
    ],
    references: [],
  };
}

function dedupeKey(f: DraftFinding): string {
  const first = f.evidence[0];
  return [f.ruleId, f.title, first?.file ?? "", first?.line ?? "", first?.detail ?? ""].join("|");
}

/** Runs rules deterministically: same input, same findings in the same order. */
export function runRules(ctx: RuleContext, options: RunOptions = {}): Finding[] {
  const drafts: DraftFinding[] = [];
  const run = (rule: Rule) => {
    try {
      drafts.push(...rule.run(ctx));
    } catch (error) {
      drafts.push(internalError(rule.meta.id, error));
    }
  };
  if (options.project && ctx.project) (options.rules?.project ?? projectRules).forEach(run);
  if (options.logs && ctx.logs.length) {
    (options.rules?.log ?? logRules).forEach(run);
    for (const rule of options.rules?.post ?? postRules) {
      try {
        drafts.push(...rule.run(ctx, drafts));
      } catch (error) {
        drafts.push(internalError(rule.meta.id, error));
      }
    }
  }
  return finalize(drafts);
}

export function finalize(drafts: DraftFinding[]): Finding[] {
  const unique = new Map<string, DraftFinding>();
  for (const draft of drafts) {
    const key = dedupeKey(draft);
    if (!unique.has(key)) unique.set(key, draft);
  }
  const sorted = [...unique.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      (a.evidence[0]?.file ?? "").localeCompare(b.evidence[0]?.file ?? "") ||
      (a.evidence[0]?.line ?? 0) - (b.evidence[0]?.line ?? 0) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.title.localeCompare(b.title),
  );
  return sorted.map((draft, index) => {
    const parsed = FindingSchema.safeParse({
      ...draft,
      id: `F${index + 1}`,
      limitations: draft.limitations ?? [],
    });
    if (parsed.success) return parsed.data;
    // A rule produced an invalid finding: surface it rather than emit unvalidated output.
    return FindingSchema.parse({
      ...internalError(
        draft.ruleId,
        new Error(
          `invalid finding: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        ),
      ),
      id: `F${index + 1}`,
      limitations: [],
    });
  });
}
