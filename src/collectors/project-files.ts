import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import JSON5 from "json5";

/** Config files are small; anything larger is not read. */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export type ReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "too-large" | "unreadable" | "not-a-file"; message: string };

export function readProjectFile(
  root: string,
  relPath: string,
  maxBytes = MAX_CONFIG_BYTES,
): ReadResult {
  const full = join(root, relPath);
  try {
    const stat = statSync(full);
    if (!stat.isFile())
      return { ok: false, reason: "not-a-file", message: `${relPath} is not a file` };
    if (stat.size > maxBytes) {
      return {
        ok: false,
        reason: "too-large",
        message: `${relPath} is larger than ${maxBytes} bytes`,
      };
    }
    return { ok: true, text: readFileSync(full, "utf8").replace(/^\uFEFF/, "") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, reason: "missing", message: `${relPath} does not exist` };
    }
    return { ok: false, reason: "unreadable", message: `${relPath}: ${(error as Error).message}` };
  }
}

export type JsonResult<T> =
  | { ok: true; value: T; text: string }
  | {
      ok: false;
      reason: "missing" | "too-large" | "unreadable" | "not-a-file" | "invalid";
      message: string;
      line?: number;
      text?: string;
    };

/** Reads JSON (or JSON5 when `json5` is true) without ever executing project code. */
export function readJsonFile<T = unknown>(
  root: string,
  relPath: string,
  json5 = false,
): JsonResult<T> {
  const file = readProjectFile(root, relPath);
  if (!file.ok) return file;
  try {
    const value = (json5 ? JSON5.parse(file.text) : JSON.parse(file.text)) as T;
    return { ok: true, value, text: file.text };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      reason: "invalid",
      message,
      line: jsonErrorLine(file.text, error),
      text: file.text,
    };
  }
}

function jsonErrorLine(text: string, error: unknown): number | undefined {
  const anyError = error as { lineNumber?: number; message?: string };
  if (typeof anyError.lineNumber === "number") return anyError.lineNumber;
  const lineMatch = /line (\d+)/i.exec(anyError.message ?? "");
  if (lineMatch) return Number(lineMatch[1]);
  const posMatch = /position (\d+)/i.exec(anyError.message ?? "");
  if (posMatch) return text.slice(0, Number(posMatch[1])).split("\n").length;
  return undefined;
}

export function fileExists(root: string, relPath: string): boolean {
  return existsSync(join(root, relPath));
}

export function isDirectory(root: string, relPath: string): boolean {
  try {
    return statSync(join(root, relPath)).isDirectory();
  } catch {
    return false;
  }
}

export interface ExcerptLine {
  line: number;
  excerpt: string;
}

/** Finds the first line in `text` matching `pattern` (1-based line number). */
export function findLine(text: string, pattern: RegExp | string): ExcerptLine | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (typeof pattern === "string" ? line.includes(pattern) : pattern.test(line)) {
      return { line: i + 1, excerpt: line.trim() };
    }
  }
  return undefined;
}

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "android",
  "ios",
  "build",
  "dist",
  "coverage",
  "vendor",
  "Pods",
  "web-build",
  "__tests__",
  "__mocks__",
]);

export interface SourceScanLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
  /** Total bytes read across all files. */
  maxTotalBytes: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceScanLimits = {
  maxFiles: 5000,
  maxFileBytes: 512 * 1024,
  maxDepth: 12,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface SourceFile {
  /** Path relative to the project root using forward slashes. */
  path: string;
  text: string;
}

/**
 * Lists application source files in a bounded way: only JS/TS files, never dependencies, native
 * folders, hidden folders, or files above the size limit.
 */
export function collectSourceFiles(
  root: string,
  limits: SourceScanLimits = DEFAULT_SOURCE_LIMITS,
): { files: SourceFile[]; truncated: boolean } {
  const files: SourceFile[] = [];
  let truncated = false;
  let totalBytes = 0;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > limits.maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks are not followed
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      if (files.length >= limits.maxFiles) {
        truncated = true;
        return;
      }
      try {
        const size = statSync(full).size;
        if (size > limits.maxFileBytes) continue;
        if (totalBytes + size > limits.maxTotalBytes) {
          truncated = true;
          return;
        }
        totalBytes += size;
        files.push({
          path: relative(root, full).split(sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
      } catch {
        // unreadable files are skipped
      }
    }
  };
  walk(root, 0);
  return { files, truncated };
}

/** Parses KEY=VALUE files and returns only the variable names; values are never kept. */
export function parseEnvNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    if (match) names.push(match[1]!);
  }
  return names;
}
