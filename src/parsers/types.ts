import { lineNumber, type LogDocument } from "../collectors/build-logs.js";
import type { Evidence } from "../reports/schema.js";

/** A span of lines inside a log, using indices into `LogDocument.lines` (end inclusive). */
export interface Span {
  start: number;
  end: number;
}

export const MAX_EXCERPT_LINES = 30;
const MAX_EXCERPT_LINE_CHARS = 500;

/** Builds log evidence for a span, preserving the original file line number. */
export function logEvidence(doc: LogDocument, span: Span, detail?: string): Evidence {
  const end = Math.min(span.end, span.start + MAX_EXCERPT_LINES - 1, doc.lines.length - 1);
  const lines = doc.lines
    .slice(span.start, end + 1)
    .map((l) => (l.length > MAX_EXCERPT_LINE_CHARS ? `${l.slice(0, MAX_EXCERPT_LINE_CHARS)}…` : l));
  // Trim leading/trailing blank lines but keep inner layout.
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return {
    source: "log",
    file: doc.path,
    line: lineNumber(doc, span.start),
    excerpt: lines.join("\n"),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Builds log evidence from selected, possibly non-adjacent lines (for example only the lines of one
 * process in an interleaved logcat). The reported line number is the first selected line.
 */
export function logEvidenceLines(doc: LogDocument, indices: number[], detail?: string): Evidence {
  const picked = indices.slice(0, MAX_EXCERPT_LINES);
  const lines = picked
    .map((i) => doc.lines[i] ?? "")
    .map((l) => (l.length > MAX_EXCERPT_LINE_CHARS ? `${l.slice(0, MAX_EXCERPT_LINE_CHARS)}…` : l));
  return {
    source: "log",
    file: doc.path,
    line: lineNumber(doc, picked[0] ?? 0),
    excerpt: lines.join("\n"),
    ...(detail ? { detail } : {}),
  };
}

/** Finds the first line index at or after `from` matching `pattern`. */
export function findIndex(
  doc: LogDocument,
  pattern: RegExp,
  from = 0,
  to = doc.lines.length - 1,
): number {
  for (let i = Math.max(0, from); i <= Math.min(to, doc.lines.length - 1); i++) {
    if (pattern.test(doc.lines[i]!)) return i;
  }
  return -1;
}

/** Joins wrapped lines of a span into one space-separated string for multi-line matching. */
export function flatten(doc: LogDocument, span: Span): string {
  return doc.lines
    .slice(span.start, span.end + 1)
    .map((l) => l.trim().replace(/^>\s*/, ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * Removes logcat prefixes such as `10-14 20:00:00.000  1234  1240 E AndroidRuntime: `. The thread id
 * (`tid`) is only available in the threadtime format.
 */
export function stripLogcatPrefix(line: string): {
  tag?: string;
  pid?: string;
  tid?: string;
  message: string;
} {
  const threadtime =
    /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+[VDIWEFA]\s+([^:]+?)\s*:\s?(.*)$/.exec(
      line,
    );
  if (threadtime)
    return {
      tag: threadtime[3]!.trim(),
      pid: threadtime[1]!,
      tid: threadtime[2]!,
      message: threadtime[4]!,
    };
  const brief = /^[VDIWEFA]\/([^(:]+?)\s*(?:\(\s*(\d+)\))?:\s?(.*)$/.exec(line);
  if (brief)
    return { tag: brief[1]!.trim(), ...(brief[2] ? { pid: brief[2] } : {}), message: brief[3]! };
  return { message: line };
}
