import type { LogDocument } from "../collectors/build-logs.js";
import { stripLogcatPrefix, type Span } from "./types.js";

export interface JsException extends Span {
  /** Error class, e.g. TypeError, Error, Invariant Violation. */
  type: string;
  message: string;
  /** How the exception was surfaced (logcat ReactNativeJS, red box, RCTFatal, ...). */
  channel: string;
  /** First JavaScript stack frame ("at fn (file:l:c)" or "fn@file:l:c"). */
  firstFrame?: string;
  /** Innermost React component from the component stack ("in RootLayout"), not a stack frame. */
  component?: string;
  /** Logcat process id, when the log has one. */
  pid?: string;
  /**
   * Line indices for the excerpt when the log interleaves several processes (logcat): the exception
   * line and the following lines from the same process only.
   */
  lines?: number[];
}

export interface AndroidFatal extends Span {
  process?: string;
  exception: string;
  message: string;
  causes: string[];
}

export interface IosCrash extends Span {
  format: "text" | "ips";
  exceptionType?: string;
  signal?: string;
  terminationReason?: string;
  /** NSException name and reason for "Terminating app due to uncaught exception". */
  nsException?: { name: string; reason: string };
  /** Top frames of the crashed or last-exception backtrace (symbols only). */
  frames: string[];
  appName?: string;
}

export interface RuntimeParseResult {
  detected: boolean;
  jsExceptions: JsException[];
  androidFatals: AndroidFatal[];
  iosCrashes: IosCrash[];
}

const JS_ERROR =
  /\b((?:Type|Reference|Syntax|Range|Eval|URI)Error|Error|Invariant Violation)(?:\s*\[[^\]]*\])?:\s+(.+)$/;
const JS_CHANNELS: [RegExp, string][] = [
  [/com\.facebook\.react\.common\.JavascriptException:\s*(.*)$/, "android JavascriptException"],
  [/Unhandled JS Exception:\s*(.*)$/, "RCTFatal (iOS)"],
  [/\[runtime not ready\]:?\s*(.*)$/, "runtime not ready"],
  [/^\s*(?:Uncaught|Unhandled)(?: \(in promise\))?(?: Error)?[:\s]\s*(.*)$/, "uncaught error"],
  [/^\s*(?:ERROR|FATAL)\s{1,}(.*)$/, "Metro console"],
];

export function parseRuntime(doc: LogDocument): RuntimeParseResult {
  const result: RuntimeParseResult = {
    detected: false,
    jsExceptions: [],
    androidFatals: [],
    iosCrashes: [],
  };
  const lines = doc.lines;
  const seenJs = new Set<string>();

  const ips = parseIps(doc);
  if (ips) {
    result.iosCrashes.push(ips);
    result.detected = true;
  }

  for (let i = 0; i < lines.length; i++) {
    const { tag, pid, message } = stripLogcatPrefix(lines[i]!);

    // Android fatal exception block.
    if (/^FATAL EXCEPTION:/.test(message.trim())) {
      result.detected = true;
      const fatal = readAndroidFatal(lines, i);
      if (fatal) result.androidFatals.push(fatal);
      continue;
    }

    // JavaScript exceptions, only through recognized runtime channels.
    let channel: string | undefined;
    let payload = message;
    if (tag === "ReactNativeJS" || tag === "ReactNative") {
      channel = `logcat ${tag}`;
    } else if (/\[ReactNativeJS\]|\bReactNativeJS\b/.test(message)) {
      channel = "ReactNativeJS";
    } else {
      for (const [pattern, name] of JS_CHANNELS) {
        const match = pattern.exec(message);
        if (match) {
          channel = name;
          payload = match[1] ?? message;
          break;
        }
      }
    }
    if (channel) {
      const js =
        JS_ERROR.exec(payload) ?? (channel !== "Metro console" ? JS_ERROR.exec(message) : null);
      if (js) {
        const type = js[1]!;
        const msg = js[2]!.replace(/,\s*stack:\s*$/, "").trim();
        const key = `${type}:${msg}`;
        if (!seenJs.has(key)) {
          seenJs.add(key);
          result.detected = true;
          const excerpt = pid ? sameProcessLines(lines, i, pid, EXCERPT_LINES) : undefined;
          const after = excerpt
            ? excerpt.slice(1)
            : Array.from({ length: 8 }, (_, k) => i + 1 + k).filter((k) => k < lines.length);
          const frameIndex = findNear(lines, after, tag, STACK_FRAME);
          const componentIndex = findNear(lines, after, tag, COMPONENT_FRAME);
          result.jsExceptions.push({
            start: i,
            end: Math.min(lines.length - 1, i + 8),
            type,
            message: msg,
            channel,
            ...(pid && excerpt ? { pid, lines: excerpt } : {}),
            ...(frameIndex !== undefined
              ? { firstFrame: stripLogcatPrefix(lines[frameIndex]!).message.trim() }
              : {}),
            ...(componentIndex !== undefined
              ? {
                  component: stripLogcatPrefix(lines[componentIndex]!)
                    .message.trim()
                    .replace(/^in\s+/, ""),
                }
              : {}),
          });
        }
      }
    }

    // iOS text crash report.
    if (
      !ips &&
      /^(?:Incident Identifier:|Exception Type:)/.test(message.trim()) &&
      result.iosCrashes.length === 0
    ) {
      result.detected = true;
      result.iosCrashes.push(readIosTextCrash(lines, i));
    }
    const ns = /Terminating app due to uncaught exception '([^']+)', reason: '(.*)'/.exec(message);
    if (ns) {
      result.detected = true;
      const crash = result.iosCrashes[0];
      if (crash && !crash.nsException) crash.nsException = { name: ns[1]!, reason: ns[2]! };
      else if (!crash) {
        result.iosCrashes.push({
          format: "text",
          start: i,
          end: Math.min(lines.length - 1, i + 6),
          nsException: { name: ns[1]!, reason: ns[2]! },
          frames: [],
        });
      }
    }
  }
  return result;
}

