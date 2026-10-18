import type { LogDocument } from "../collectors/build-logs.js";
import { parseGradle, type GradleParseResult } from "./gradle.js";
import { parseMetro, type MetroParseResult } from "./metro.js";
import { parseRuntime, type RuntimeParseResult } from "./runtime.js";
import {
  parseCocoaPods,
  parseXcode,
  type CocoaPodsParseResult,
  type XcodeParseResult,
} from "./xcode.js";

export interface ParsedLog {
  doc: LogDocument;
  gradle: GradleParseResult;
  metro: MetroParseResult;
  xcode: XcodeParseResult;
  cocoapods: CocoaPodsParseResult;
  runtime: RuntimeParseResult;
  /** Formats recognized in the log, for display. */
  formats: string[];
}

export function parseLog(doc: LogDocument): ParsedLog {
  const gradle = parseGradle(doc);
  const metro = parseMetro(doc);
  const xcode = parseXcode(doc);
  const cocoapods = parseCocoaPods(doc);
  const runtime = parseRuntime(doc);
  const formats: string[] = [];
  if (gradle.detected) formats.push("gradle");
  if (metro.detected || metro.events.length) formats.push("metro");
  if (xcode.detected) formats.push("xcode");
  if (cocoapods.detected) formats.push("cocoapods");
  if (runtime.androidFatals.length) formats.push("android-runtime");
  if (runtime.iosCrashes.length) formats.push("ios-crash");
  if (runtime.jsExceptions.length || runtime.bundleLoadFailures.length)
    formats.push("javascript-runtime");
  return { doc, gradle, metro, xcode, cocoapods, runtime, formats };
}

/** Patterns that indicate a failure without identifying its cause; used for honest fallbacks. */
export const FAILURE_SIGNALS: RegExp[] = [
  /^FAILURE: Build (?:failed|completed with)/,
  /^BUILD FAILED\b/,
  /\*\* (?:BUILD|ARCHIVE) FAILED \*\*/,
  /^\s*\[!\]\s/,
  /^(?:❌\s+)?(?:fatal )?error:?\s/i,
  /:\d+(?::\d+)?:\s+(?:fatal\s+)?error:\s/,
  /^e: /,
  /^npm ERR!/,
  /^(?:\[\w+\]\s*)?Error:\s/,
  // Error classes Expo CLI prints when it can't read the app config (@expo/config-plugins, @expo/config).
  /^(?:PluginError|ConfigError):\s/,
  /FATAL EXCEPTION/,
  /^Exception Type:/,
  /Build failed\b/i,
  /\bBundling failed\b/i,
  /^(?:error\s+)?(?:SyntaxError|TypeError|ReferenceError):\s/,
  /exited with non-zero (?:exit )?code/i,
  /Command failed with exit code/i,
  /\bfailed with exit code \d+/i,
];

/** True when any parser recognized a failure event in the log. */
export function hasParsedFailure(log: ParsedLog): boolean {
  return (
    log.gradle.failures.length > 0 ||
    log.gradle.outcome === "failed" ||
    log.metro.events.length > 0 ||
    log.xcode.buildFailed ||
    log.xcode.errors.length > 0 ||
    log.cocoapods.errors.length > 0 ||
    log.runtime.jsExceptions.length > 0 ||
    log.runtime.bundleLoadFailures.length > 0 ||
    log.runtime.androidFatals.length > 0 ||
    log.runtime.iosCrashes.length > 0
  );
}

/**
 * Returns indices of lines that look like errors, in order, without duplicates. Lines a parser
 * classified as warnings (such as CocoaPods `[!]` notices) are skipped.
 */
export function failureLines(log: ParsedLog, limit = 5): number[] {
  const doc = log.doc;
  const ignore = new Set(log.cocoapods.notices);
  const found: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < doc.lines.length && found.length < limit; i++) {
    if (ignore.has(i)) continue;
    const line = doc.lines[i]!;
    if (!FAILURE_SIGNALS.some((p) => p.test(line))) continue;
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(i);
  }
  return found;
}
