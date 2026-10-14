import type { PostRule } from "../../engine/rule.js";
import { failureLines, hasParsedFailure, type ParsedLog } from "../../parsers/index.js";
import { logEvidence, type Span } from "../../parsers/types.js";
import type { DraftFinding } from "../../reports/schema.js";

const VERIFIED = "2026-10-14";

export const noSupportedDiagnosis: PostRule = {
  meta: {
    id: "common.no-supported-diagnosis",
    title: "No supported diagnosis for this failure",
    platforms: ["common"],
    scope: "log",
    trigger:
      "A log contains failure markers, but no diagnostic rule produced an error or warning for it.",
    evidence: "The first distinct error lines, so the failure stays visible.",
    versionScope: "All",
    references: [],
    lastVerified: VERIFIED,
    fixtures: ["logs/unknown-error.log"],
  },
  run(ctx, findings) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const diagnosed = findings.some(
        (f) =>
          f.severity !== "info" &&
          f.evidence.some((e) => e.source === "log" && e.file === log.doc.path),
      );
      if (diagnosed) continue;
      // Prefer whole parsed failure sections (e.g. Gradle "What went wrong"), then other error lines.
      const spans: Span[] = log.gradle.failures.map((f) => ({ start: f.start, end: f.end }));
      const covered = (i: number) => spans.some((s) => i >= s.start && i <= s.end);
      const extra = [
        ...failureLines(log, 10),
        ...log.metro.events.map((e) => e.start),
        ...log.xcode.errors.map((e) => e.start),
        ...log.cocoapods.errors.map((e) => e.start),
      ];
      for (const i of [...new Set(extra)].sort((a, b) => a - b)) {
        if (!covered(i) && !/^(?:BUILD FAILED|FAILURE: Build)/.test(log.doc.lines[i]!.trim()))
          spans.push({ start: i, end: i + 2 });
      }
      if (!spans.length) {
        const first = failureLines(log, 1)[0];
        if (first === undefined && !hasParsedFailure(log)) continue;
        spans.push({ start: first ?? 0, end: (first ?? 0) + 2 });
      }
      spans.sort((a, b) => a.start - b.start);
      out.push({
        ruleId: this.meta.id,
        title: this.meta.title,
        platforms: this.meta.platforms,
        references: [],
        severity: "info",
        confidence: "high",
        explanation:
          "The log contains errors, but none match a diagnostic rule this tool supports. Rather than guess, the first error lines are shown below. The earliest specific error is usually the most useful.",
        evidence: spans.slice(0, 5).map((span) => logEvidence(log.doc, span)),
        nextSteps: [
          "Search for the earliest specific error line, not the final 'BUILD FAILED' summary.",
          "Share this report (after reviewing it) when asking for help, or run `rn-build-doctor explain` to get AI suggestions labeled as unverified.",
          "If this is a common failure, consider contributing a rule (see CONTRIBUTING.md).",
        ],
        limitations: ["No diagnosis was made. The excerpts are context, not a cause."],
      });
    }
    return out;
  },
};

/** What the successful log was for, in words. */
function successKind(log: ParsedLog): string {
  if (log.gradle.outcome === "successful") return "build";
  // `pod install` output mentions the .xcodeproj, so check it before Xcode builds.
  if (log.cocoapods.completedIndex !== undefined) return "CocoaPods install";
  if (log.xcode.detected) return "build";
  if (log.metro.successIndex !== undefined) return "JavaScript bundle";
  return "build";
}

export const noFailureDetected: PostRule = {
  meta: {
    id: "common.no-failure-detected",
    title: "No failure detected in the log",
    platforms: ["common"],
    scope: "log",
    trigger: "A log produced no findings and contains no recognizable failure markers.",
    evidence: "Recognized formats and build outcome, when present.",
    versionScope: "All",
    references: [],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-success.log", "logs/real-rn086-metro-bundle-success.log"],
  },
  run(ctx, findings) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const any = findings.some((f) => f.evidence.some((e) => e.file === log.doc.path));
      if (any || failureLines(log, 1).length || hasParsedFailure(log)) continue;
      const success =
        log.gradle.outcome === "successful" ||
        log.metro.successIndex !== undefined ||
        log.cocoapods.completedIndex !== undefined ||
        log.doc.lines.some((l) => /\*\* (?:BUILD|ARCHIVE) SUCCEEDED \*\*/.test(l));
      out.push({
        ruleId: this.meta.id,
        title: success ? "The log shows a successful build" : this.meta.title,
        platforms: this.meta.platforms,
        references: [],
        severity: "info",
        confidence: success ? "high" : "medium",
        explanation: success
          ? `The ${successKind(log)} in this log completed successfully. If the app still fails, the problem happens at runtime. Analyze a device log or crash report instead.`
          : `No error markers were found in ${log.doc.lines.length} lines${log.formats.length ? ` (recognized: ${log.formats.join(", ")})` : ""}. The log may be incomplete, cut off before the failure, or a format this tool doesn't recognize.`,
        evidence: [],
        nextSteps: success
          ? [
              "If the app fails after this, capture the device log while reproducing (`adb logcat -d` on Android, the device console or a crash report on iOS) and analyze that.",
              "If a different build fails, analyze the log of that build.",
            ]
          : [
              "Make sure the log covers the whole failing run. For Gradle, add `--info` or `--stacktrace`. For EAS, download the full build log.",
              "For startup crashes, capture `adb logcat` (Android) or the device console or crash report (iOS).",
            ],
      });
    }
    return out;
  },
};

export const postRules: PostRule[] = [noSupportedDiagnosis, noFailureDetected];