const EXCERPT_LINES = 9;
/** How far ahead to look for lines of the same process in an interleaved logcat. */
const SAME_PROCESS_WINDOW = 400;

/** The line at `start` plus following lines logged by the same process, up to `limit` lines. */
function sameProcessLines(lines: string[], start: number, pid: string, limit: number): number[] {
  const picked = [start];
  for (let j = start + 1; j < lines.length && j <= start + SAME_PROCESS_WINDOW; j++) {
    if (picked.length >= limit) break;
    if (stripLogcatPrefix(lines[j]!).pid === pid) picked.push(j);
  }
  return picked;
}

const STACK_FRAME = /^\s*(?:at\s+\S|\S+@\S*:\d+:\d+)/;
const COMPONENT_FRAME = /^\s*in\s+\S/;

/**
 * Finds the first line matching `pattern` after an exception. In logcat output only lines with the
 * exception's tag count, so a stack printed by a different component (e.g. AndroidRuntime) isn't
 * attributed to it.
 */
function findNear(
  lines: string[],
  candidates: number[],
  tag: string | undefined,
  pattern: RegExp,
): number | undefined {
  for (const i of candidates) {
    const line = stripLogcatPrefix(lines[i]!);
    if (tag && line.tag !== tag) continue;
    if (pattern.test(line.message)) return i;
  }
  return undefined;
}

function readAndroidFatal(lines: string[], start: number): AndroidFatal | undefined {
  let process: string | undefined;
  let exception: string | undefined;
  let message = "";
  const causes: string[] = [];
  let end = start;
  for (let j = start + 1; j < lines.length && j <= start + 200; j++) {
    const { tag, message: text } = stripLogcatPrefix(lines[j]!);
    if (tag && tag !== "AndroidRuntime") break;
    const trimmed = text.trim();
    if (!tag && trimmed === "" && exception) break;
    end = j;
    const proc = /^Process:\s*([^,\s]+)/.exec(trimmed);
    if (proc) {
      process = proc[1];
      continue;
    }
    const cause = /^Caused by:\s*([\w.$]+)(?::\s*(.*))?$/.exec(trimmed);
    if (cause) {
      causes.push(cause[2] ? `${cause[1]}: ${cause[2]}` : cause[1]!);
      continue;
    }
    if (!exception) {
      const exc =
        /^([a-z][\w]*(?:\.[\w$]+)+(?:Exception|Error|Throwable)[\w$]*)(?::\s*(.*))?$/.exec(trimmed);
      if (exc) {
        exception = exc[1]!;
        message = exc[2] ?? "";
      }
    }
  }
  if (!exception) return undefined;
  return {
    start,
    end: Math.min(end, start + 40),
    ...(process ? { process } : {}),
    exception,
    message,
    causes,
  };
}

