import { existsSync } from "node:fs";
import semver from "semver";
import { loadUploadIgnore } from "../../collectors/ignore.js";
import {
  collectSourceFiles,
  findLine,
  parseEnvNames,
  readJsonFile,
  readProjectFile,
} from "../../collectors/project-files.js";
import { finding, type Rule, type RuleContext } from "../../engine/rule.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";
import {
  AGP_JDK_REQUIREMENT,
  GRADLE_MIN_FOR_JAVA,
  RN_JDK_REQUIREMENT,
  compareVersions,
} from "../android/compat.js";

const VERIFIED = "2026-10-14";

export const invalidPackageJson: Rule = {
  meta: {
    id: "common.invalid-package-json",
    title: "package.json is not valid JSON",
    platforms: ["common"],
    scope: "project",
    trigger: "package.json exists but can't be parsed.",
    evidence: "The parser error and line.",
    versionScope: "All",
    references: ["https://docs.npmjs.com/cli/configuring-npm/package-json"],
    lastVerified: VERIFIED,
    fixtures: ["projects/invalid-package-json"],
  },
  run({ project }) {
    if (!project?.packageJsonError) return [];
    return [
      finding(this.meta, {
        severity: "error",
        confidence: "high",
        explanation: `package.json couldn't be parsed (${project.packageJsonError.message}). Package managers, Metro, Expo CLI, and native builds all read it, so they'll fail too. Project checks that depend on it were skipped.`,
        evidence: [
          {
            source: "project",
            file: "package.json",
            ...(project.packageJsonError.line ? { line: project.packageJsonError.line } : {}),
            detail: project.packageJsonError.message,
          },
        ],
        nextSteps: [
          "Fix the JSON syntax at the reported location.",
          "Run `node -e \"require('./package.json')\"` to confirm it parses.",
        ],
      }),
    ];
  },
};

export const multipleLockfiles: Rule = {
  meta: {
    id: "common.multiple-lockfiles",
    title: "Multiple package manager lockfiles",
    platforms: ["common"],
    scope: "project",
    trigger:
      "More than one of package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb/bun.lock in the project (or workspace) root.",
    evidence: "The lockfiles found.",
    versionScope: "All",
    references: [
      "https://docs.expo.dev/build-reference/npm-hooks/",
      "https://docs.npmjs.com/cli/configuring-npm/package-lock-json",
    ],
    lastVerified: VERIFIED,
    fixtures: ["projects/rn-cli-missing-dependency"],
  },
  run({ project }) {
    if (!project || project.lockfiles.length < 2) return [];
    return [
      finding(this.meta, {
        title: `Multiple lockfiles: ${project.lockfiles.join(", ")}`,
        severity: "warning",
        confidence: "high",
        explanation:
          "Different tools and CI services pick the package manager from the lockfile they find, so local and cloud builds can install different dependency trees. EAS Build, for example, chooses the package manager from the lockfile.",
        evidence: project.lockfiles.map((f) => ({
          source: "project" as const,
          file: f,
          detail: "lockfile present",
        })),
        nextSteps: [
          `Pick one package manager${project.packageManager ? ` (package.json "packageManager" says ${project.packageManager})` : ""}, delete the other lockfiles, and reinstall.`,
        ],
        verification:
          "Only one lockfile remains, and a clean install followed by a build succeeds.",
      }),
    ];
  },
};

export const projectNotDetected: Rule = {
  meta: {
    id: "common.project-not-detected",
    title: "No supported React Native or Expo project detected",
    platforms: ["common"],
    scope: "project",
    trigger:
      "The scanned directory has no package.json, is a monorepo root, or doesn't depend on react-native or expo.",
    evidence: "What was found in the directory.",
    versionScope: "All",
    references: [],
    lastVerified: VERIFIED,
    fixtures: ["projects/not-a-project"],
  },
  run({ project }) {
    if (!project || project.kind === "expo" || project.kind === "react-native-cli") return [];
    return [
      finding(this.meta, {
        title:
          project.kind === "monorepo-root"
            ? "Monorepo root detected; point the scan at an app package"
            : this.meta.title,
        severity: "info",
        confidence: "high",
        explanation:
          project.kind === "monorepo-root"
            ? "This directory defines workspaces but doesn't depend on react-native or expo itself. Project checks were skipped."
            : "Project-specific checks only run for directories whose package.json depends on react-native or expo. They were skipped.",
        evidence: project.notes.map((n) => ({ source: "project" as const, detail: n })),
        nextSteps: [
          "Run the scan from the app directory, or pass `--cwd <path-to-app>`.",
          "Log analysis (`rn-build-doctor analyze <log>`) works without a project.",
        ],
      }),
    ];
  },
};

