import { relative } from "node:path";
import semver from "semver";
import { readProjectFile } from "../../collectors/project-files.js";
import { findPackageDir } from "../../detection/project-type.js";
import { finding, type Rule, type RuleContext } from "../../engine/rule.js";
import type { ParsedLog } from "../../parsers/index.js";
import { logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";
import {
  AGP_JDK_REQUIREMENT,
  FOOJAY_GRADLE9,
  GRADLE_START_SCRIPT,
  HERMES_TARBALL_LAYOUT,
  RN_AUTOLINKING_CACHE,
  RN_JDK_REQUIREMENT,
  compareVersions,
} from "./compat.js";

/** First line matching `pattern`, with the match. */
function firstMatch(log: ParsedLog, pattern: RegExp) {
  for (let i = 0; i < log.doc.lines.length; i++) {
    const match = pattern.exec(log.doc.lines[i]!);
    if (match) return { index: i, match };
  }
  return undefined;
}

/** The `> Task :x FAILED` line at or shortly before `index`. */
function failedTaskNear(log: ParsedLog, index: number): string | undefined {
  for (let i = index; i >= Math.max(0, index - 4); i--) {
    const task = /^> Task (:\S+) FAILED/.exec(log.doc.lines[i]!.trim())?.[1];
    if (task) return task;
  }
  return log.gradle.failures.find((f) => f.task)?.task;
}

/** npm package name from a path inside node_modules (either separator). */
function packageFromPath(path: string): string | undefined {
  return /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(path)?.[1]?.replace(/\\/g, "/");
}

function versionEvidence(ctx: RuleContext, keys: string[]): Evidence[] {
  const versions = ctx.project?.versions ?? {};
  return keys
    .filter((k) => versions[k])
    .map((k) => ({ source: "project" as const, detail: `${k}: ${versions[k]}` }));
}

// ---------------------------------------------------------------------------------------------

const JAVA_NOT_FOUND =
  /ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH/;
const JAVA_HOME_INVALID = /ERROR: JAVA_HOME is set to an invalid directory: (.+?)\s*$/;

/** The JDK version this project documents, when React Native or AGP sets it. */
function requiredJdk(ctx: RuleContext): { jdk: number; why: string } | undefined {
  const rn = ctx.project?.versions["react-native"];
  if (rn && semver.valid(rn) && semver.gte(rn, RN_JDK_REQUIREMENT.minReactNative))
    return { jdk: RN_JDK_REQUIREMENT.minJdk, why: `React Native ${rn}` };
  const agp = ctx.project?.versions["android gradle plugin"];
  if (agp && compareVersions(agp, `${AGP_JDK_REQUIREMENT.minAgpMajor}.0`) >= 0)
    return { jdk: AGP_JDK_REQUIREMENT.minJdk, why: `Android Gradle Plugin ${agp}` };
  return undefined;
}

export const javaNotFound: Rule = {
  meta: {
    id: "android.java-not-found",
    title: "gradlew couldn't find a Java installation",
    platforms: ["android"],
    scope: "log",
    trigger:
      'Gradle\'s start script (gradlew / gradlew.bat) prints "ERROR: JAVA_HOME is not set and no \'java\' command could be found in your PATH." or "ERROR: JAVA_HOME is set to an invalid directory: <dir>".',
    evidence:
      "The gradlew error line, the directory it names, and the JDK version the project's React Native or Android Gradle Plugin version needs.",
    versionScope: "All Gradle versions (wrapper start scripts)",
    references: [...GRADLE_START_SCRIPT.sources, RN_JDK_REQUIREMENT.source],
    lastVerified: GRADLE_START_SCRIPT.lastVerified,
    fixtures: [
      "logs/android-gradlew-java-home-not-set.log",
      "logs/android-gradlew-java-home-invalid.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const notFound = firstMatch(log, JAVA_NOT_FOUND);
      const invalid = notFound ? undefined : firstMatch(log, JAVA_HOME_INVALID);
      const hit = notFound ?? invalid;
      if (!hit) continue;
      const dir = invalid?.match[1];
      const need = requiredJdk(ctx);
      const jdk = need
        ? `JDK ${need.jdk}`
        : "the JDK your React Native version documents (JDK 17 for React Native 0.73 and later)";
      out.push(
        finding(this.meta, {
          title: dir
            ? `JAVA_HOME points to ${dir}, which isn't a Java installation`
            : "gradlew couldn't find Java: JAVA_HOME isn't set and java isn't on PATH",
          severity: "error",
          confidence: "high",
          explanation:
            (dir
              ? `gradlew stopped before Gradle started, because JAVA_HOME is set to ${dir} and there's no java executable in it. The JDK at that path was probably uninstalled or upgraded to a version in a different folder.`
              : "gradlew stopped before Gradle started: it needs a Java runtime to launch, and found neither a JAVA_HOME variable nor a java command on PATH in the shell that ran it.") +
            ` Android Studio uses its own bundled JDK, so builds can work there and fail in a terminal or on CI.${need ? ` This project needs JDK ${need.jdk} (${need.why}).` : ""}`,
          evidence: [
            logEvidence(log.doc, {
              start: hit.index,
              end: Math.min(log.doc.lines.length - 1, hit.index + 3),
            }),
            ...(need
              ? [{ source: "project" as const, detail: `${need.why} requires JDK ${need.jdk}` }]
              : []),
          ],
          nextSteps: [
            `Install ${jdk} (the React Native docs use Azul Zulu), or use the JDK bundled with Android Studio (the jbr folder inside the Android Studio installation).`,
            dir
              ? `Point JAVA_HOME at the JDK's home folder (the one that contains bin/java) instead of ${dir}, in your shell profile or the CI job, then open a new terminal.`
              : "Set JAVA_HOME to the JDK's home folder (the one that contains bin/java) in your shell profile or CI job, then open a new terminal.",
            "On CI, install the JDK in the job before the build (for example actions/setup-java with distribution zulu).",
          ],
          verification:
            "`java -version` and `cd android && ./gradlew --version` both print the expected JDK.",
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const MISSING_PROJECT_DIR =
  /Configuring project '(:[^']+)' without an existing directory is not allowed\. The configured projectDirectory '([^']+)' does not exist/;

export const autolinkingStalePath: Rule = {
  meta: {
    id: "android.autolinking-stale-path",
    title: "Gradle includes an autolinked library from a folder that doesn't exist",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Gradle's \"Configuring project ':x' without an existing directory is not allowed. The configured projectDirectory '<dir>' does not exist\" for a directory inside node_modules.",
    evidence:
      "The Gradle error with the project and directory, and with the project, whether the package is installed here and whether the autolinking cache exists.",
    versionScope: "React Native 0.75+ settings plugin (autolinking.json cache)",
    references: RN_AUTOLINKING_CACHE.sources,
    lastVerified: RN_AUTOLINKING_CACHE.lastVerified,
    fixtures: ["logs/rn-issue-autolinking-moved-project.log", "projects/rn088-safe-area-installed"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit = firstMatch(log, MISSING_PROJECT_DIR);
      if (!hit) continue;
      const [, gradleProject, dir] = hit.match;
      const pkg = packageFromPath(dir!);
      if (!pkg) continue;
      const project = ctx.project;
      const installedDir = project ? findPackageDir(project.root, pkg) : undefined;
      const installed = installedDir ? project!.installedVersion(pkg) : undefined;
      const cache = project
        ? readProjectFile(project.root, `${RN_AUTOLINKING_CACHE.cacheDir}/autolinking.json`)
        : undefined;
      const evidence: Evidence[] = [
        logEvidence(
          log.doc,
          { start: hit.index, end: hit.index },
          `Gradle project ${gradleProject} at ${dir}`,
        ),
      ];
      if (project) {
        evidence.push({
          source: "project",
          detail: installedDir
            ? `${pkg}${installed ? `@${installed}` : ""} is installed in this project at ${relative(project.root, installedDir).replace(/\\/g, "/")}`
            : `${pkg} isn't installed in this project's node_modules`,
        });
        if (cache?.ok)
          evidence.push({
            source: "project",
            file: `${RN_AUTOLINKING_CACHE.cacheDir}/autolinking.json`,
            detail: "the autolinking cache exists",
          });
      }
      const stale = project ? installedDir !== undefined : undefined;
      const clear = `Delete ${RN_AUTOLINKING_CACHE.cacheDir} (or all of android/build) and build again, so the settings plugin regenerates autolinking.json with this project's paths.`;
      out.push(
        finding(this.meta, {
          title:
            stale === false
              ? `${pkg} isn't installed, but Gradle's autolinking still includes it`
              : `Autolinking points ${gradleProject} at a folder that doesn't exist${stale ? " (cached path from another location)" : ""}`,
          severity: "error",
          confidence: stale === undefined ? "medium" : "high",
          explanation:
            stale === false
              ? `Gradle was told to include ${gradleProject} from ${dir}, and ${pkg} isn't in this project's node_modules. Dependencies weren't installed (or the install failed), or the package was removed from package.json while the autolinking config still lists it.`
              : `Gradle was told to include ${gradleProject} from ${dir}, which doesn't exist.${stale ? ` ${pkg} is installed in this project, so the library is there, just not at that path.` : ""} React Native's settings plugin caches the autolinking config in ${RN_AUTOLINKING_CACHE.cacheDir}/autolinking.json with absolute paths, and only refreshes it when a lockfile changes. After the project folder is moved, renamed or copied (or node_modules lives somewhere else, as in some monorepos and CI caches), the cache keeps the old paths (react/react-native#59503).` +
                (stale === undefined
                  ? " Without the project files this tool can't tell whether the package is installed; run it with --cwd to check."
                  : ""),
          evidence,
          nextSteps:
            stale === false
              ? [
                  "Install dependencies (`npm install`, `yarn`, `pnpm install` or `bun install`) and build again.",
                  `If ${pkg} should no longer be used, remove it from package.json, reinstall, and delete ${RN_AUTOLINKING_CACHE.cacheDir}.`,
                ]
              : [
                  clear,
                  "If the build runs on CI with a cached android/build folder, exclude that folder from the cache or key the cache on the checkout path.",
                ],
          verification: `\`cd android && ./gradlew help\` configures ${gradleProject} without the error.`,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const CMAKE_CACHE_MISMATCH =
  /CMake Error: The source "([^"]+)" does not match the source "([^"]+)" used to generate cache/;

export const cmakeCacheStale: Rule = {
  meta: {
    id: "android.cmake-cache-stale",
    title: "A CMake build folder was generated for a different source folder",
    platforms: ["android"],
    scope: "log",
    trigger:
      'CMake\'s \'The source "X/CMakeLists.txt" does not match the source "Y/CMakeLists.txt" used to generate cache\' during a Gradle native build.',
    evidence: "The CMake error with both paths and the Gradle task that ran CMake.",
    versionScope:
      "Android native builds with CMake (React Native New Architecture, Hermes source builds)",
    references: [
      "https://github.com/react/react-native/issues/59513",
      "https://cmake.org/cmake/help/latest/manual/cmake.1.html",
    ],
    lastVerified: "2026-11-05",
    fixtures: ["logs/rn-issue-cmake-cache-stale.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit = firstMatch(log, CMAKE_CACHE_MISMATCH);
      if (!hit) continue;
      const [, now, before] = hit.match;
      const task = failedTaskNear(log, hit.index);
      const hermes = /hermes/i.test(`${task ?? ""} ${now} ${before}`);
      const owner = packageFromPath(before!) ?? packageFromPath(now!);
      out.push(
        finding(this.meta, {
          title: `CMake's build folder was generated for ${before}, not ${now}`,
          severity: "error",
          confidence: "high",
          explanation:
            `CMake keeps the source folder in its build folder's cache, and refuses to reuse that build folder for a different source folder${task ? ` (in ${task})` : ""}. The sources moved from ${before} to ${now}, but the old build folder stayed. This happens after the project folder is moved or copied, after a package manager stores packages under a new path (a pnpm store or workspace change), or after an upgrade changes where a library's sources live. Nothing is wrong with the code.` +
            (hermes
              ? " Here it's the Hermes engine, which is only compiled when React Native is built from source."
              : ""),
          evidence: [
            logEvidence(log.doc, {
              start: Math.max(0, hit.index - 1),
              end: Math.min(log.doc.lines.length - 1, hit.index + 3),
            }),
          ],
          nextSteps: [
            `Delete the stale native build folders and build again: android/app/.cxx, android/app/build and android/build${owner ? `, plus node_modules/${owner}/android/.cxx and node_modules/${owner}/android/build` : ""}${hermes ? ", and the hermes-engine build folder (node_modules/react-native/ReactAndroid/hermes-engine/build)" : ""}.`,
            "If the build runs on CI with cached build folders, don't cache .cxx and build folders across checkouts in different paths.",
          ],
          verification: `${task ? `\`cd android && ./gradlew ${task}\`` : "The native build"} configures CMake without the cache error.`,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const HERMES_NO_CMAKELISTS =
  /CMake Error: The source directory "([^"]*sdks[\\/]hermes)" does not appear to contain CMakeLists\.txt/;

export const hermesSourceMissing: Rule = {
  meta: {
    id: "android.hermes-source-missing",
    title: "Hermes sources were unpacked into the wrong folder (React Native source build)",
    platforms: ["android"],
    scope: "log",
    trigger:
      "configureBuildForHermes fails with CMake's 'The source directory \".../sdks/hermes\" does not appear to contain CMakeLists.txt'.",
    evidence: "The CMake error, the failing task, and with the project, the React Native version.",
    versionScope: `React Native source builds before ${HERMES_TARBALL_LAYOUT.fixedIn} (after the facebook/hermes → meta/hermes move)`,
    references: HERMES_TARBALL_LAYOUT.sources,
    lastVerified: HERMES_TARBALL_LAYOUT.lastVerified,
    fixtures: ["logs/rn-issue-hermes-cmakelists-missing.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit = firstMatch(log, HERMES_NO_CMAKELISTS);
      if (!hit) continue;
      const rn = ctx.project?.versions["react-native"];
      const hasFix =
        rn && semver.valid(rn) ? semver.gte(rn, HERMES_TARBALL_LAYOUT.fixedIn) : undefined;
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: Math.max(0, hit.index - 1),
          end: Math.min(log.doc.lines.length - 1, hit.index + 1),
        }),
        ...versionEvidence(ctx, ["react-native", "expo"]),
      ];
      out.push(
        finding(this.meta, {
          title: "Hermes source build: sdks/hermes has no CMakeLists.txt",
          severity: "error",
          confidence: hasFix === true ? "medium" : "high",
          explanation:
            "This build compiles React Native, including Hermes, from source, so it downloads the Hermes sources and unpacks them into react-native/sdks/hermes. Since the Hermes repository moved from facebook/hermes to meta/hermes (2026-10-28), the downloaded archive's top folder is named meta-hermes-<sha>, and React Native's unzipHermes task only flattened a facebook-hermes-<sha> folder, so the sources end up one level too deep and CMake finds nothing (react/react-native#59587). " +
            (hasFix === true
              ? `React Native ${rn} already has the fix (#59589), so the folder is probably left over from an earlier download: delete it and build again.`
              : `It's fixed in ${HERMES_TARBALL_LAYOUT.fixedIn} (react/react-native#59589); ${HERMES_TARBALL_LAYOUT.notFixedIn} doesn't have it.`) +
            " Apps that use React Native's prebuilt Android artifacts don't download Hermes and aren't affected.",
          evidence,
          nextSteps: [
            ...(hasFix === true
              ? []
              : [
                  `Apply the change from react/react-native#59589 to node_modules/react-native/ReactAndroid/hermes-engine/build.gradle.kts with patch-package (unzipHermes strips the archive's top folder whatever its name), or upgrade to React Native ${HERMES_TARBALL_LAYOUT.fixedIn} or later.`,
                  "If you don't need to build React Native from source, turn it off (Expo: remove ios/android buildReactNativeFromSource from expo-build-properties; React Native CLI: remove the includeBuild/dependencySubstitution of ReactAndroid) so the prebuilt artifacts are used.",
                ]),
            "Delete node_modules/react-native/sdks/hermes (and sdks/download) so the next build downloads and unpacks Hermes again.",
          ],
          verification:
            "`configureBuildForHermes` finishes, and node_modules/react-native/sdks/hermes/CMakeLists.txt exists.",
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const R8_DESCRIPTOR =
  /Class content provided for type descriptor (\S+) actually defines class (\S+)/;

export const r8ClassDescriptorMismatch: Rule = {
  meta: {
    id: "android.r8-class-descriptor-mismatch",
    title: "R8 found a class file whose name doesn't match the class inside it",
    platforms: ["android"],
    scope: "log",
    trigger: "R8 'Class content provided for type descriptor X actually defines class Y'.",
    evidence:
      "The R8 error with both class names and the 'origin:' path, with the npm package that owns it.",
    versionScope: "Android Gradle Plugin with R8; case-insensitive file systems (macOS, Windows)",
    references: [
      "https://github.com/expo/expo/issues/51556",
      "https://developer.android.com/build/configure-app-module",
    ],
    lastVerified: "2026-11-05",
    fixtures: ["logs/expo-issue-r8-class-descriptor.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      // The message is sometimes wrapped after the first class name.
      let hit: { index: number; match: RegExpExecArray } | undefined;
      for (let i = 0; i < log.doc.lines.length && !hit; i++) {
        const text = `${log.doc.lines[i]!.trim()} ${log.doc.lines[i + 1]?.trim() ?? ""}`;
        const match = /Class content provided for type descriptor/.test(log.doc.lines[i]!)
          ? R8_DESCRIPTOR.exec(text)
          : null;
        if (match) hit = { index: i, match };
      }
      if (!hit) continue;
      const [, expected, actual] = hit.match;
      // R8 names the jar the class came from ("origin:"), often a library's build output.
      const pkg = log.doc.lines
        .slice(hit.index, hit.index + 6)
        .map(
          (l) =>
            packageFromPath(l) ??
            /^\s*(?:origin:\s*)?((?:@[\w.-]+\/)?[\w.-]+)\/android\/build\//.exec(l)?.[1],
        )
        .find(Boolean);
      const caseOnly = expected!.toLowerCase() === actual!.toLowerCase();
      const pkgOf = (cls: string) => cls.slice(0, cls.lastIndexOf("."));
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: hit.index,
          end: Math.min(log.doc.lines.length - 1, hit.index + 5),
        }),
      ];
      if (pkg)
        evidence.push({
          source: "log",
          file: log.doc.path,
          detail: `The class comes from the npm package ${pkg}`,
        });
      out.push(
        finding(this.meta, {
          title: caseOnly
            ? `${pkg ?? "A library"}: package ${pkgOf(expected!)} and namespace ${pkgOf(actual!)} differ only in letter case`
            : `R8: ${expected} is stored where ${actual} is expected`,
          severity: "error",
          confidence: caseOnly ? "high" : "medium",
          explanation: caseOnly
            ? `R8 read ${expected}'s class file and found ${actual} inside. ${pkg ?? "The library"}'s Gradle namespace (${pkgOf(actual!)}, which names generated classes such as BuildConfig) and its source package (${pkgOf(expected!)}) differ only in letter case. On a case-insensitive file system (the macOS and Windows default) both land in the same folder, so one class file stands in for the other.`
            : `R8 read the class file for ${expected} and found ${actual} inside: two classes map to the same file path, or a jar contains a class under the wrong name.`,
          evidence,
          nextSteps: caseOnly
            ? [
                `Report it to ${pkg ?? "the library"}: its android/build.gradle namespace should use the same casing as its source package (${pkgOf(expected!)}). Check for a newer release that fixes it.`,
                `Until then, change the namespace in ${pkg ? `node_modules/${pkg}/android/build.gradle` : "the library's android/build.gradle"} to ${pkgOf(expected!)} with patch-package, delete its android/build folder, and build again.`,
                "Building on a case-sensitive file system (Linux CI, EAS Build) avoids the collision too.",
              ]
            : [
                "Check which dependencies ship the two classes (the origin path above), and remove the duplicate or align their versions.",
                "Clean the build (`cd android && ./gradlew clean`) in case a stale class file is left over.",
              ],
          verification: "The R8 task completes.",
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const FOOJAY_CLASS = /org[/.]gradle[/.]toolchains[/.]foojay[/.]FoojayToolchainsPlugin/;
const FOOJAY_VERSION =
  /org\.gradle\.toolchains\.foojay-resolver-convention["']\s*\)?\s*\.?\s*version\s*\(?\s*["']([^"']+)["']/;

export const foojayIncompatibleGradle: Rule = {
  meta: {
    id: "android.foojay-gradle9-incompatible",
    title: "foojay-resolver-convention is too old for Gradle 9",
    platforms: ["android"],
    scope: "log",
    trigger:
      "A Gradle failure with org/gradle/toolchains/foojay/FoojayToolchainsPlugin (NoClassDefFoundError or 'Error resolving plugin').",
    evidence:
      "The failure lines, the Gradle version (log or wrapper), and with the project, the foojay-resolver-convention version pinned by @react-native/gradle-plugin or android/settings.gradle.",
    versionScope: `Gradle 9+ with foojay-resolver-convention before ${FOOJAY_GRADLE9.firstGradle9Compatible} (React Native ${FOOJAY_GRADLE9.affectedReactNative})`,
    references: FOOJAY_GRADLE9.sources,
    lastVerified: FOOJAY_GRADLE9.lastVerified,
    fixtures: ["logs/rn-issue-foojay-gradle9.log", "projects/rn083-foojay"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit = firstMatch(log, FOOJAY_CLASS);
      if (!hit) continue;
      const gradle =
        log.doc.lines
          .map(
            (l) =>
              /^(?:Welcome to Gradle|Gradle)\s+(\d+\.\d+(?:\.\d+)?)(?:!|\s*$)/.exec(l.trim())?.[1],
          )
          .find(Boolean) ?? ctx.project?.versions["gradle (wrapper)"];
      const pins: { file: string; line: number; version: string }[] = [];
      if (ctx.project) {
        const root = ctx.project.root;
        const pluginDir = findPackageDir(root, "@react-native/gradle-plugin");
        const files = [
          ...(pluginDir
            ? [`${relative(root, pluginDir).replace(/\\/g, "/")}/settings.gradle.kts`]
            : []),
          "android/settings.gradle",
          "android/settings.gradle.kts",
        ];
        for (const file of files) {
          const read = readProjectFile(root, file);
          if (!read.ok) continue;
          read.text.split(/\r?\n/).forEach((l, i) => {
            const m = FOOJAY_VERSION.exec(l);
            if (m) pins.push({ file, line: i + 1, version: m[1]! });
          });
        }
      }
      const old = pins.filter(
        (p) => compareVersions(p.version, FOOJAY_GRADLE9.firstGradle9Compatible) < 0,
      );
      const inRnPlugin = old.find((p) => p.file.includes("@react-native/gradle-plugin"));
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: Math.max(0, hit.index - 1),
          end: Math.min(log.doc.lines.length - 1, hit.index + 1),
        }),
      ];
      if (gradle) evidence.push({ source: "log", file: log.doc.path, detail: `Gradle ${gradle}` });
      for (const p of pins)
        evidence.push({
          source: "project",
          file: p.file,
          line: p.line,
          detail: `foojay-resolver-convention ${p.version}`,
        });
      evidence.push(...versionEvidence(ctx, ["react-native", "expo"]));
      const gradle9 = gradle
        ? Number.parseInt(gradle, 10) >= FOOJAY_GRADLE9.minGradleMajorNeedingIt
        : undefined;
      out.push(
        finding(this.meta, {
          title: `foojay-resolver-convention${old[0] ? ` ${old[0].version}` : ""} doesn't support Gradle${gradle ? ` ${gradle}` : " 9"}`,
          severity: "error",
          confidence: old.length || gradle9 ? "high" : "medium",
          explanation:
            `Gradle failed while applying the foojay toolchain resolver plugin: its FoojayToolchainsPlugin class can't be loaded. foojay-resolver-convention versions before ${FOOJAY_GRADLE9.firstGradle9Compatible} only support Gradle 7.6 to 8.14.x, and this build runs Gradle${gradle ? ` ${gradle}` : " 9"}.` +
            (inRnPlugin
              ? ` The old version is pinned by React Native's own Gradle plugin (${inRnPlugin.file}), which React Native ${FOOJAY_GRADLE9.affectedReactNative} ship together with a Gradle 9 wrapper; ${FOOJAY_GRADLE9.fixedInReactNative} pins ${FOOJAY_GRADLE9.firstGradle9Compatible}. The reported reproduction clears ~/.gradle/caches first, so it can fail on a clean machine or CI while working on a machine with older Gradle caches (react/react-native#56287).`
              : old[0]
                ? ` ${old[0].file} pins ${old[0].version}.`
                : " Run this tool with --cwd pointing at the project to see which file pins the plugin."),
          evidence,
          nextSteps: [
            ...(inRnPlugin
              ? [
                  `Upgrade React Native to ${FOOJAY_GRADLE9.fixedInReactNative} or later, or until then change the version in ${inRnPlugin.file} to ${FOOJAY_GRADLE9.firstGradle9Compatible} with patch-package.`,
                ]
              : [
                  `Set org.gradle.toolchains.foojay-resolver-convention to ${FOOJAY_GRADLE9.firstGradle9Compatible} or later wherever it's declared (android/settings.gradle, or the settings.gradle.kts of node_modules/@react-native/gradle-plugin).`,
                ]),
            "Don't downgrade Gradle below the wrapper your React Native version ships; the React Native Gradle plugin needs it.",
          ],
          verification: "`cd android && ./gradlew help` gets past settings evaluation.",
        }),
      );
    }
    return out;
  },
};

export const jdkNotFound: Rule = {
  meta: {
    id: "android.jdk-not-found",
    title: "No usable JDK for command-line Android builds",
    platforms: ["android"],
    scope: "project",
    trigger:
      "Project has an android/ folder, and JAVA_HOME points to a directory that doesn't exist, or JAVA_HOME is unset and `java -version` can't be run.",
    evidence:
      "Whether JAVA_HOME is set and exists, and the result of the java probe (names and existence only).",
    versionScope: "All Gradle versions (wrapper start scripts)",
    references: GRADLE_START_SCRIPT.sources,
    lastVerified: GRADLE_START_SCRIPT.lastVerified,
    fixtures: ["projects/rn-cli-clean"],
  },
  run(ctx) {
    const { project, env } = ctx;
    if (!project?.hasAndroid || !env) return [];
    const invalidHome = env.javaHome !== undefined && env.javaHomeExists === false;
    const noJava = env.javaHome === undefined && env.javaProbe === "not-found";
    if (!invalidHome && !noJava) return [];
    const need = requiredJdk(ctx);
    return [
      finding(this.meta, {
        title: invalidHome
          ? "JAVA_HOME points to a directory that doesn't exist"
          : "No JDK found: JAVA_HOME isn't set and java isn't on PATH",
        // Expo projects often build only on EAS, where the local JDK doesn't matter.
        severity: project.kind === "expo" ? "info" : "warning",
        confidence: invalidHome ? "high" : "medium",
        explanation:
          (invalidHome
            ? 'JAVA_HOME is set in this shell, but the directory doesn\'t exist (the JDK was probably uninstalled or upgraded into another folder). `./gradlew` stops with "ERROR: JAVA_HOME is set to an invalid directory" before Gradle starts.'
            : "JAVA_HOME isn't set and `java -version` couldn't be run, so `./gradlew` would stop with \"ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH\".") +
          ` Android Studio uses its bundled JDK, so builds from Android Studio aren't affected.${need ? ` This project needs JDK ${need.jdk} (${need.why}).` : ""}`,
        evidence: [
          {
            source: "environment",
            detail: invalidHome
              ? "JAVA_HOME is set, but the directory doesn't exist"
              : "JAVA_HOME is not set; `java -version` could not be run",
          },
          ...(need
            ? [{ source: "project" as const, detail: `${need.why} requires JDK ${need.jdk}` }]
            : []),
        ],
        nextSteps: [
          `Install ${need ? `JDK ${need.jdk}` : "the JDK your React Native version documents"} (or use Android Studio's bundled JDK, its jbr folder), and set JAVA_HOME to its home folder (the one that contains bin/java).`,
          "Open a new terminal and confirm with `java -version`.",
        ],
        verification: "`cd android && ./gradlew --version` prints the JVM version.",
        limitations: [
          "Only the shell that ran this scan is checked; CI and IDEs can use a different JDK.",
        ],
      }),
    ];
  },
};

export const androidProjectRules: Rule[] = [jdkNotFound];

export const androidSetupRules: Rule[] = [
  javaNotFound,
  autolinkingStalePath,
  cmakeCacheStale,
  hermesSourceMissing,
  r8ClassDescriptorMismatch,
  foojayIncompatibleGradle,
];
