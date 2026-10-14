import type { LogDocument } from "../collectors/build-logs.js";
import type { Span } from "./types.js";

export interface XcodeError extends Span {
  message: string;
  file?: string;
  position?: string;
}

export interface XcodeParseResult {
  detected: boolean;
  buildFailed: boolean;
  buildFailedIndex?: number;
  errors: XcodeError[];
  /** Lines listed under "The following build commands failed:". */
  failedCommands: { index: number; command: string }[];
}

export interface CocoaPodsError extends Span {
  message: string;
}

export interface CocoaPodsParseResult {
  detected: boolean;
  errors: CocoaPodsError[];
}

const XCODE_DETECT =
  /(?:\bxcodebuild\b|\*\* (?:BUILD|ARCHIVE) (?:FAILED|SUCCEEDED) \*\*|^CompileC |^PhaseScriptExecution |^Ld |^CodeSign |\.xcworkspace|\.xcodeproj|Build Settings from command line)/;
// `/path/File.m:12:5: error: message` (clang, swift, ld wrappers)
const LOCATED_ERROR = /^(.+?):(\d+):(\d+):\s+(?:fatal\s+)?error:\s+(.+)$/;
// xcpretty/EAS drop the "error:" keyword: `❌  /path/File.m:12:5: 'X.h' file not found`
const ICON_LOCATED = /^❌\s+(.+?):(\d+):(\d+):\s+(?:(?:fatal\s+)?error:\s+)?(.+)$/;
// `error: message` or xcpretty/EAS `❌  error: message` / `❌  message`
const PLAIN_ERROR = /^(?:❌\s+)?(?:error|fatal error):\s*(.+)$/;
const ICON_ERROR = /^❌\s+(?!\()(.+)$/;
const LINKER =
  /^(?:ld: .+|Undefined symbols? for architecture .+|clang(?:\+\+)?: error: linker command failed.*)$/;

const POD_DETECT =
  /(?:\bpod install\b|Analyzing dependencies|Installing CocoaPods|Downloading dependencies|Generating Pods project|\[!\] )/;

export function parseXcode(doc: LogDocument): XcodeParseResult {
  const result: XcodeParseResult = {
    detected: false,
    buildFailed: false,
    errors: [],
    failedCommands: [],
  };
  const lines = doc.lines;
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!result.detected && XCODE_DETECT.test(line)) result.detected = true;
    if (/\*\* (?:BUILD|ARCHIVE) FAILED \*\*/.test(line)) {
      result.buildFailed = true;
      result.buildFailedIndex ??= i;
      result.detected = true;
      continue;
    }
    if (/^The following build commands failed:/.test(line)) {
      result.detected = true;
      for (let j = i + 1; j < lines.length; j++) {
        const cmd = lines[j]!.trim();
        if (cmd === "" || /^\(\d+ failures?\)$/.test(cmd)) break;
        result.failedCommands.push({ index: j, command: cmd });
      }
      continue;
    }
    const located = LOCATED_ERROR.exec(line.replace(/^❌\s+/, "")) ?? ICON_LOCATED.exec(line);
    const plain = located ? undefined : PLAIN_ERROR.exec(line);
    const icon = located || plain ? undefined : ICON_ERROR.exec(line);
    const linker = located || plain || icon ? undefined : LINKER.exec(line);
    const match = located ?? plain ?? icon ?? linker;
    if (!match) continue;
    const message = (located ? located[4] : plain ? plain[1] : icon ? icon[1] : linker![0])!.trim();
    const key = `${located?.[1] ?? ""}:${located?.[2] ?? ""}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.errors.push({
      start: i,
      end: Math.min(lines.length - 1, i + (linker ? 8 : 4)),
      message,
      ...(located ? { file: located[1]!, position: `${located[2]}:${located[3]}` } : {}),
    });
  }
  return result;
}

export function parseCocoaPods(doc: LogDocument): CocoaPodsParseResult {
  const result: CocoaPodsParseResult = { detected: false, errors: [] };
  const lines = doc.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!result.detected && POD_DETECT.test(line)) result.detected = true;
    const match = /^\s*\[!\]\s+(.+)$/.exec(line);
    if (!match) continue;
    result.detected = true;
    // Context continues until two consecutive blank lines or the next [!] message.
    let end = i;
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      if (/^\s*\[!\]/.test(lines[j]!)) break;
      if (lines[j]!.trim() === "" && (lines[j + 1] ?? "").trim() === "") break;
      end = j;
    }
    result.errors.push({ start: i, end, message: match[1]!.trim() });
  }
  return result;
}