// --- Environment variables -----------------------------------------------------------------

const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
];

interface EnvReference {
  name: string;
  file: string;
  line: number;
  excerpt: string;
  dynamic: boolean;
}

interface EasProfile {
  env?: Record<string, unknown>;
  extends?: string;
  environment?: string;
}

function findReferences(path: string, text: string, prefixOnly: boolean): EnvReference[] {
  const refs: EnvReference[] = [];
  const lines = text.split(/\r?\n/);
  const patterns: [RegExp, boolean][] = [
    [/process\.env\.([A-Z_][A-Z0-9_]*)/g, false],
    [/process\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g, true],
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("process.env")) continue;
    for (const [pattern, dynamic] of patterns) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        if (prefixOnly && !m[1]!.startsWith("EXPO_PUBLIC_")) continue;
        refs.push({
          name: m[1]!,
          file: path,
          line: i + 1,
          excerpt: line.trim().slice(0, 300),
          dynamic,
        });
      }
    }
    // const { EXPO_PUBLIC_X } = process.env
    const destructure = /\{([^}]*)\}\s*=\s*process\.env\b/.exec(line);
    if (destructure) {
      for (const name of destructure[1]!.split(",").map((s) => s.split(":")[0]!.trim())) {
        if (/^EXPO_PUBLIC_[A-Z0-9_]+$/.test(name)) {
          refs.push({
            name,
            file: path,
            line: i + 1,
            excerpt: line.trim().slice(0, 300),
            dynamic: true,
          });
        }
      }
    }
  }
  return refs;
}

const IGNORED_NAMES =
  /^(?:NODE_ENV|CI|HOME|PATH|PWD|USER|TZ|LANG|EAS_BUILD\w*|EXPO_(?!PUBLIC_)\w*|APP_VARIANT)$/;

interface EnvAnalysis {
  references: EnvReference[];
  envFileNames: Map<string, string[]>; // file -> names
  easProfiles: Record<string, EasProfile>;
  easJson: boolean;
  usesEasEnvironments: boolean;
  sourceTruncated: boolean;
}

const analysisCache = new WeakMap<object, EnvAnalysis>();

function analyzeEnv(ctx: RuleContext): EnvAnalysis | undefined {
  const project = ctx.project;
  if (!project || project.kind !== "expo") return undefined;
  const cached = analysisCache.get(project);
  if (cached) return cached;

  const references: EnvReference[] = [];
  const { files, truncated } = collectSourceFiles(project.root);
  if (truncated) {
    project.notes.push(
      "The source scan stopped at its size limits; some environment variable references may not have been checked.",
    );
  }
  for (const file of files) {
    if (/^app\.config\.[cm]?[jt]s$/.test(file.path)) continue;
    references.push(...findReferences(file.path, file.text, true));
  }
  const dynamicConfig = project.appConfig.dynamicConfig;
  if (dynamicConfig) {
    references.push(
      ...findReferences(dynamicConfig.file, dynamicConfig.text, false).filter(
        (r) => !IGNORED_NAMES.test(r.name),
      ),
    );
  }

  const envFileNames = new Map<string, string[]>();
  for (const file of ENV_FILES) {
    const text = readProjectFile(project.root, file);
    if (text.ok) envFileNames.set(file, parseEnvNames(text.text));
  }

  const eas = readJsonFile<{ build?: Record<string, EasProfile> }>(project.root, "eas.json");
  const easProfiles =
    eas.ok && eas.value?.build && typeof eas.value.build === "object" ? eas.value.build : {};
  const usesEasEnvironments = Object.values(easProfiles).some(
    (p) => typeof p?.environment === "string",
  );
  const analysis = {
    references,
    envFileNames,
    easProfiles,
    easJson: eas.ok,
    usesEasEnvironments,
    sourceTruncated: truncated,
  };
  analysisCache.set(project, analysis);
  return analysis;
}

function profileEnv(profiles: Record<string, EasProfile>, name: string, depth = 0): Set<string> {
  const profile = profiles[name];
  if (!profile || depth > 10) return new Set();
  const inherited = profile.extends
    ? profileEnv(profiles, profile.extends, depth + 1)
    : new Set<string>();
  for (const key of Object.keys(profile.env ?? {})) inherited.add(key);
  return inherited;
}

