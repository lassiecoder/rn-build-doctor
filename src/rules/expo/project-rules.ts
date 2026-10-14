import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { loadUploadIgnore } from "../../collectors/ignore.js";
import { findLine } from "../../collectors/project-files.js";
import { findPackageDir } from "../../detection/project-type.js";
import { finding, type Rule } from "../../engine/rule.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

const VERIFIED = "2026-10-14";

export const invalidAppJson: Rule = {
  meta: {
    id: "expo.invalid-app-json",
    title: "app.json is not valid JSON",
    platforms: ["expo"],
    scope: "project",
    trigger: "app.json exists but can't be parsed as a JSON object.",
    evidence: "The parser error and line.",
    versionScope: "All Expo SDK versions",
    references: ["https://docs.expo.dev/workflow/configuration/"],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-invalid-app-json"],
  },
  run({ project }) {
    const error = project?.appConfig.appJsonError;
    if (!project || !error) return [];
    const lineText = error.line
      ? project.appConfig.appJsonText?.split(/\r?\n/)[error.line - 1]?.trim()
      : undefined;
    return [
      finding(this.meta, {
        severity: "error",
        confidence: "high",
        explanation: `Expo reads app.json for every build and start command. Parsing failed: ${error.message}. Expo CLI and EAS Build will fail with a configuration error before building.`,
        evidence: [
          {
            source: "project",
            file: "app.json",
            ...(error.line ? { line: error.line } : {}),
            ...(lineText !== undefined ? { excerpt: lineText } : {}),
            detail: error.message,
          },
        ],
        nextSteps: [
          "Fix the JSON syntax at the reported location (trailing commas and comments aren't allowed in app.json).",
          "Run `npx expo config` to confirm Expo can read the configuration.",
        ],
        verification:
          "`npx expo config --type public` prints the resolved configuration without errors.",
      }),
    ];
  },
};

function pluginNames(expo: Record<string, unknown> | undefined): string[] {
  const plugins = expo?.["plugins"];
  if (!Array.isArray(plugins)) return [];
  return plugins
    .map((p) =>
      typeof p === "string" ? p : Array.isArray(p) && typeof p[0] === "string" ? p[0] : undefined,
    )
    .filter((p): p is string => !!p);
}

function packageOfPlugin(plugin: string): string | undefined {
  if (plugin.startsWith(".") || plugin.startsWith("/")) return undefined;
  const parts = plugin.split("/");
  return plugin.startsWith("@")
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0];
}

export const configPluginNotInstalled: Rule = {
  meta: {
    id: "expo.config-plugin-not-installed",
    title: "Config plugin package is not installed",
    platforms: ["expo"],
    scope: "project",
    trigger:
      "A package-based entry in app.json `plugins` that isn't declared in package.json, checked against node_modules when installed.",
    evidence: "The plugin entry in app.json and the package.json dependency state.",
    versionScope: "Expo SDK 41+ (config plugins)",
    references: ["https://docs.expo.dev/config-plugins/introduction/"],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-missing-plugin"],
  },
  run({ project }) {
    if (!project || project.kind !== "expo" || !project.appConfig.expo) return [];
    const out: DraftFinding[] = [];
    for (const plugin of pluginNames(project.appConfig.expo)) {
      const pkg = packageOfPlugin(plugin);
      if (!pkg || project.declared[pkg]) continue;
      const installed = project.installedVersion(pkg);
      const line = project.appConfig.appJsonText
        ? findLine(project.appConfig.appJsonText, `"${plugin}"`)
        : undefined;
      const evidence: Evidence[] = [
        {
          source: "project",
          file: "app.json",
          ...(line ? { line: line.line, excerpt: line.excerpt } : {}),
          detail: `plugin: ${plugin}`,
        },
        {
          source: "project",
          file: "package.json",
          detail: `'${pkg}' is not in dependencies or devDependencies`,
        },
      ];
      if (installed)
        evidence.push({
          source: "project",
          detail: `node_modules contains ${pkg}@${installed} (transitive)`,
        });
      const verifiedMissing = !installed && project.nodeModulesPresent;
      out.push(
        finding(this.meta, {
          title: installed
            ? `Config plugin '${plugin}' relies on an undeclared package`
            : `Config plugin '${plugin}' is not installed`,
          severity: installed ? "warning" : "error",
          confidence: verifiedMissing || installed ? "high" : "medium",
          explanation: installed
            ? `app.json references the config plugin '${plugin}'. Its package is only present as a transitive dependency, so a clean install with a different dependency tree can remove it.`
            : `app.json references the config plugin '${plugin}', but '${pkg}' isn't declared in package.json${project.nodeModulesPresent ? " or installed in node_modules" : " (dependencies aren't installed, so node_modules couldn't be checked)"}. Expo resolves config plugins when it reads the config, so prebuild and EAS Build fail with a plugin resolution error.`,
          evidence,
          nextSteps: [
            `Install it with \`npx expo install ${pkg}\`, or remove the plugin entry if it's no longer used.`,
          ],
          verification:
            "`npx expo config --type prebuild` resolves the configuration without a plugin error.",
        }),
      );
    }
    return out;
  },
};

