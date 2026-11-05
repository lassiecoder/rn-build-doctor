import { findLine, readProjectFile } from "../../collectors/project-files.js";
import { finding, type Rule } from "../../engine/rule.js";
import { logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

// @expo/config-plugins (plugin-resolver.js) throws this when neither `<plugin>/app.plugin` nor the
// package's main entry resolves, or when a file plugin doesn't exist.
const PLUGIN_NOT_RESOLVED =
  /PluginError: Failed to resolve plugin for module "([^"]+)" relative to/;

/** Same classification as @expo/config-plugins: `pkg` and `@scope/pkg` are package references. */
function packageReference(plugin: string): string | undefined {
  if (/^(?:\.|~\/|\/)/.test(plugin)) return undefined;
  const parts = plugin.split("/");
  return (plugin.startsWith("@") ? parts.length === 2 : parts.length === 1) ? plugin : undefined;
}

export const configPluginNotResolved: Rule = {
  meta: {
    id: "expo.config-plugin-not-resolved",
    title: "Expo couldn't resolve a config plugin",
    platforms: ["expo"],
    scope: "log",
    trigger:
      'Expo CLI (prebuild, EAS Build, expo config) output \'PluginError: Failed to resolve plugin for module "X" relative to "..."\'.',
    evidence:
      "The PluginError line; the app.json plugin entry and the package.json and node_modules state when a project is available.",
    versionScope: "Expo SDK 41+ (config plugins)",
    references: [
      "https://docs.expo.dev/config-plugins/introduction/",
      "https://docs.expo.dev/config-plugins/plugins/",
    ],
    lastVerified: "2026-10-19",
    fixtures: [
      "logs/real-expo58-prebuild-plugin-not-installed.log",
      "logs/real-expo58-prebuild-local-plugin-missing.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const seen = new Set<string>();
      log.doc.lines.forEach((line, index) => {
        const match = PLUGIN_NOT_RESOLVED.exec(line);
        if (!match || seen.has(match[1]!)) return;
        const plugin = match[1]!;
        seen.add(plugin);
        const evidence: Evidence[] = [logEvidence(log.doc, { start: index, end: index })];
        const project = ctx.project?.kind === "expo" ? ctx.project : undefined;
        const appJsonLine = project?.appConfig.appJsonText
          ? findLine(project.appConfig.appJsonText, `"${plugin}"`)
          : undefined;
        if (appJsonLine)
          evidence.push({
            source: "project",
            file: "app.json",
            line: appJsonLine.line,
            excerpt: appJsonLine.excerpt,
            detail: `plugin: ${plugin}`,
          });
        const pkg = packageReference(plugin);

        if (!pkg) {
          out.push(
            finding(this.meta, {
              title: `Config plugin file '${plugin}' was not found`,
              severity: "error",
              confidence: "high",
              explanation: `The app config lists '${plugin}' as a config plugin. It's a file path, and Expo found no file at that path (with a .js, .cjs, .mjs, .ts, .cts, or .mts extension) relative to the project root, so the config couldn't be read.`,
              evidence,
              nextSteps: [
                `Check that the plugin file exists at '${plugin}' relative to the project root, with the exact letter case. EAS and Linux CI use case-sensitive file systems.`,
                "If the file exists locally but the failure is on EAS, check that it's committed and not excluded by .gitignore or .easignore.",
              ],
              verification:
                "`npx expo config --type prebuild` resolves the configuration without a plugin error.",
            }),
          );
          return;
        }

        const declared = project?.declared[pkg];
        const installed = project?.installedVersion(pkg);
        if (project) {
          evidence.push({
            source: "project",
            file: "package.json",
            detail: declared
              ? `'${pkg}' is declared (${declared})`
              : `'${pkg}' is not in dependencies or devDependencies`,
          });
          if (project.nodeModulesPresent)
            evidence.push({
              source: "project",
              detail: installed
                ? `node_modules contains ${pkg}@${installed}`
                : `node_modules has no ${pkg}`,
            });
        }

        let explanation: string;
        let confidence: DraftFinding["confidence"] = "high";
        const nextSteps: string[] = [];
        if (project && !declared && !installed) {
          explanation = `The app config lists the config plugin '${plugin}', but the package isn't declared in package.json${project.nodeModulesPresent ? " or installed" : ""}. Expo resolves config plugins when it reads the config, so prebuild (and the prebuild step of EAS Build) stops here. This is configuration drift between app.json and package.json, not a native build failure.`;
          nextSteps.push(
            `Install it with \`npx expo install ${pkg}\`, or remove the plugin entry from the app config if it's no longer used.`,
          );
        } else if (project && declared && !installed) {
          explanation = `'${pkg}' is declared in package.json (${declared}) but isn't installed, so Expo couldn't load its config plugin. Dependencies weren't installed (or the install failed) before the config was read.`;
          nextSteps.push(
            "Install dependencies (`npm install`, `yarn`, `pnpm install`, or `bun install`) and run the command again.",
            "On EAS, check the 'Install dependencies' step of the build log for an earlier failure.",
          );
        } else if (project && installed) {
          confidence = "medium";
          explanation = `'${pkg}' is installed (${installed}), but Expo found neither '${pkg}/app.plugin.js' nor a main entry it could load. The package may not ship a config plugin, or the installed copy may be incomplete.`;
          nextSteps.push(
            `Check the documentation of ${pkg}: if it doesn't provide a config plugin, remove it from the app config's plugins.`,
            "Otherwise reinstall dependencies from a clean state (delete node_modules and reinstall).",
          );
        } else {
          confidence = "medium";
          explanation = `Expo couldn't resolve the config plugin '${plugin}'. Usually the package isn't installed, or dependencies weren't installed before the config was read. Run this command in the project directory to check package.json and node_modules.`;
          nextSteps.push(
            `If '${pkg}' isn't a dependency, install it with \`npx expo install ${pkg}\` or remove the plugin entry.`,
            "If it is a dependency, install dependencies and run the command again.",
          );
        }
        out.push(
          finding(this.meta, {
            title: `Config plugin '${plugin}' could not be resolved`,
            severity: "error",
            confidence,
            explanation,
            evidence,
            nextSteps,
            verification:
              "`npx expo config --type prebuild` resolves the configuration without a plugin error.",
          }),
        );
      });
    }
    return out;
  },
};

