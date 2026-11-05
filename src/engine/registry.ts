import { androidLogRules } from "../rules/android/log-rules.js";
import { androidRuntimeRules } from "../rules/android/runtime-rules.js";
import { postRules } from "../rules/common/fallback-rules.js";
import { commonProjectRules } from "../rules/common/project-rules.js";
import { runtimeRules } from "../rules/common/runtime-rules.js";
import { expoLogRules } from "../rules/expo/log-rules.js";
import { expoProjectRules } from "../rules/expo/project-rules.js";
import { iosLogRules } from "../rules/ios/log-rules.js";
import { iosProjectRules } from "../rules/ios/project-rules.js";
import { androidProjectRules, androidSetupRules } from "../rules/android/setup-rules.js";
import { installRules } from "../rules/javascript/install-rules.js";
import { metroRules } from "../rules/javascript/metro-rules.js";
import type { PostRule, Rule, RuleMeta } from "./rule.js";

export const projectRules: Rule[] = [
  ...commonProjectRules,
  ...expoProjectRules,
  ...iosProjectRules,
  ...androidProjectRules,
];
export const logRules: Rule[] = [
  ...androidLogRules,
  ...androidSetupRules,
  ...expoLogRules,
  ...metroRules,
  ...installRules,
  ...iosLogRules,
  ...runtimeRules,
  ...androidRuntimeRules,
];
export { postRules };

export function allRuleMeta(): RuleMeta[] {
  return [...projectRules, ...logRules, ...postRules].map((r: Rule | PostRule) => r.meta);
}