export const packageVersionMismatch: Rule = {
  meta: {
    id: "expo.package-version-mismatch",
    title: "Installed packages don't match the Expo SDK's expected versions",
    platforms: ["expo"],
    scope: "project",
    trigger:
      "An installed package's version doesn't satisfy the range in the installed expo package's bundledNativeModules.json (the data `npx expo install --check` uses).",
    evidence: "Package, installed version, and expected range from bundledNativeModules.json.",
    versionScope: "Expo SDK versions that ship bundledNativeModules.json",
    references: [
      "https://docs.expo.dev/more/expo-cli/#install",
      "https://docs.expo.dev/develop/tools/#expo-doctor",
    ],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-version-mismatch"],
  },
  run({ project }) {
    if (!project || project.kind !== "expo") return [];
    const expoDir = findPackageDir(project.root, "expo");
    if (!expoDir) return [];
    let bundled: Record<string, string>;
    try {
      bundled = JSON.parse(
        readFileSync(join(expoDir, "bundledNativeModules.json"), "utf8"),
      ) as Record<string, string>;
    } catch {
      return [];
    }
    const mismatches: { pkg: string; installed: string; expected: string }[] = [];
    for (const pkg of Object.keys(project.declared).sort()) {
      const expected = bundled[pkg];
      if (typeof expected !== "string" || !semver.validRange(expected)) continue;
      const installed = project.installedVersion(pkg);
      if (!installed || !semver.valid(installed)) continue;
      if (!semver.satisfies(installed, expected, { includePrerelease: true })) {
        mismatches.push({ pkg, installed, expected });
      }
    }
    if (!mismatches.length) return [];
    const sdk = project.installedVersion("expo");
    const critical = mismatches.some((m) => m.pkg === "react-native" || m.pkg === "react");
    return [
      finding(this.meta, {
        title:
          `${mismatches.length === 1 ? "1 package doesn't" : `${mismatches.length} packages don't`} match Expo SDK ${sdk ?? ""}`.trim(),
        severity: critical ? "error" : "warning",
        confidence: "high",
        explanation:
          "The installed expo package lists the versions of native packages it was tested with. These installed versions are outside those ranges. Mismatched native modules commonly cause build failures or crashes that only appear in development builds or release binaries, not in Expo Go.",
        evidence: mismatches.slice(0, 20).map((m) => ({
          source: "project" as const,
          file: "package.json",
          detail: `${m.pkg}: installed ${m.installed}, expected ${m.expected}`,
        })),
        nextSteps: [
          "Run `npx expo install --check` to review the mismatches and `npx expo install --fix` to align them.",
          "Run `npx expo-doctor` for Expo's complete set of checks (requires network access).",
        ],
        verification: "`npx expo install --check` reports that dependencies are up to date.",
        limitations: [
          "Expected versions come from the installed expo package (offline). `npx expo install --check` also uses Expo's online version data, so it can report additional packages that have newer patch releases for this SDK.",
        ],
      }),
    ];
  },
};

/** App config fields that only reach native projects through prebuild. */
const PREBUILD_FIELDS = [
  "plugins",
  "ios",
  "android",
  "icon",
  "splash",
  "scheme",
  "orientation",
  "userInterfaceStyle",
  "notification",
  "backgroundColor",
  "primaryColor",
  "locales",
];

export const nativeDirsWithPrebuildConfig: Rule = {
  meta: {
    id: "expo.native-dirs-with-prebuild-config",
    title: "Native folders are committed but app config has native settings",
    platforms: ["expo"],
    scope: "project",
    trigger:
      "An Expo project has android/ or ios/ folders that are not ignored, and its app config sets fields that are only applied by prebuild (plugins, ios, android, icon, splash, ...).",
    evidence: "The native folders, their ignore status, and the native config fields present.",
    versionScope: "Expo SDK 46+ (Continuous Native Generation / prebuild)",
    references: [
      "https://docs.expo.dev/workflow/continuous-native-generation/",
      "https://docs.expo.dev/workflow/prebuild/",
    ],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-native-dirs"],
  },
  run({ project }) {
    if (!project || project.kind !== "expo" || !project.appConfig.expo) return [];
    const ignore = loadUploadIgnore(project.root);
    const dirs = [
      project.hasAndroid ? "android" : undefined,
      project.hasIos ? "ios" : undefined,
    ].filter((d): d is string => !!d && !ignore?.isIgnored(d, true));
    if (!dirs.length) return [];
    const fields = PREBUILD_FIELDS.filter((f) => project.appConfig.expo![f] !== undefined);
    if (!fields.length) return [];
    return [
      finding(this.meta, {
        title: `${dirs.join(" and ")} folder${dirs.length > 1 ? "s are" : " is"} present, so app config native settings aren't synced`,
        severity: "warning",
        confidence: "medium",
        explanation: `When native folders exist, EAS Build and \`npx expo run\` use them as they are and don't run prebuild. Changes to ${fields.join(", ")} in app config therefore won't reach the native project until you regenerate it. This explains "I changed app.json and nothing happened". It isn't a problem if you maintain the native folders by hand.`,
        evidence: [
          ...dirs.map((d) => ({
            source: "project" as const,
            file: `${d}/`,
            detail: `${d}/ exists and is not ignored by ${ignore?.file ?? "any ignore file"}`,
          })),
          {
            source: "project",
            file: "app.json",
            detail: `Native config fields: ${fields.join(", ")}`,
          },
        ],
        nextSteps: [
          "If you use Continuous Native Generation, add /android and /ios to .gitignore and regenerate them with `npx expo prebuild --clean`.",
          "If you maintain the native folders by hand, apply app config changes to them directly.",
        ],
        verification:
          "After prebuild, the native project reflects the app config values (for example the scheme or plugin changes).",
      }),
    ];
  },
};

export const expoProjectRules: Rule[] = [
  invalidAppJson,
  configPluginNotInstalled,
  packageVersionMismatch,
  nativeDirsWithPrebuildConfig,
];
