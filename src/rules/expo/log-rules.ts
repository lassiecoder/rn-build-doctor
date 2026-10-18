import { findLine } from "../../collectors/project-files.js";
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

export const expoLogRules: Rule[] = [configPluginNotResolved];
