import { builtinModules } from "node:module";
import { fileExists, readJsonFile, readProjectFile } from "../../collectors/project-files.js";
import { findPackageDir } from "../../detection/project-type.js";
import { finding, type Rule } from "../../engine/rule.js";
import { logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

const VERIFIED = "2026-10-14";
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Package name from an import specifier (`@scope/pkg/sub` => `@scope/pkg`). */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier))
    return undefined;
  if (isPathAlias(specifier)) return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

/** Common path-alias prefixes (`@/x`, `~/x`, `#x`) that are not npm package names. */
export function isPathAlias(specifier: string): boolean {
  return /^(?:@\/|~\/|#)/.test(specifier);
}

/** The path after the package name (`@scope/pkg/icons/x` => `icons/x`), if any. */
export function subpathOf(specifier: string, pkg: string): string | undefined {
  return specifier.length > pkg.length + 1 ? specifier.slice(pkg.length + 1) : undefined;
}

type SubpathCheck =
  | { status: "exists"; file: string }
  | {
      status: "export-target-missing";
      key: string;
      targets: string[];
      types?: string;
      /** A sibling subpath the declaration re-exports from, which does exist at runtime. */
      alternative?: string;
    }
  | { status: "not-exported" }
  | { status: "file-missing" }
  | { status: "unknown" };

/** Runtime targets (and the "types" target) of a package.json "exports" entry. */
function exportTargets(value: unknown, star: string): { runtime: string[]; types?: string } {
  const runtime: string[] = [];
  let types: string | undefined;
  const visit = (node: unknown, condition?: string) => {
    if (typeof node === "string") {
      const target = node.replace(/\*/g, star);
      if (condition === "types") types ??= target;
      else if (!runtime.includes(target)) runtime.push(target);
    } else if (Array.isArray(node)) node.forEach((n) => visit(n, condition));
    else if (node && typeof node === "object")
      for (const [key, child] of Object.entries(node)) visit(child, key);
  };
  visit(value);
  return { runtime, ...(types ? { types } : {}) };
}

/**
 * Checks whether an installed package ships `subpath`: through its "exports" map when it has one,
 * otherwise as a file. Only reads files; nothing is resolved the way Metro would.
 */
export function checkSubpath(pkgDir: string, subpath: string): SubpathCheck {
  const manifest = readJsonFile<{ exports?: unknown }>(pkgDir, "package.json");
  if (!manifest.ok) return { status: "unknown" };
  const exports = manifest.value.exports;
  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const keys = Object.keys(exports);
    if (keys.some((k) => k.startsWith("."))) {
      const wanted = `./${subpath}`;
      let key: string | undefined;
      let star = "";
      if (keys.includes(wanted)) key = wanted;
      else
        for (const k of keys) {
          const [prefix, suffix, extra] = k.split("*");
          if (prefix === undefined || suffix === undefined || extra !== undefined) continue;
          if (
            wanted.startsWith(prefix) &&
            wanted.endsWith(suffix) &&
            wanted.length >= prefix.length + suffix.length
          ) {
            key = k;
            star = wanted.slice(prefix.length, wanted.length - suffix.length);
            break;
          }
        }
      if (!key) return { status: "not-exported" };
      const { runtime, types } = exportTargets((exports as Record<string, unknown>)[key], star);
      const found = runtime.find((t) => fileExists(pkgDir, t));
      if (found) return { status: "exists", file: found };
      if (!runtime.length) return { status: "unknown" };
      const hasTypes = types !== undefined && fileExists(pkgDir, types);
      // An alias declaration such as `export { default } from './trash.js'` names the real file.
      const declaration = hasTypes ? readProjectFile(pkgDir, types) : undefined;
      const reexport = declaration?.ok
        ? /^\s*export\s*\{\s*default\s*\}\s*from\s*['"]\.\/([\w.-]+?)(?:\.m?js)?['"]/m.exec(
            declaration.text,
          )?.[1]
        : undefined;
      const sibling = reexport ? subpath.replace(/[^/]+$/, reexport) : undefined;
      const alternative =
        sibling && sibling !== subpath && checkSubpath(pkgDir, sibling).status === "exists"
          ? sibling
          : undefined;
      return {
        status: "export-target-missing",
        key,
        targets: runtime,
        ...(hasTypes ? { types } : {}),
        ...(alternative ? { alternative } : {}),
      };
    }
  }
  const candidates = ["", ".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", "/index.js"].map(
    (ext) => `${subpath}${ext}`,
  );
  const found = candidates.find((c) => fileExists(pkgDir, c));
  return found ? { status: "exists", file: found } : { status: "file-missing" };
}

