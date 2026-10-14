import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { UsageError } from "../errors.js";

/** Logs up to this size are read completely. */
export const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024;
/** When a log is larger than the limit, keep this share from the start; the rest comes from the end. */
const HEAD_SHARE = 0.25;
const COUNT_CHUNK_BYTES = 1024 * 1024;

export type LogEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface LogDocument {
  /** Path as supplied by the user. */
  path: string;
  /** Normalized lines (ANSI codes, carriage-return overwrites and CI timestamps removed). */
  lines: string[];
  encoding: LogEncoding;
  truncated: boolean;
  /** Total number of lines in the original file. */
  totalLines: number;
  /** Index into `lines` where the omitted middle section starts (only when truncated). */
  gapIndex: number;
  /** Number of original lines omitted in the middle (only when truncated). */
  gapSize: number;
}

/** Maps an index into `doc.lines` to the 1-based line number in the original file. */
export function lineNumber(doc: LogDocument, index: number): number {
  return doc.truncated && index >= doc.gapIndex ? index + 1 + doc.gapSize : index + 1;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Timestamp prefixes added by CI systems such as GitHub Actions and EAS log downloads. */
const TIMESTAMP_PREFIX =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s/;

export function normalizeLine(raw: string): string {
  let line = raw.replace(ANSI_PATTERN, "");
  // Progress bars rewrite the line with carriage returns; the terminal shows the last segment.
  if (line.includes("\r")) {
    const segments = line.split("\r").filter((s) => s.length > 0);
    line = segments.length ? segments[segments.length - 1]! : "";
  }
  return line.replace(TIMESTAMP_PREFIX, "").replace(/\s+$/, "");
}

function detectEncoding(head: Buffer): { encoding: LogEncoding; bomBytes: number } {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: "utf-8", bomBytes: 3 };
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { encoding: "utf-16le", bomBytes: 2 };
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { encoding: "utf-16be", bomBytes: 2 };
  }
  // UTF-16 without a BOM: ASCII text has a NUL in every other byte.
  if (head.length >= 64) {
    let evenNul = 0;
    let oddNul = 0;
    const sample = Math.min(head.length, 4096) & ~1;
    for (let i = 0; i < sample; i += 2) {
      if (head[i] === 0) evenNul++;
      if (head[i + 1] === 0) oddNul++;
    }
    const pairs = sample / 2;
    if (oddNul / pairs > 0.4 && evenNul / pairs < 0.05)
      return { encoding: "utf-16le", bomBytes: 0 };
    if (evenNul / pairs > 0.4 && oddNul / pairs < 0.05)
      return { encoding: "utf-16be", bomBytes: 0 };
  }
  return { encoding: "utf-8", bomBytes: 0 };
}

function decode(buffer: Buffer, encoding: LogEncoding): string {
  if (encoding === "utf-16be") {
    const swapped = Buffer.from(buffer.subarray(0, buffer.length & ~1));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (encoding === "utf-16le") return buffer.subarray(0, buffer.length & ~1).toString("utf16le");
  return buffer.toString("utf8");
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8192);
  if (sample.length === 0) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0 || (code < 8 && code !== 0)) control++;
  }
  return control / sample.length > 0.01;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, buffer, offset, length - offset, position + offset);
    if (read === 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset);
}

function countNewlines(fd: number, start: number, end: number, encoding: LogEncoding): number {
  let count = 0;
  let position = start;
  const buffer = Buffer.alloc(COUNT_CHUNK_BYTES);
  while (position < end) {
    const read = readSync(fd, buffer, 0, Math.min(COUNT_CHUNK_BYTES, end - position), position);
    if (read === 0) break;
    for (let i = 0; i < read; i++) {
      if (buffer[i] !== 0x0a) continue;
      // In UTF-16 the newline byte must sit at the low-order position of a code unit.
      const absolute = position + i;
      if (encoding === "utf-16le" && absolute % 2 !== 0) continue;
      if (encoding === "utf-16be" && absolute % 2 !== 1) continue;
      count++;
    }
    position += read;
  }
  return count;
}

export interface ReadLogOptions {
  maxBytes?: number;
}

/**
 * Reads a user-supplied log file. Logs larger than `maxBytes` keep their beginning and end, and
 * line numbers continue to refer to the original file.
 */
export function readLog(path: string, options: ReadLogOptions = {}): LogDocument {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new UsageError(`Log file not found: ${path}`);
    if (code === "EISDIR")
      throw new UsageError(`Expected a log file but found a directory: ${path}`);
    if (code === "EACCES") throw new UsageError(`Permission denied reading log file: ${path}`);
    throw new UsageError(`Unable to open log file ${path}: ${(error as Error).message}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new UsageError(`Expected a regular file: ${path}`);
    const size = stat.size;
    const { encoding, bomBytes } = detectEncoding(readRange(fd, 0, Math.min(size, 4096)));
    const unit = encoding === "utf-8" ? 1 : 2;

    if (size <= maxBytes) {
      const text = decode(readRange(fd, bomBytes, size - bomBytes), encoding);
      if (looksBinary(text)) {
        throw new UsageError(`${path} does not look like a text log (binary content detected).`);
      }
      const lines = splitLines(text).map(normalizeLine);
      return {
        path,
        lines,
        encoding,
        truncated: false,
        totalLines: lines.length,
        gapIndex: 0,
        gapSize: 0,
      };
    }

    const align = (n: number) => n - (n % unit);
    const headBytes = align(Math.floor(maxBytes * HEAD_SHARE));
    const tailBytes = align(maxBytes - headBytes);
    const tailStart = Math.max(bomBytes + headBytes, align(size - tailBytes));

    // Keep only complete lines from the head: cut after the last newline code unit.
    const headBuffer = readRange(fd, bomBytes, headBytes);
    let headCut = 0;
    for (let i = headBuffer.length - 1; i >= 0; i--) {
      if (headBuffer[i] !== 0x0a) continue;
      if (encoding === "utf-16le" && i % 2 !== 0) continue;
      if (encoding === "utf-16be" && i % 2 !== 1) continue;
      headCut = i + 1 + (encoding === "utf-16le" ? 1 : 0);
      break;
    }
    const headText = decode(headBuffer.subarray(0, headCut), encoding);
    if (looksBinary(headText)) {
      throw new UsageError(`${path} does not look like a text log (binary content detected).`);
    }
    const headLines = splitLines(headText);

    const tailLines = decode(readRange(fd, tailStart, size - tailStart), encoding).split("\n");
    tailLines.shift(); // incomplete first line; counted as part of the gap
    if (tailLines.length > 0 && tailLines[tailLines.length - 1] === "") tailLines.pop();

    // Lines omitted = newlines in the middle section + the line that ends inside the tail chunk.
    const gapSize = countNewlines(fd, bomBytes + headCut, tailStart, encoding) + 1;
    const lines = [...headLines, ...tailLines].map(normalizeLine);
    return {
      path,
      lines,
      encoding,
      truncated: true,
      totalLines: headLines.length + gapSize + tailLines.length,
      gapIndex: headLines.length,
      gapSize,
    };
  } finally {
    closeSync(fd);
  }
}

/** Builds a log document from in-memory text (used by tests and stdin input). */
export function logFromText(path: string, text: string): LogDocument {
  const lines = splitLines(text.replace(/^\uFEFF/, "")).map(normalizeLine);
  return {
    path,
    lines,
    encoding: "utf-8",
    truncated: false,
    totalLines: lines.length,
    gapIndex: 0,
    gapSize: 0,
  };
}
