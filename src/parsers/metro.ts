import type { LogDocument } from "../collectors/build-logs.js";
import type { Span } from "./types.js";

export type MetroEvent =
  | (Span & { kind: "unable-to-resolve"; module: string; from?: string; reason?: string })
  | (Span & { kind: "syntax-error"; file?: string; message: string; position?: string })
  | (Span & { kind: "bundling-failed"; message: string });

export interface MetroParseResult {
  detected: boolean;
  events: MetroEvent[];
}

const DETECT =
  /(?:Welcome to Metro|^\s*BUNDLE\b|Bundling failed|bundl(?:e|ing) (?:failed|complete)|createBundle\w*JsAndAssets|Unable to resolve (?:module|")|metro-|Starting Metro|expo export|react-native bundle|Bundle React Native code and images)/i;

// Metro: `Unable to resolve module foo from /path/App.js: foo could not be found ...`
const RESOLVE_METRO =
  /Unable to resolve module\s+[`'"]?([^\s`'"]+)[`'"]?\s+from\s+[`'"]?(.+?)[`'"]?(?::\s+(.*))?$/;
// Expo CLI: `Unable to resolve "foo" from "app/index.tsx"`
const RESOLVE_EXPO = /Unable to resolve\s+"([^"]+)"\s+from\s+"([^"]+)"/;
// `While trying to resolve module `foo` from file `/path/x.js`, the package ... main module field ...`
const RESOLVE_MAIN = /While trying to resolve module\s+`([^`]+)`\s+from file\s+`([^`]+)`/;
// Babel: `SyntaxError: /path/App.js: Unexpected token (12:4)`; Expo CLI repeats the prefix.
const SYNTAX =
  /SyntaxError:\s+(?:SyntaxError:\s+)*(?:(\/[^:]+|[A-Za-z]:\\[^:]+|[\w./-]+\.[cm]?[jt]sx?):\s+)?(.+?)(?:\s+\((\d+:\d+)\))?$/;
const BUNDLING_FAILED = /^(?:.*\s)?(?:Android|iOS|Web)?\s*Bundling failed\b.*$/i;

/** Number of following lines kept as context for a Metro error. */
const CONTEXT = 6;

export function parseMetro(doc: LogDocument): MetroParseResult {
  const events: MetroEvent[] = [];
  let detected = false;
  const seen = new Set<string>();
  const lines = doc.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!detected && DETECT.test(line)) detected = true;
    const end = Math.min(lines.length - 1, i + CONTEXT);

    const resolve = RESOLVE_EXPO.exec(line) ?? RESOLVE_METRO.exec(line) ?? RESOLVE_MAIN.exec(line);
    if (resolve) {
      const module = resolve[1]!;
      const from = resolve[2]?.trim();
      const key = `resolve:${module}:${from ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        const reason = resolve[3]?.trim();
        events.push({
          kind: "unable-to-resolve",
          start: i,
          end,
          module,
          ...(from ? { from } : {}),
          ...(reason ? { reason } : {}),
        });
      }
      detected = true;
      continue;
    }

    const syntax = SYNTAX.exec(line);
    if (syntax && !/node_modules[\\/]typescript/.test(line)) {
      const key = `syntax:${syntax[1] ?? ""}:${syntax[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        events.push({
          kind: "syntax-error",
          start: i,
          end: Math.min(lines.length - 1, i + 10),
          message: syntax[2]!.trim(),
          ...(syntax[1] ? { file: syntax[1] } : {}),
          ...(syntax[3] ? { position: syntax[3] } : {}),
        });
      }
      continue;
    }

    if (BUNDLING_FAILED.test(line)) {
      events.push({ kind: "bundling-failed", start: i, end, message: line.trim() });
      detected = true;
    }
  }
  return { detected, events };
}
