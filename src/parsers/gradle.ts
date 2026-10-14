import type { LogDocument } from "../collectors/build-logs.js";
import type { Span } from "./types.js";

export interface GradleFailure extends Span {
  /** Task path such as `:app:mergeDebugResources`, when the failure belongs to a task. */
  task?: string;
  /** First line of the "What went wrong" section. */
  headline: string;
  /** Lines of the "What went wrong" section, without the header. */
  details: string[];
}

export interface GradleParseResult {
  detected: boolean;
  outcome?: "failed" | "successful";
  outcomeIndex?: number;
  failures: GradleFailure[];
  /** Tasks Gradle printed as executed, in order (useful for context). */
  lastTaskIndex?: number;
}

const WHAT_WENT_WRONG = /^\s*\*\s*What went wrong:\s*$/;
const SECTION_END =
  /^\s*(?:\*\s*(?:Try|Exception is|Get more help|Where):|BUILD (?:FAILED|SUCCESSFUL)\b|={10,}|\d+:\s+Task failed with an exception\.|-{10,}\s*$)/;
const TASK_LINE = /^> Task :[\w:.-]+/;
const DETECT =
  /(?:^> Task :|^> Configure project|^FAILURE: Build (?:failed|completed)|^BUILD (?:FAILED|SUCCESSFUL) in|Gradle Daemon|^\* What went wrong:|gradlew)/;

export function parseGradle(doc: LogDocument): GradleParseResult {
  const result: GradleParseResult = { detected: false, failures: [] };
  const lines = doc.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!result.detected && DETECT.test(line)) result.detected = true;
    if (TASK_LINE.test(line)) result.lastTaskIndex = i;
    if (/^BUILD FAILED\b/.test(line)) {
      result.outcome = "failed";
      result.outcomeIndex = i;
    } else if (/^BUILD SUCCESSFUL\b/.test(line) && result.outcome !== "failed") {
      result.outcome = "successful";
      result.outcomeIndex = i;
    }
    if (!WHAT_WENT_WRONG.test(line)) continue;

    let end = i + 1;
    while (end < lines.length && !SECTION_END.test(lines[end]!)) end++;
    const details = lines.slice(i + 1, end);
    while (details.length && details[details.length - 1]!.trim() === "") details.pop();
    const headline = details.find((l) => l.trim() !== "")?.trim() ?? "";
    const task = /Execution failed for task '([^']+)'/.exec(details.join("\n"))?.[1];
    result.failures.push({
      start: i,
      end: i + details.length,
      headline,
      details,
      ...(task ? { task } : {}),
    });
    i = end - 1;
  }
  if (result.failures.length) result.detected = true;
  return result;
}