/** Shows project files relative to the project root. */
function displayPath(path: string | undefined, root: string | undefined): string | undefined {
  if (!path || !root) return path;
  const normalizedRoot = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`;
  return path.startsWith(normalizedRoot) ? path.slice(normalizedRoot.length) : path;
}

/** The subpath check for an installed package, when it explains the failure. */
function subpathCheck(
  root: string,
  pkg: string,
  subpath: string,
): Exclude<SubpathCheck, { status: "exists" } | { status: "unknown" }> | undefined {
  const dir = findPackageDir(root, pkg);
  if (!dir) return undefined;
  const check = checkSubpath(dir, subpath);
  return check.status === "exists" || check.status === "unknown" ? undefined : check;
}

export const unableToResolveModule: Rule = {
  meta: {
    id: "javascript.unable-to-resolve-module",
    title: "Metro could not resolve an imported module",
    platforms: ["javascript"],
    scope: "log",
    trigger:
      "Metro or Expo CLI output 'Unable to resolve module X from Y' / 'Unable to resolve \"X\" from \"Y\"'.",
    evidence:
      "The resolver error with the module and importing file; package.json and node_modules state when a project is available.",
    versionScope: "Metro (all versions), Expo CLI",
    references: [
      "https://metrobundler.dev/docs/resolution",
      "https://docs.expo.dev/troubleshooting/clear-cache-macos-linux/",
    ],
    lastVerified: "2026-10-25",
    fixtures: [
      "logs/metro-unable-to-resolve.log",
      "logs/android-bundle-unable-to-resolve.log",
      "projects/rn-cli-missing-dependency",
      "logs/real-rn086-metro-relative-import.log",
      "logs/metro-package-export-target-missing.log",
      "projects/rn088-package-exports",
      "logs/expo-issue-metro-resolve-wrapped.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const event of log.metro.events) {
        if (event.kind !== "unable-to-resolve") continue;
        const pkg = packageNameOf(event.module);
        const project = ctx.project;
        const from = displayPath(event.from, project?.root);
        const evidence: Evidence[] = [logEvidence(log.doc, event)];
        let explanation: string;
        let confidence: DraftFinding["confidence"] = "high";
        const nextSteps: string[] = [];

        // npm polyfills share names with some built-ins (buffer, events, url), so an installed or
        // declared package of the same name rules this case out.
        const isBuiltin =
          (NODE_BUILTINS.has(event.module) || (pkg !== undefined && NODE_BUILTINS.has(pkg))) &&
          !(pkg && (project?.declared[pkg] || project?.installedVersion(pkg)));
        if (isBuiltin) {
          confidence = project && project.kind !== "unknown" ? "high" : "medium";
          explanation = `'${event.module}' is a Node.js built-in module, and React Native doesn't provide Node.js built-ins. Code imported from ${from ?? "the reported file"}, or a dependency, assumes a Node environment.`;
          nextSteps.push(
            "Find which package imports it (the importing file is in the excerpt). Replace it with a React Native-compatible alternative, or configure a polyfill via Metro's resolver.",
          );
        } else if (isPathAlias(event.module)) {
          explanation = `'${event.module}' uses a path alias, and Metro couldn't map it to a file. Either the alias isn't configured for Metro/Babel (tsconfig "paths" alone only affects TypeScript unless your toolchain reads it), or the target file doesn't exist under the aliased directory with this exact letter case.`;
          confidence = "medium";
          nextSteps.push(
            "Check that the aliased file exists (case-sensitive) under the directory the alias points to.",
            "Check the alias configuration: tsconfig.json `compilerOptions.paths` (Expo SDK 50+ reads it automatically) or babel-plugin-module-resolver in babel.config.js.",
            "Restart Metro with a clean cache after changing alias configuration.",
          );
        } else if (!pkg) {
          explanation = `The relative import '${event.module}' in ${from ?? "the reported file"} doesn't point to an existing file. The file may be missing, renamed, or have a different extension. A letter-case mismatch also breaks on case-sensitive file systems such as Linux CI and EAS builders, even when it works on macOS or Windows.`;
          confidence = "medium";
          nextSteps.push(
            "Check that the target file exists with exactly this path and letter case (`git ls-files | grep -i <name>`).",
            "If a file was renamed only by case, make sure git recorded the rename (`git mv`).",
          );
        } else if (project && project.kind !== "unknown") {
          const declared = project.declared[pkg];
          const installed = project.installedVersion(pkg);
          const subpath = subpathOf(event.module, pkg);
          const check = installed && subpath ? subpathCheck(project.root, pkg, subpath) : undefined;
          if (!declared && !installed) {
            explanation = `Package '${pkg}' is imported but isn't declared in package.json and isn't installed.`;
            evidence.push({
              source: "project",
              file: "package.json",
              detail: `'${pkg}' not in dependencies or devDependencies`,
            });
            nextSteps.push(
              project.kind === "expo"
                ? `Install it with \`npx expo install ${pkg}\` so Expo picks a compatible version.`
                : `Install it with your package manager (for example \`npm install ${pkg}\`).`,
            );
          } else if (declared && !installed && project.nodeModulesPresent) {
            explanation = `Package '${pkg}' is declared in package.json (${declared}) but isn't installed in node_modules.`;
            evidence.push({
              source: "project",
              file: "package.json",
              detail: `${pkg}: ${declared} (declared, not installed)`,
            });
            nextSteps.push(
              "Reinstall dependencies with a clean install (for example `npm ci`, `yarn install --frozen-lockfile`, or `pnpm install --frozen-lockfile`).",
            );
          } else if (!declared && installed) {
            explanation = `Package '${pkg}' is installed (${installed}) but isn't declared in package.json. It's probably present as a transitive dependency, which isn't reliable on a clean install or a different package manager layout.`;
            evidence.push({
              source: "project",
              detail: `${pkg}@${installed} installed but undeclared`,
            });
            nextSteps.push(`Add '${pkg}' to dependencies explicitly.`);
            confidence = "medium";
          } else if (installed && subpath && check) {
            const shown = `node_modules/${pkg}`;
            evidence.push({
              source: "project",
              detail: `${pkg}: declared ${declared ?? "(not declared)"}, installed ${installed}`,
            });
            if (check.status === "export-target-missing") {
              explanation =
                `Package '${pkg}' is installed (${installed}), and its package.json "exports" maps '${check.key}' for this import, but the file it points to isn't in the installed package (${check.targets.map((t) => `${shown}/${t.replace(/^\.\//, "")}`).join(", ")}). The package publishes the path without the file, so reinstalling or clearing the Metro cache won't help.` +
                (check.types
                  ? ` A type declaration exists (${shown}/${check.types.replace(/^\.\//, "")}), which is why TypeScript accepts the import even though bundling fails.`
                  : "");
              evidence.push({
                source: "project",
                file: `${shown}/package.json`,
                detail: `exports["${check.key}"] points to ${check.targets.join(", ")}; none of them exist`,
              });
              if (check.alternative)
                nextSteps.push(
                  `The type declaration re-exports '${pkg}/${check.alternative}', which does exist. Import that instead: \`from '${pkg}/${check.alternative}'\`.`,
                );
              nextSteps.push(
                `Import '${pkg}' from a path the package actually ships: look in ${shown}/${check.targets[0]!.replace(/^\.\//, "").replace(/[^/]+$/, "")} for the file you need, or import it from '${pkg}' itself.`,
                `Check whether a newer version of ${pkg} fixes the missing file, and report it to the package if not.`,
              );
            } else if (check.status === "not-exported") {
              confidence = "medium";
              explanation = `Package '${pkg}' is installed (${installed}), but its package.json "exports" doesn't list './${subpath}'. A package with an "exports" field only allows the paths it lists, so Metro can't resolve this import.`;
              evidence.push({
                source: "project",
                file: `${shown}/package.json`,
                detail: `"exports" has no entry for ./${subpath}`,
              });
              nextSteps.push(
                `Import '${pkg}' through a path listed in ${shown}/package.json "exports", or from '${pkg}' itself.`,
              );
            } else {
              confidence = "medium";
              explanation = `Package '${pkg}' is installed (${installed}), but it doesn't contain '${subpath}'. The import path may be wrong, or the path may have been removed or renamed in this version.`;
              evidence.push({ source: "project", detail: `No file for ${subpath} in ${shown}` });
              nextSteps.push(
                `Check ${shown} for the file you need and update the import path, or check the package's changelog for a renamed path.`,
              );
            }
          } else {
            explanation = `Package '${pkg}' is declared${installed ? ` and installed (${installed})` : ""}, yet Metro couldn't resolve '${event.module}'. Possible causes: an outdated Metro cache, a subpath not exported by the package, or a package manager layout (such as pnpm or a monorepo) that Metro isn't configured to follow.`;
            evidence.push({
              source: "project",
              detail: `${pkg}: declared ${declared}${installed ? `, installed ${installed}` : ""}`,
            });
            confidence = "medium";
            nextSteps.push(
              "Restart Metro with a clean cache (`npx expo start --clear` or `npx react-native start --reset-cache`).",
              `Check that '${event.module}' is a path the package actually publishes (its package.json "exports"/"main").`,
              "For monorepos, check watchFolders and nodeModulesPaths in metro.config.js.",
            );
          }
        } else if (subpathOf(event.module, pkg)) {
          const subpath = subpathOf(event.module, pkg)!;
          explanation = `Metro couldn't resolve '${event.module}', the path '${subpath}' inside package '${pkg}', imported from ${from ?? "the reported file"}. Either '${pkg}' isn't installed, or it's installed but doesn't ship this path (the file is missing, or the package's "exports" doesn't list it). Without the project files, this tool can't tell which.`;
          confidence = "medium";
          nextSteps.push(
            "Run this analysis from the project directory (or pass --cwd) so the installed package can be checked.",
            `Check that '${pkg}' is installed, then look in node_modules/${pkg} for '${subpath}' and in its package.json "exports".`,
          );
        } else {
          explanation = `Metro couldn't find package '${pkg}' imported from ${from ?? "the reported file"}. Without the project files, this tool can't tell whether it's undeclared, not installed, or a cache problem.`;
          confidence = "medium";
          nextSteps.push(
            "Run this analysis from the project directory (or pass --cwd) so package.json and node_modules can be checked.",
            `Check that '${pkg}' is in package.json and installed.`,
          );
        }
        nextSteps.push("Re-run the bundling command after the fix.");
        out.push(
          finding(this.meta, {
            title: `Unable to resolve '${event.module}'${from ? ` from ${from}` : ""}`,
            severity: "error",
            confidence,
            explanation,
            evidence,
            nextSteps,
            verification:
              "The bundle builds (`npx expo export` or `npx react-native bundle`) without the resolver error.",
          }),
        );
      }
    }
    return out;
  },
};