const CANNOT_FIND_CONFIG_MODULE =
  /Cannot find module '(@expo\/config-plugins|@expo\/config-types)'/;

export const configPluginsModuleMissing: Rule = {
  meta: {
    id: "expo.config-plugins-module-missing",
    title: "A config plugin requires @expo/config-plugins, which the app doesn't have",
    platforms: ["expo"],
    scope: "log",
    trigger:
      "Expo CLI output \"PluginError: Cannot find module '@expo/config-plugins'\" (or '@expo/config-types') with a Node 'Require stack'.",
    evidence:
      "The error, the first file in the require stack (the plugin that requires the module), and with the project, that package's declared dependencies on it.",
    versionScope: "Expo SDK 56+ (reported from SDK 56 on)",
    references: [
      "https://docs.expo.dev/config-plugins/plugins/",
      "https://github.com/react-native-datetimepicker/datetimepicker/issues/1050",
      "https://github.com/react-native-datetimepicker/datetimepicker/pull/1053",
      "https://github.com/cleverpush/cleverpush-expo-plugin/issues/5",
    ],
    lastVerified: "2026-11-05",
    fixtures: [
      "logs/expo-prebuild-config-plugins-missing.log",
      "logs/expo-prebuild-config-plugins-missing-app-plugin.log",
      "projects/expo58-config-plugins-missing",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const lines = log.doc.lines;
      const index = lines.findIndex((l) => CANNOT_FIND_CONFIG_MODULE.test(l));
      if (index < 0) continue;
      const missing = CANNOT_FIND_CONFIG_MODULE.exec(lines[index]!)![1]!;
      const stack: string[] = [];
      for (let i = index + 1; i < Math.min(lines.length, index + 20); i++) {
        const m = /^\s*-\s+(\S.*)$/.exec(lines[i]!);
        if (m) stack.push(m[1]!.trim());
        else if (stack.length) break;
      }
      const first = stack[0];
      const owner = first
        ? /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(first)?.[1]?.replace(/\\/g, "/")
        : undefined;
      const fromExpo = owner === "expo" || owner?.startsWith("@expo/");
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: index,
          end: Math.min(lines.length - 1, index + 1 + Math.min(stack.length, 4)),
        }),
      ];
      if (first)
        evidence.push({ source: "log", file: log.doc.path, detail: `Required from ${first}` });
      let declares: string | undefined;
      if (owner && ctx.project) {
        const manifest = readProjectFile(ctx.project.root, `node_modules/${owner}/package.json`);
        if (manifest.ok) {
          try {
            const pkg = JSON.parse(manifest.text) as Record<
              string,
              Record<string, string> | undefined
            >;
            const kinds = ["dependencies", "peerDependencies", "optionalDependencies"].filter(
              (k) => pkg[k]?.[missing],
            );
            declares = kinds.length
              ? kinds.map((k) => `${k} (${pkg[k]![missing]})`).join(", ")
              : "none";
            evidence.push({
              source: "project",
              file: `node_modules/${owner}/package.json`,
              detail: kinds.length
                ? `declares ${missing} in ${declares}`
                : `doesn't declare ${missing}`,
            });
          } catch {
            // an unreadable manifest only removes this detail
          }
        }
        if (!ctx.project.installedVersion(missing))
          evidence.push({
            source: "project",
            detail: `${missing} isn't installed at the top level of node_modules`,
          });
      }
      const library = owner && !fromExpo;
      out.push(
        finding(this.meta, {
          title: library
            ? `Config plugin ${owner} requires ${missing}, which isn't installed for it`
            : `A config plugin requires ${missing}, which isn't installed`,
          severity: "error",
          confidence: library ? "high" : "medium",
          explanation: library
            ? `${owner}'s config plugin loads '${missing}' directly. Expo ships its own copy with the expo package (importable as 'expo/config-plugins'), and the package manager doesn't necessarily hoist that copy to the top of node_modules, so Node can't find it from ${owner} unless the app or the library installs it.${declares && declares !== "none" ? ` ${owner} declares it in ${declares}, but no copy that Node can resolve from it is installed.` : ""} This is a bug in ${owner}: Expo's config plugin docs import from 'expo/config-plugins'.`
            : `${first ? `${first} loads` : "A config plugin loads"} '${missing}' directly, and Node can't resolve it from there. Expo ships it with the expo package, importable as 'expo/config-plugins', which is what Expo's config plugin docs use.`,
          evidence,
          nextSteps: library
            ? [
                `Check for a newer ${owner} that imports from 'expo/config-plugins' (or report it, pointing at react-native-datetimepicker#1053 for the same fix).`,
                `Until then, install it in the app: \`npx expo install ${missing}\`, so Node can resolve it from ${owner}.`,
              ]
            : [
                `In your own plugin files, import from 'expo/config-plugins' instead of '${missing}'.`,
                `Or install it explicitly: \`npx expo install ${missing}\`.`,
              ],
          verification:
            "`npx expo config --type prebuild` resolves the configuration without the error.",
        }),
      );
    }
    return out;
  },
};

