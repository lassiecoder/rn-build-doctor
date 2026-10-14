import { homedir } from "node:os";

/**
 * Best-effort secret redaction. Patterns are imperfect: reports must stay reviewable before they
 * are shared or sent to an AI provider. See docs/privacy.md.
 */

export interface RedactionResult {
  text: string;
  replacements: number;
}

interface Pattern {
  name: string;
  regex: RegExp;
  /** Replacement; `$<keep>` style groups are preserved through a function. */
  replace: (match: string, ...groups: string[]) => string;
}

const tag = (name: string) => `[REDACTED:${name}]`;

const SENSITIVE_KEY =
  "(?:[A-Za-z0-9_.-]*(?:passw(?:or)?d|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?(?:token|key)|credential|session[_-]?(?:id|token|key)|signature|store[_-]?password|key[_-]?password|dsn|cookie)[A-Za-z0-9_.-]*)";

const isPlaceholder = (value: string) =>
  value.startsWith("[REDACTED") ||
  /^\$\{?[A-Za-z_]/.test(value) ||
  /^process\.env/.test(value) ||
  /^(?:true|false|null|undefined|none|required|optional|\*+)$/i.test(value);

const assignment =
  (name: string) =>
  (match: string, prefix: string, quote: string, value: string): string =>
    isPlaceholder(value) ? match : `${prefix}${quote}${tag(name)}${quote}`;

const PATTERNS: Pattern[] = [
  {
    name: "private-key",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: () => tag("private-key"),
  },
  {
    name: "authorization-header",
    regex: /\b((?:proxy-)?authorization\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi,
    replace: (_m, prefix, scheme) =>
      `${prefix}${scheme ? `${scheme} ` : ""}${tag("authorization")}`,
  },
  {
    name: "cookie-header",
    regex: /\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi,
    replace: (_m, prefix) => `${prefix}${tag("cookie")}`,
  },
  {
    name: "url-credentials",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']+@/gi,
    replace: (_m, prefix) => `${prefix}${tag("password")}@`,
  },
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => tag("jwt"),
  },
  {
    name: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => tag("aws-key"),
  },
  {
    name: "github-token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
    replace: () => tag("github-token"),
  },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: () => tag("npm-token") },
  {
    name: "slack-token",
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replace: () => tag("slack-token"),
  },
  {
    name: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => tag("google-api-key"),
  },
  {
    name: "stripe-key",
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replace: () => tag("stripe-key"),
  },
  {
    name: "ai-provider-key",
    regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => tag("api-key"),
  },
  {
    name: "sensitive-query-parameter",
    regex:
      /([?&](?:access_token|token|key|api_key|apikey|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|code|password|secret)=)[^&\s"'#]+/gi,
    replace: (_m, prefix) => `${prefix}${tag("query")}`,
  },
  {
    // "token": "value" / 'apiKey': 'value' (JSON, JS objects)
    name: "sensitive-quoted-key",
    regex: new RegExp(`(["']${SENSITIVE_KEY}["']\\s*:\\s*)(["']?)([^\\s"',;}]{4,})\\2`, "gi"),
    replace: assignment("secret"),
  },
  {
    // TOKEN=value / --password=value / key = value
    name: "sensitive-assignment",
    regex: new RegExp(`(\\b${SENSITIVE_KEY}\\s*=\\s*)(["']?)([^\\s"',;}]{4,})\\2`, "gi"),
    replace: assignment("secret"),
  },
  {
    // YAML style at the start of a line: `  token: value`
    name: "sensitive-yaml",
    regex: new RegExp(`^(\\s*-?\\s*${SENSITIVE_KEY}:\\s+)(["']?)([^\\s"',;}]{4,})\\2`, "gim"),
    replace: assignment("secret"),
  },
  {
    // Gradle signing configs: storePassword 'value'
    name: "gradle-signing-password",
    regex: /(\b(?:storePassword|keyPassword)\s+)(["'])([^"'\n]+)\2/g,
    replace: assignment("secret"),
  },
];

const SENSITIVE_ENV_NAME = new RegExp(`^${SENSITIVE_KEY}$`, "i");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactorOptions {
  /** Environment whose sensitive values are redacted verbatim (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Extra literal strings to redact (e.g. from --redact). */
  literals?: string[];
  /** Replace the home directory with "~" (default true). */
  redactHome?: boolean;
  home?: string;
}

export class Redactor {
  private readonly literals: { value: string; regex: RegExp }[];
  private readonly home: string | undefined;

  constructor(options: RedactorOptions = {}) {
    const env = options.env ?? process.env;
    const values = new Set<string>(options.literals?.filter((l) => l.length >= 4) ?? []);
    for (const [name, value] of Object.entries(env)) {
      if (value && value.length >= 8 && SENSITIVE_ENV_NAME.test(name)) values.add(value);
    }
    // Longest first so overlapping secrets are fully replaced.
    this.literals = [...values]
      .sort((a, b) => b.length - a.length)
      .map((value) => ({ value, regex: new RegExp(escapeRegExp(value), "g") }));
    const home = options.redactHome === false ? undefined : (options.home ?? homedir());
    this.home = home && home.length > 1 ? home : undefined;
  }

  redact(input: string): RedactionResult {
    let text = input;
    let replacements = 0;
    for (const { regex } of this.literals) {
      text = text.replace(regex, () => {
        replacements++;
        return tag("env-value");
      });
    }
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      text = text.replace(pattern.regex, (...args: unknown[]) => {
        const match = args[0] as string;
        const groups = args.slice(1, -2).map((g) => (g === undefined ? "" : String(g)));
        const replaced = pattern.replace(match, ...groups);
        if (replaced !== match) replacements++;
        return replaced;
      });
    }
    if (this.home) {
      const homePattern = new RegExp(`${escapeRegExp(this.home)}(?=[/\\\\]|$|[\\s"'])`, "g");
      text = text.replace(homePattern, "~");
    }
    return { text, replacements };
  }

  /** Redacts every string inside a JSON-compatible value. */
  redactDeep<T>(value: T): { value: T; replacements: number } {
    let replacements = 0;
    const visit = (node: unknown): unknown => {
      if (typeof node === "string") {
        const result = this.redact(node);
        replacements += result.replacements;
        return result.text;
      }
      if (Array.isArray(node)) return node.map(visit);
      if (node && typeof node === "object") {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
      }
      return node;
    };
    return { value: visit(value) as T, replacements };
  }
}

export const REDACTION_NOTICE =
  "Secrets matching known patterns were redacted. Redaction is best-effort: review this report before sharing it or sending it to an AI provider.";