export const bundleSyntaxError: Rule = {
  meta: {
    id: "javascript.bundle-syntax-error",
    title: "JavaScript syntax error while bundling",
    platforms: ["javascript"],
    scope: "log",
    trigger: "Babel/Metro output 'SyntaxError: <file>: <message> (line:column)'.",
    evidence: "The syntax error line with file and position, plus the code frame when printed.",
    versionScope: "Metro with Babel (all versions)",
    references: [
      "https://metrobundler.dev/docs/troubleshooting",
      "https://babeljs.io/docs/config-files",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/metro-syntax-error.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const event of log.metro.events) {
        if (event.kind !== "syntax-error" || !event.file) continue;
        const inDependency = /node_modules[\\/]/.test(event.file);
        out.push(
          finding(this.meta, {
            title: `Syntax error in ${displayPath(event.file, ctx.project?.root)}${event.position ? ` (${event.position})` : ""}`,
            severity: "error",
            confidence: "high",
            explanation: inDependency
              ? `Babel couldn't parse a file inside node_modules: ${event.message}. The package probably ships syntax your Babel configuration doesn't transform, or your preset doesn't match your React Native/Expo version.`
              : `Babel couldn't parse ${event.file}: ${event.message}.`,
            evidence: [logEvidence(log.doc, event)],
            nextSteps: inDependency
              ? [
                  "Make sure babel.config.js uses the preset for your setup (babel-preset-expo for Expo, @react-native/babel-preset for React Native CLI).",
                  "Check whether a newer version of the package fixes the published syntax.",
                ]
              : [
                  `Fix the syntax at ${event.file}${event.position ? `:${event.position}` : ""}.`,
                  "Run your type checker or linter to find similar problems.",
                ],
            verification: "The bundle builds without the syntax error.",
          }),
        );
      }
    }
    return out;
  },
};

export const metroRules: Rule[] = [unableToResolveModule, bundleSyntaxError];