const AUTOLINKING_FAILED = /expo-modules-autolinking failed:\s*(.+?)\s*$/;

export const autolinkingScriptFailed: Rule = {
  meta: {
    id: "expo.autolinking-script-failed",
    title: "The expo-modules-autolinking script failed during the native build",
    platforms: ["expo", "android"],
    scope: "log",
    trigger: "A build log line 'expo-modules-autolinking failed: <Node error>'.",
    evidence:
      "The autolinking error, and with the project, android/gradle.properties settings that are passed to the script (expo.inlineModules.watchedDirectories).",
    versionScope: "Expo SDK 57+ (Gradle autolinking plugin)",
    references: [
      "https://docs.expo.dev/modules/autolinking/",
      "https://github.com/expo/expo/issues/52015",
    ],
    lastVerified: "2026-11-05",
    fixtures: ["logs/expo-issue-autolinking-failed-json.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const index = log.doc.lines.findIndex((l) => AUTOLINKING_FAILED.test(l));
      if (index < 0) continue;
      const message = AUTOLINKING_FAILED.exec(log.doc.lines[index]!)![1]!;
      const props = ctx.project
        ? readProjectFile(ctx.project.root, "android/gradle.properties")
        : undefined;
      const watched = props?.ok
        ? findLine(props.text, /^\s*expo\.inlineModules\.watchedDirectories\s*=/)
        : undefined;
      const json = /is not valid JSON|Unexpected token/.test(message);
      const evidence: Evidence[] = [logEvidence(log.doc, { start: index, end: index })];
      if (watched)
        evidence.push({
          source: "project",
          file: "android/gradle.properties",
          line: watched.line,
          excerpt: watched.excerpt,
        });
      out.push(
        finding(this.meta, {
          title: `expo-modules-autolinking failed: ${message.slice(0, 100)}`,
          severity: "error",
          confidence: watched && json ? "high" : "medium",
          explanation:
            `The Gradle build runs expo-modules-autolinking, a Node script, to find native modules, and the script failed: ${message}. This is a failure of that script, not a compile error in your code.` +
            (watched && json
              ? " The script reads expo.inlineModules.watchedDirectories from android/gradle.properties as JSON. On Windows the double quotes are lost when Gradle passes it to node, so the JSON can't be parsed (expo/expo#52015)."
              : json
                ? " The script got an argument or file it couldn't parse as JSON; check the autolinking-related settings in android/gradle.properties and the app config."
                : ""),
          evidence,
          nextSteps:
            watched && json
              ? [
                  "Until expo-modules-autolinking is fixed, set `expo.inlineModules.watchedDirectories=[]` (for example from a config plugin with withGradleProperties). This turns off Kotlin inline modules on Android.",
                  "Or build on macOS or Linux, where the argument reaches node unchanged.",
                ]
              : [
                  "Run the same autolinking command outside Gradle to see the full Node error: `npx expo-modules-autolinking resolve --platform android --json`.",
                  "Check that node_modules is installed and that expo and expo-modules-autolinking are on matching versions (`npx expo install --check`).",
                ],
          verification: "The Gradle build gets past autolinking.",
        }),
      );
    }
    return out;
  },
};