function readIosTextCrash(lines: string[], start: number): IosCrash {
  const crash: IosCrash = { format: "text", start, end: start, frames: [] };
  let inBacktrace = false;
  for (let j = start; j < lines.length && j <= start + 400; j++) {
    const line = lines[j]!;
    const field = /^([A-Za-z ]+):\s+(.*)$/.exec(line.trim());
    if (field) {
      const [, key, value] = field;
      if (key === "Process" && !crash.appName) crash.appName = value!.replace(/\s*\[\d+\]$/, "");
      if (key === "Exception Type") {
        crash.exceptionType = value!.trim();
        const sig = /\((SIG\w+)\)/.exec(value!);
        if (sig) crash.signal = sig[1];
        crash.end = j;
      }
      if (key === "Termination Reason") {
        crash.terminationReason = value!.trim();
        crash.end = j;
      }
    }
    if (/^(?:Last Exception Backtrace:|Thread \d+ Crashed:)/.test(line.trim())) {
      inBacktrace = true;
      crash.frames = [];
      continue;
    }
    if (inBacktrace) {
      const frame = /^\d+\s+(\S+)\s+0x[0-9a-f]+\s+(.+?)(?:\s+\+\s+\d+)?$/.exec(line.trim());
      if (frame) {
        if (crash.frames.length < 8) crash.frames.push(`${frame[1]}: ${frame[2]}`);
        continue;
      }
      if (crash.frames.length > 0) inBacktrace = false;
    }
  }
  crash.end = Math.max(crash.end, start);
  return crash;
}

interface IpsBody {
  exception?: { type?: string; signal?: string; codes?: string };
  termination?: { indicator?: string; reasons?: string[]; namespace?: string };
  procName?: string;
  faultingThread?: number;
  usedImages?: { name?: string }[];
  threads?: { frames?: { imageIndex?: number; symbol?: string }[] }[];
  lastExceptionBacktrace?: { imageIndex?: number; symbol?: string }[];
  asi?: Record<string, string[]>;
}

/** Parses the iOS 15+ `.ips` crash format: a JSON header line followed by a JSON body. */
function parseIps(doc: LogDocument): IosCrash | undefined {
  const first = doc.lines.findIndex((l) => l.trim() !== "");
  if (first < 0 || !doc.lines[first]!.trim().startsWith("{")) return undefined;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(doc.lines[first]!) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!("bug_type" in header) && !("app_name" in header)) return undefined;
  let body: IpsBody;
  try {
    body = JSON.parse(doc.lines.slice(first + 1).join("\n")) as IpsBody;
  } catch {
    return undefined;
  }
  const images = body.usedImages ?? [];
  const frameName = (f: { imageIndex?: number; symbol?: string }) =>
    `${images[f.imageIndex ?? -1]?.name ?? "?"}: ${f.symbol ?? "<unsymbolicated>"}`;
  const frames = body.lastExceptionBacktrace?.length
    ? body.lastExceptionBacktrace
    : (body.threads?.[body.faultingThread ?? 0]?.frames ?? []);
  const crash: IosCrash = {
    format: "ips",
    start: first,
    end: Math.min(doc.lines.length - 1, first + 20),
    frames: frames.slice(0, 8).map(frameName),
  };
  const appName = (header["app_name"] as string | undefined) ?? body.procName;
  if (appName) crash.appName = appName;
  if (body.exception?.type)
    crash.exceptionType = `${body.exception.type}${body.exception.signal ? ` (${body.exception.signal})` : ""}`;
  if (body.exception?.signal) crash.signal = body.exception.signal;
  if (body.termination) {
    crash.terminationReason = [
      body.termination.namespace,
      body.termination.indicator,
      ...(body.termination.reasons ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  }
  const asi = Object.values(body.asi ?? {})
    .flat()
    .join(" ");
  const ns = /Terminating app due to uncaught exception '([^']+)', reason: '(.*?)'/.exec(asi);
  if (ns) crash.nsException = { name: ns[1]!, reason: ns[2]! };
  return crash;
}
