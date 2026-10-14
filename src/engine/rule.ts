import type { EnvironmentSnapshot } from "../collectors/environment.js";
import type { ProjectContext } from "../detection/project-type.js";
import type { ParsedLog } from "../parsers/index.js";
import type { DraftFinding, Platform } from "../reports/schema.js";

export interface RuleMeta {
  /** Stable identifier; never reuse or rename once released. */
  id: string;
  title: string;
  platforms: Platform[];
  /** `project` rules inspect files and the environment; `log` rules inspect supplied logs. */
  scope: "project" | "log";
  /** The exact condition that triggers the rule. */
  trigger: string;
  /** Evidence attached to every finding. */
  evidence: string;
  /** Tool or framework versions for which the rule is documented. */
  versionScope: string;
  /** Authoritative documentation or issues. */
  references: string[];
  /** Date (YYYY-MM-DD) the rule was last checked against its references. */
  lastVerified: string;
  /** Regression fixtures that must trigger this rule (paths under tests/fixtures). */
  fixtures: string[];
}

export interface RuleContext {
  project?: ProjectContext;
  env?: EnvironmentSnapshot;
  logs: ParsedLog[];
}

export interface Rule {
  meta: RuleMeta;
  run(ctx: RuleContext): DraftFinding[];
}

/** Rules that look at the findings produced by every other rule (fallbacks). */
export interface PostRule {
  meta: RuleMeta;
  run(ctx: RuleContext, findings: DraftFinding[]): DraftFinding[];
}

type FindingFields = Omit<DraftFinding, "ruleId" | "platforms" | "references" | "title"> &
  Partial<Pick<DraftFinding, "platforms" | "references" | "title">>;

/** Creates a finding pre-filled with the rule's id, title, platforms, and references. */
export function finding(meta: RuleMeta, fields: FindingFields): DraftFinding {
  return {
    ruleId: meta.id,
    title: fields.title ?? meta.title,
    platforms: fields.platforms ?? meta.platforms,
    references: fields.references ?? meta.references,
    ...fields,
  };
}
