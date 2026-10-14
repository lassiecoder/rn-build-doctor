import { androidLogRules } from "../rules/android/log-rules.js";
import { postRules } from "../rules/common/fallback-rules.js";
import { commonProjectRules } from "../rules/common/project-rules.js";
import { runtimeRules } from "../rules/common/runtime-rules.js";
import { expoProjectRules } from "../rules/expo/project-rules.js";
import { iosLogRules } from "../rules/ios/log-rules.js";
import { metroRules } from "../rules/javascript/metro-rules.js";
import type { PostRule, Rule, RuleMeta } from "./rule.js";

export const projectRules: Rule[] = [...commonProjectRules, ...expoProjectRules];
export const logRules: Rule[] = [
  ...androidLogRules,
  ...metroRules,
  ...iosLogRules,
  ...runtimeRules,
];
export { postRules };

export function allRuleMeta(): RuleMeta[] {
  return [...projectRules, ...logRules, ...postRules].map((r: Rule | PostRule) => r.meta);
}