function uniqueByName(refs: EnvReference[]): EnvReference[] {
  const seen = new Map<string, EnvReference>();
  for (const r of refs) if (!seen.has(r.name)) seen.set(r.name, r);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function refEvidence(ref: EnvReference): Evidence {
  return {
    source: "project",
    file: ref.file,
    line: ref.line,
    excerpt: ref.excerpt,
    detail: `references ${ref.name}`,
  };
}

export const publicEnvDynamicAccess: Rule = {
  meta: {
    id: "expo.public-env-dynamic-access",
    title: "EXPO_PUBLIC_ variable is not accessed with dot notation",
    platforms: ["expo", "javascript"],
    scope: "project",
    trigger:
      "App source reads an EXPO_PUBLIC_ variable with bracket notation or destructuring from process.env.",
    evidence: "The source file, line, and code.",
    versionScope: "Expo SDK 49+",
    references: ["https://docs.expo.dev/guides/environment-variables/"],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-env-missing-in-eas"],
  },
  run(ctx) {
    const analysis = analyzeEnv(ctx);
    if (!analysis) return [];
    return analysis.references
      .filter(
        (r) => r.dynamic && r.name.startsWith("EXPO_PUBLIC_") && !/^app\.config\./.test(r.file),
      )
      .slice(0, 10)
      .map((ref) =>
        finding(this.meta, {
          title: `${ref.name} is read dynamically in ${ref.file}`,
          severity: "warning",
          confidence: "high",
          explanation:
            "Expo inlines EXPO_PUBLIC_ variables at build time only when they're written as `process.env.EXPO_PUBLIC_NAME`. Bracket access and destructuring aren't replaced, so the value is undefined in the built app, even when it's defined in .env or EAS.",
          evidence: [refEvidence(ref)],
          nextSteps: [`Replace the access with \`process.env.${ref.name}\`.`],
          verification:
            "In a build, the value is defined at the point of use (log it during development).",
        }),
      );
  },
};

export const variableNotDefined: Rule = {
  meta: {
    id: "env.variable-not-defined-locally",
    title: "Referenced environment variable is not defined in any inspected source",
    platforms: ["expo"],
    scope: "project",
    trigger:
      "An EXPO_PUBLIC_ variable referenced in app source (or any variable in app.config.*) is absent from .env files, eas.json build profiles, and the current shell environment.",
    evidence: "The first reference (file and line) and the list of sources inspected.",
    versionScope: "Expo SDK 49+",
    references: [
      "https://docs.expo.dev/guides/environment-variables/",
      "https://docs.expo.dev/eas/environment-variables/",
    ],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-env-missing-in-eas"],
  },
  run(ctx) {
    const analysis = analyzeEnv(ctx);
    if (!analysis) return [];
    const definedLocally = new Set<string>([...analysis.envFileNames.values()].flat());
    for (const profile of Object.keys(analysis.easProfiles))
      for (const n of profileEnv(analysis.easProfiles, profile)) definedLocally.add(n);
    const shell = ctx.env?.variableNames ?? new Set<string>();
    const missing = uniqueByName(analysis.references).filter(
      (r) => !definedLocally.has(r.name) && !shell.has(r.name),
    );
    const inspected = [
      ...analysis.envFileNames.keys(),
      ...(analysis.easJson ? ["eas.json"] : []),
      "current shell environment",
    ];
    return missing.map((ref) =>
      finding(this.meta, {
        title: `${ref.name} is referenced but not defined locally`,
        severity: analysis.usesEasEnvironments ? "info" : "warning",
        confidence: "medium",
        explanation: `${ref.name} is used in ${ref.file}, but no inspected source defines it (${inspected.join(", ")}). If it isn't set in the build environment, it will be undefined in the app. It may be defined somewhere this tool can't see, such as EAS environment variables or CI secrets.`,
        evidence: [
          refEvidence(ref),
          { source: "environment", detail: `Not found in: ${inspected.join(", ")}` },
        ],
        nextSteps: [
          "If the build runs on EAS, check `eas env:list --environment <environment>` for this variable.",
          "Otherwise, define it in the appropriate .env file or build profile `env`.",
        ],
        limitations: [
          "Variables stored in EAS, CI secrets, or other remote systems can't be seen locally.",
        ],
      }),
    );
  },
};

export const envFileNotUploaded: Rule = {
  meta: {
    id: "expo.env-file-not-available-in-eas",
    title: "Variable is defined only in an ignored .env file",
    platforms: ["expo"],
    scope: "project",
    trigger:
      "An Expo project with eas.json references a variable that is defined only in a .env file ignored by .easignore/.gitignore, and not in the eas.json `env` of the production profile (or any profile when there is no production profile).",
    evidence:
      "The reference, the .env file that defines it, the ignore rule, and the eas.json profile.",
    versionScope: "Expo SDK 49+, EAS Build",
    references: [
      "https://docs.expo.dev/eas/environment-variables/faq/",
      "https://docs.expo.dev/build-reference/easignore/",
    ],
    lastVerified: VERIFIED,
    fixtures: ["projects/expo-env-missing-in-eas"],
  },
  run(ctx) {
    const analysis = analyzeEnv(ctx);
    const project = ctx.project;
    if (!analysis || !project || !analysis.easJson) return [];
    const ignore = loadUploadIgnore(project.root);
    if (!ignore) return [];
    const ignoredFiles = [...analysis.envFileNames.keys()].filter((f) => ignore.isIgnored(f));
    if (!ignoredFiles.length) return [];
    const uploadedNames = new Set<string>(
      [...analysis.envFileNames.entries()]
        .filter(([f]) => !ignore.isIgnored(f))
        .flatMap(([, n]) => n),
    );
    const profiles = Object.keys(analysis.easProfiles);
    const target = profiles.includes("production") ? ["production"] : profiles;
    const out: DraftFinding[] = [];
    for (const ref of uniqueByName(analysis.references)) {
      const definedIn = ignoredFiles.filter((f) =>
        analysis.envFileNames.get(f)!.includes(ref.name),
      );
      if (!definedIn.length || uploadedNames.has(ref.name)) continue;
      const missingProfiles = target.filter(
        (p) => !profileEnv(analysis.easProfiles, p).has(ref.name),
      );
      if (target.length && !missingProfiles.length) continue;
      const easJsonText = readProjectFile(project.root, "eas.json");
      const profileLine =
        easJsonText.ok && missingProfiles[0]
          ? findLine(easJsonText.text, `"${missingProfiles[0]}"`)
          : undefined;
      out.push(
        finding(this.meta, {
          title: `${ref.name} is defined only in ${definedIn.join(", ")}, which EAS Build doesn't receive`,
          severity: "warning",
          confidence: "medium",
          explanation: `${ref.name} is used in ${ref.file} and defined in ${definedIn.join(", ")}. ${ignore.file} excludes that file, so EAS doesn't upload it (Expo: EAS servers "often don't have access to your local .env files that are git ignored"). It's also missing from the eas.json env of ${missingProfiles.length ? missingProfiles.map((p) => `'${p}'`).join(", ") : "every build profile"}. A local or development build can work while the EAS build gets undefined. This matches the "works in development, crashes in production" pattern. It isn't confirmed, because the variable may be set in EAS environment variables, which this tool can't read.`,
          evidence: [
            refEvidence(ref),
            {
              source: "project",
              file: definedIn[0]!,
              detail: `${ref.name} is defined here (value not read)`,
            },
            {
              source: "project",
              file: ignore.file,
              detail: `${definedIn[0]} is ignored for upload`,
            },
            {
              source: "project",
              file: "eas.json",
              ...(profileLine ? { line: profileLine.line, excerpt: profileLine.excerpt } : {}),
              detail: `No ${ref.name} in env of profile(s): ${missingProfiles.join(", ") || "(none defined)"}`,
            },
          ],
          nextSteps: [
            `Check whether EAS has it: \`eas env:list --environment production\` (or the environment your profile uses).`,
            `If it's missing, set it with \`eas env:set --name ${ref.name} --value <value> --environment production --visibility plaintext\`, or add it to the profile's env in eas.json if it isn't sensitive.`,
            "Rebuild. EXPO_PUBLIC_ values are inlined at build time.",
          ],
          verification: `\`eas env:list --environment production\` shows ${ref.name}, and a new build no longer fails where the value is used.`,
          limitations: [
            "EAS environment variables configured on expo.dev can't be read by a local scan.",
          ],
        }),
      );
    }
    return out;
  },
};

// --- Android environment ---------------------------------------------------------------------

export const jdkTooOld: Rule = {
  meta: {
    id: "android.jdk-too-old",
    title: "Installed JDK is older than the project requires",
    platforms: ["android"],
    scope: "project",
    trigger:
      "Project has an android/ folder; the detected JDK (JAVA_HOME or java on PATH) is older than 17 while React Native ≥ 0.73 or Android Gradle Plugin ≥ 8 is used, and android/gradle.properties doesn't set org.gradle.java.home.",
    evidence: "Detected Java version and source, and the React Native/AGP version.",
    versionScope: "React Native 0.73+, Android Gradle Plugin 8+",
    references: [AGP_JDK_REQUIREMENT.source, RN_JDK_REQUIREMENT.source],
    lastVerified: VERIFIED,
    fixtures: ["projects/rn-cli-missing-dependency"],
  },
  run({ project, env }) {
    if (!project?.hasAndroid || !env?.java) return [];
    const rn = project.versions["react-native"];
    const agp = project.versions["android gradle plugin"];
    const rnRequires = rn && semver.valid(rn) && semver.gte(rn, RN_JDK_REQUIREMENT.minReactNative);
    const agpRequires = agp && compareVersions(agp, `${AGP_JDK_REQUIREMENT.minAgpMajor}.0`) >= 0;
    if (!rnRequires && !agpRequires) return [];
    if (env.java.major >= 17) return [];
    const props = readProjectFile(project.root, "android/gradle.properties");
    if (props.ok && /^\s*org\.gradle\.java\.home\s*=/m.test(props.text)) return [];
    return [
      finding(this.meta, {
        title: `Java ${env.java.major} detected; this project needs JDK 17`,
        severity: "warning",
        confidence: "medium",
        explanation: `The JDK found through ${env.java.source} is ${env.java.raw}. ${rnRequires ? `React Native ${rn}` : `Android Gradle Plugin ${agp}`} requires JDK 17. Gradle may use a different JDK (for example Android Studio's Gradle JDK setting), so confirm which one your build actually uses.`,
        evidence: [
          { source: "environment", detail: `Java ${env.java.raw} (${env.java.source})` },
          {
            source: "project",
            detail: rnRequires ? `react-native ${rn}` : `android gradle plugin ${agp}`,
          },
        ],
        nextSteps: [
          "Install JDK 17 and point JAVA_HOME at it.",
          "Confirm with `cd android && ./gradlew --version`.",
        ],
        verification: "`./gradlew --version` reports JVM 17.",
      }),
    ];
  },
};

export const jdkTooNewForGradle: Rule = {
  meta: {
    id: "android.jdk-too-new-for-gradle",
    title: "Installed JDK is newer than the project's Gradle wrapper supports",
    platforms: ["android"],
    scope: "project",
    trigger:
      "Project has an android/ folder; the detected JDK (JAVA_HOME or java on PATH) is in the Gradle compatibility table, the Gradle wrapper version is older than the minimum Gradle for that JDK, and android/gradle.properties doesn't set org.gradle.java.home.",
    evidence: "Detected Java version and source, and the Gradle wrapper version.",
    versionScope: `Gradle/Java compatibility table, checked ${GRADLE_MIN_FOR_JAVA.lastVerified} (Java 17–27)`,
    references: [GRADLE_MIN_FOR_JAVA.source],
    lastVerified: VERIFIED,
    fixtures: ["projects/rn-cli-old-gradle", "jdks/jdk17"],
  },
  run({ project, env }) {
    if (!project?.hasAndroid || !env?.java) return [];
    const gradle = project.versions["gradle (wrapper)"];
    const minGradle = GRADLE_MIN_FOR_JAVA.table[env.java.major];
    if (!gradle || !minGradle || compareVersions(gradle, minGradle) >= 0) return [];
    const props = readProjectFile(project.root, "android/gradle.properties");
    if (props.ok && /^\s*org\.gradle\.java\.home\s*=/m.test(props.text)) return [];
    return [
      finding(this.meta, {
        title: `Java ${env.java.major} detected; Gradle ${gradle} doesn't support it (needs Gradle ${minGradle}+)`,
        severity: "warning",
        confidence: "medium",
        explanation: `The JDK found through ${env.java.source} is ${env.java.raw}. According to the Gradle compatibility matrix (checked ${GRADLE_MIN_FOR_JAVA.lastVerified}), Gradle runs on Java ${env.java.major} only from version ${minGradle}, and this project's wrapper uses Gradle ${gradle}. A build with this JDK typically fails with "Unsupported class file major version ${env.java.major + 44}". Gradle may use a different JDK (for example Android Studio's Gradle JDK setting), so confirm which one your build actually uses.`,
        evidence: [
          { source: "environment", detail: `Java ${env.java.raw} (${env.java.source})` },
          {
            source: "project",
            file: "android/gradle/wrapper/gradle-wrapper.properties",
            detail: `Gradle wrapper ${gradle}`,
          },
        ],
        nextSteps: [
          "Build with a JDK that this Gradle version supports (for older React Native versions, usually JDK 11 or earlier): point JAVA_HOME at it, or set org.gradle.java.home in android/gradle.properties.",
          "Alternatively, upgrade React Native, which brings a newer Gradle wrapper and Android Gradle Plugin. Upgrading Gradle alone usually breaks the plugins an older React Native version expects.",
          "Confirm with `cd android && ./gradlew --version`.",
        ],
        verification:
          "`./gradlew --version` reports a JVM that the wrapper's Gradle version supports.",
        limitations: [
          "Only the JDK on JAVA_HOME or PATH is checked; IDE and CI settings can select a different one.",
        ],
      }),
    ];
  },
};

export const androidSdkNotConfigured: Rule = {
  meta: {
    id: "android.sdk-not-configured",
    title: "Android SDK location is not configured",
    platforms: ["android"],
    scope: "project",
    trigger:
      "Project has an android/ folder, android/local.properties has no sdk.dir, and ANDROID_HOME/ANDROID_SDK_ROOT is unset or points to a missing directory.",
    evidence: "local.properties state and the SDK environment variables (names only).",
    versionScope: "All Android Gradle Plugin versions",
    references: [
      "https://developer.android.com/tools/variables",
      "https://reactnative.dev/docs/set-up-your-environment",
    ],
    lastVerified: VERIFIED,
    fixtures: ["projects/rn-cli-missing-dependency"],
  },
  run({ project, env }) {
    if (!project?.hasAndroid || !env) return [];
    const local = readProjectFile(project.root, "android/local.properties");
    const sdkDir = local.ok ? /^\s*sdk\.dir\s*=\s*(.+)$/m.exec(local.text)?.[1]?.trim() : undefined;
    const sdkDirExists = !!sdkDir && existsSync(sdkDir.replace(/\\:/g, ":").replace(/\\\\/g, "\\"));
    if (sdkDirExists || env.androidSdk?.exists) return [];
    const evidence: Evidence[] = [
      {
        source: "project",
        file: "android/local.properties",
        detail: local.ok
          ? sdkDir
            ? `sdk.dir points to a missing directory`
            : "no sdk.dir entry"
          : "file not present",
      },
      {
        source: "environment",
        detail: env.androidSdk
          ? `${env.androidSdk.variable} is set${env.androidSdk.exists ? "" : " but the directory does not exist"}`
          : "ANDROID_HOME and ANDROID_SDK_ROOT are not set",
      },
    ];
    return [
      finding(this.meta, {
        // Expo projects commonly build only on EAS, where the local SDK is irrelevant.
        severity: project.kind === "expo" ? "info" : "warning",
        confidence: env.androidSdk && !env.androidSdk.exists ? "high" : "medium",
        explanation:
          "Local Android builds need the SDK location from android/local.properties (sdk.dir) or ANDROID_HOME. Neither points to an existing directory in this environment, so a local Gradle build would fail with 'SDK location not found'. Cloud builds such as EAS aren't affected.",
        evidence,
        nextSteps: [
          "Install the Android SDK (Android Studio > SDK Manager).",
          "Export ANDROID_HOME (macOS default: ~/Library/Android/sdk) in your shell profile, or set sdk.dir in android/local.properties.",
        ],
        verification: "`cd android && ./gradlew help` runs without an SDK location error.",
        limitations: [
          "The check uses the environment of the shell that ran this scan. IDEs and CI may use a different one.",
        ],
      }),
    ];
  },
};

export const commonProjectRules: Rule[] = [
  projectNotDetected,
  invalidPackageJson,
  multipleLockfiles,
  publicEnvDynamicAccess,
  variableNotDefined,
  envFileNotUploaded,
  jdkTooOld,
  jdkTooNewForGradle,
  androidSdkNotConfigured,
];