const CONFIG_READ_ERROR = /Error reading Expo config at (.+?):?\s*$/;

export const configEvaluationFailed: Rule = {
  meta: {
    id: "expo.config-evaluation-failed",
    title: "Expo couldn't evaluate the app config",
    platforms: ["expo"],
    scope: "log",
    trigger:
      "Expo CLI output 'Error reading Expo config at <app.config.*>:' followed by the error the config threw.",
    evidence: "The error and the location in the config file from the stack trace.",
    versionScope: "Expo SDK 46+ (dynamic app config)",
    references: [
      "https://docs.expo.dev/workflow/configuration/",
      "https://docs.expo.dev/more/expo-cli/#config",
    ],
    lastVerified: "2026-11-05",
    fixtures: [
      "logs/real-expo58-prebuild-config-error.log",
      "logs/expo-issue-config-load-syntax-error.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const lines = log.doc.lines;
      const index = lines.findIndex((l) => CONFIG_READ_ERROR.test(l));
      if (index < 0) continue;
      const file = CONFIG_READ_ERROR.exec(lines[index]!)![1]!.trim();
      const name = file.split(/[\\/]/).pop()!;
      let message = "";
      for (let i = index + 1; i < Math.min(lines.length, index + 4) && !message; i++)
        message = lines[i]!.trim();
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const at = lines
        .slice(index, index + 20)
        .map((l) => new RegExp(`${escaped}:(\\d+)(?::(\\d+))?\\)?\\s*$`).exec(l.trim()))
        .find(Boolean);
      const where = at ? `${name}:${at[1]}${at[2] ? `:${at[2]}` : ""}` : name;
      const syntax = /SyntaxError|Unexpected (?:token|identifier)/.test(
        `${lines[index - 1] ?? ""} ${lines[index]} ${message}`,
      );
      out.push(
        finding(this.meta, {
          title: `${name} threw while Expo read it: ${message.slice(0, 100)}`,
          severity: "error",
          confidence: "high",
          explanation:
            `Expo executes ${name} (it isn't only read) to get the app config before prebuild, start, export and EAS Build, and the file ${syntax ? "couldn't be parsed" : "threw an error"}: ${message} (at ${where}). Nothing native was built yet; the problem is in the config file or something it imports.` +
            (syntax
              ? " A syntax error in a .ts config can also mean the TypeScript in it isn't supported by the loader that ran it (for example type-only syntax under another runtime)."
              : ""),
          evidence: [
            logEvidence(
              log.doc,
              { start: index, end: Math.min(lines.length - 1, index + 3) },
              `at ${where}`,
            ),
          ],
          nextSteps: [
            `Run \`npx expo config\` to reproduce it quickly, then fix ${where}.`,
            "If the config reads environment variables (process.env), check that they're set where it ran: EAS Build doesn't receive git-ignored .env files.",
          ],
          verification: "`npx expo config --type public` prints the resolved configuration.",
        }),
      );
    }
    return out;
  },
};

export const expoLogRules: Rule[] = [
  configEvaluationFailed,
  configPluginNotResolved,
  configPluginsModuleMissing,
  autolinkingScriptFailed,
];
