import { readProjectFile } from "./project-files.js";

/**
 * Minimal .gitignore matcher for root-level paths (enough to decide whether files such as `.env`
 * or folders such as `android/` are ignored). Nested .gitignore files and `**` semantics beyond
 * simple globs are not evaluated; callers must treat the result as an approximation.
 */
export interface IgnoreRules {
  file: ".easignore" | ".gitignore";
  isIgnored(path: string, isDirectory?: boolean): boolean;
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function parseIgnore(text: string, file: IgnoreRules["file"]): IgnoreRules {
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((raw) => {
      const negate = raw.startsWith("!");
      let pattern = negate ? raw.slice(1) : raw;
      const dirOnly = pattern.endsWith("/");
      if (dirOnly) pattern = pattern.slice(0, -1);
      const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
      pattern = pattern.replace(/^\//, "").replace(/^\*\*\//, "");
      return { negate, dirOnly, anchored, regex: globToRegExp(pattern) };
    });
  return {
    file,
    isIgnored(path: string, isDirectory = false) {
      const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
      const name = normalized.split("/").pop()!;
      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDirectory) continue;
        const target = rule.anchored ? normalized : name;
        if (rule.regex.test(target)) ignored = !rule.negate;
      }
      return ignored;
    },
  };
}

/** EAS Build uses .easignore instead of .gitignore when it exists. */
export function loadUploadIgnore(root: string): IgnoreRules | undefined {
  const eas = readProjectFile(root, ".easignore");
  if (eas.ok) return parseIgnore(eas.text, ".easignore");
  const git = readProjectFile(root, ".gitignore");
  if (git.ok) return parseIgnore(git.text, ".gitignore");
  return undefined;
}
