import type { LogDocument } from "../../collectors/build-logs.js";
import { finding, type Rule, type RuleContext } from "../../engine/rule.js";
import type { ParsedLog } from "../../parsers/index.js";
import { findIndex, flatten, logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";
import { readProjectFile } from "../../collectors/project-files.js";
import {
  AGP_JDK_REQUIREMENT,
  GRADLE_MIN_FOR_JAVA,
  PERMGEN_REMOVED,
  compareVersions,
  javaFromClassFileMajor,
} from "./compat.js";

const VERIFIED = "2026-10-14";

function versionEvidence(ctx: RuleContext, keys: string[]): Evidence[] {
  const versions = ctx.project?.versions ?? {};
  return keys
    .filter((k) => versions[k])
    .map((k) => ({ source: "project" as const, detail: `${k}: ${versions[k]}` }));
}

/** Gradle version printed in the log ("Welcome to Gradle 8.13!" / "Gradle 8.13"). */
function gradleVersionFromLog(doc: LogDocument): string | undefined {
  for (const line of doc.lines) {
    const match = /^(?:Welcome to Gradle|Gradle)\s+(\d+\.\d+(?:\.\d+)?)(?:!|\s*$)/.exec(
      line.trim(),
    );
    if (match) return match[1];
  }
  return undefined;
}

function eachLine(
  log: ParsedLog,
  pattern: RegExp,
  limit = 1,
): { index: number; match: RegExpExecArray }[] {
  const found: { index: number; match: RegExpExecArray }[] = [];
  for (let i = 0; i < log.doc.lines.length && found.length < limit; i++) {
    const match = pattern.exec(log.doc.lines[i]!);
    if (match) found.push({ index: i, match });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------

export const dependencyResolution: Rule = {
  meta: {
    id: "android.dependency-resolution",
    title: "Gradle could not resolve Android dependencies",
    platforms: ["android"],
    scope: "log",
    trigger:
      "A Gradle 'What went wrong' section containing 'Could not resolve all … for configuration' or 'Could not find/resolve <group:artifact:version>'.",
    evidence: "The failure section, the unresolved coordinates, and 'Required by' lines.",
    versionScope: "All Gradle versions",
    references: [
      "https://docs.gradle.org/current/userguide/dependency_resolution.html",
      "https://github.com/facebook/react-native/issues/35210",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-dependency-resolution.log", "logs/android-dynamic-react-native.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const failure of log.gradle.failures) {
        const text = failure.details.join("\n");
        if (
          !/Could not resolve all (?:files|dependencies|artifacts|task dependencies) for configuration|Could not (?:find|resolve) [\w.-]+:[\w.-]+/.test(
            text,
          )
        ) {
          continue;
        }
        const configuration = /for configuration '([^']+)'/.exec(text)?.[1];
        const coordinates = new Set<string>();
        for (const line of failure.details) {
          const m = /Could not (?:find|resolve) ([\w.-]+:[\w.-]+(?::[^\s']+)?)/.exec(line);
          if (m) coordinates.add(m[1]!.replace(/\.$/, ""));
        }
        const requiredBy: string[] = [];
        for (let i = 0; i < failure.details.length; i++) {
          if (/^\s*Required by:\s*$/.test(failure.details[i]!)) {
            const next = failure.details[i + 1]?.trim();
            if (next) requiredBy.push(next);
          }
        }
        const network =
          /Could not (?:GET|HEAD) '|Connection (?:timed out|refused|reset)|Received status code (?:4|5)\d\d|Remote host terminated|No cached version .* available for offline mode|PKIX path building failed|Unknown host/i.test(
            text,
          );
        const coords = [...coordinates];
        const dynamic = coords.filter((c) => /:(?:\+|latest\.\w+|[^:]*\+)$/.test(c));
        const rnDynamic = dynamic.some((c) => c.startsWith("com.facebook.react:react-native:"));

        const hypotheses: string[] = [];
        if (network) {
          hypotheses.push(
            "The log shows network or repository errors while downloading, so connectivity, a proxy, or an unavailable repository may be responsible.",
          );
        }
        if (dynamic.length) {
          hypotheses.push(
            `Dynamic version selectors (${dynamic.join(", ")}) resolve to whatever the repositories offer at build time, so a new or removed release can break a previously working build.`,
          );
        }
        if (rnDynamic) {
          hypotheses.push(
            "A dynamic 'com.facebook.react:react-native:+' dependency matches the November 2022 incident where old React Native versions resolved the wrong artifact after React Native started publishing to Maven Central (facebook/react-native#35210).",
          );
        }
        hypotheses.push(
          `${hypotheses.length ? "Otherwise, the" : "The"} requested version may not exist in any configured repository, or the repository that hosts it may not be declared in android/build.gradle or settings.gradle.`,
        );

        const evidence: Evidence[] = [logEvidence(log.doc, failure)];
        for (const c of coords.slice(0, 10))
          evidence.push({ source: "log", file: log.doc.path, detail: `Unresolved: ${c}` });
        for (const r of requiredBy.slice(0, 5))
          evidence.push({ source: "log", file: log.doc.path, detail: `Required by: ${r}` });
        evidence.push(
          ...versionEvidence(ctx, ["react-native", "android gradle plugin", "gradle (wrapper)"]),
        );

        out.push(
          finding(this.meta, {
            title: coords.length
              ? `Gradle could not resolve ${coords.length === 1 ? coords[0] : `${coords.length} dependencies`}`
              : this.meta.title,
            severity: "error",
            confidence: "high",
            explanation: `Gradle failed to resolve dependencies${configuration ? ` for configuration '${configuration}'` : ""}. The log confirms the failure, but not why resolution failed. Possible explanations, in the order the evidence supports them:\n- ${hypotheses.join("\n- ")}`,
            evidence,
            nextSteps: [
              ...(network
                ? [
                    "Check network access, proxy settings, and whether the repository URLs listed in the log respond.",
                  ]
                : []),
              ...(rnDynamic
                ? [
                    "Upgrade to a React Native patch release that contains the fix for facebook/react-native#35210, or pin the react-native dependency to your installed version.",
                  ]
                : []),
              "For each unresolved coordinate, confirm that the version exists in one of the repositories listed under 'Searched in the following locations'.",
              "Run `cd android && ./gradlew :app:dependencies --configuration " +
                (configuration?.split(":").pop() ?? "releaseRuntimeClasspath") +
                "` to see which dependency requests the missing artifact.",
              ...(dynamic.length ? ["Replace dynamic versions ('+') with exact versions."] : []),
            ],
            verification: "Re-run the same Gradle task; it should get past dependency resolution.",
          }),
        );
      }
    }
    return out;
  },
};

export const agpRequiresNewerJdk: Rule = {
  meta: {
    id: "android.agp-requires-newer-jdk",
    title: "Android Gradle Plugin requires a newer JDK",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Log line 'Android Gradle plugin requires Java N to run. You are currently using Java M.'",
    evidence: "The error line with required and current Java versions.",
    versionScope: "Android Gradle Plugin 7.0+",
    references: [
      AGP_JDK_REQUIREMENT.source,
      "https://reactnative.dev/docs/set-up-your-environment",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-agp-jdk.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index, match } of eachLine(
        log,
        /Android Gradle plugin requires Java (\d+) to run\. You are currently using Java (\d+)/,
      )) {
        const [, required, current] = match;
        out.push(
          finding(this.meta, {
            title: `Gradle is running on Java ${current}, but the Android Gradle Plugin requires Java ${required}`,
            severity: "error",
            confidence: "high",
            explanation: `The Android Gradle Plugin stopped the build because the JVM running Gradle is Java ${current}. This build requires Java ${required}. Gradle uses the JDK from org.gradle.java.home, then JAVA_HOME, then the java on PATH. Android Studio uses its own Gradle JDK setting.`,
            evidence: [logEvidence(log.doc, { start: index, end: index + 2 })],
            nextSteps: [
              `Install JDK ${required}. For example, the React Native docs recommend Azul Zulu ${required}.`,
              `Point JAVA_HOME at the JDK ${required} installation, or set org.gradle.java.home in android/gradle.properties.`,
              "If the build runs inside Android Studio, set Settings > Build, Execution, Deployment > Build Tools > Gradle > Gradle JDK.",
              "Stop old daemons with `cd android && ./gradlew --stop`.",
            ],
            verification:
              "`cd android && ./gradlew --version` should report the expected JVM version.",
          }),
        );
      }
    }
    return out;
  },
};

export const unsupportedClassFileVersion: Rule = {
  meta: {
    id: "android.unsupported-class-file-version",
    title: "Gradle is running on a JDK newer than it supports",
    platforms: ["android"],
    scope: "log",
    trigger: "Log line 'Unsupported class file major version N'.",
    evidence:
      "The error line, the derived Java version, and the Gradle version from the log or wrapper.",
    versionScope: "Gradle/Java compatibility table, checked 2026-10-14 (Java 17–27)",
    references: [GRADLE_MIN_FOR_JAVA.source],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-class-file-version.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index, match } of eachLine(log, /Unsupported class file major version (\d+)/)) {
        const java = javaFromClassFileMajor(Number(match[1]));
        const gradle = gradleVersionFromLog(log.doc) ?? ctx.project?.versions["gradle (wrapper)"];
        const minGradle = GRADLE_MIN_FOR_JAVA.table[java];
        const confirmed = gradle && minGradle && compareVersions(gradle, minGradle) < 0;
        const evidence: Evidence[] = [
          logEvidence(
            log.doc,
            { start: index, end: index + 2 },
            `Class file major ${match[1]} = Java ${java}`,
          ),
        ];
        if (gradle)
          evidence.push({
            source: gradleVersionFromLog(log.doc) ? "log" : "project",
            detail: `Gradle ${gradle}`,
          });
        out.push(
          finding(this.meta, {
            title: `Build tooling cannot read Java ${java} class files`,
            severity: "error",
            confidence: confirmed ? "high" : "medium",
            explanation:
              `Something in the build (usually Gradle itself, or a Groovy/Kotlin compiler it runs) was given Java ${java} bytecode and does not support it.` +
              (minGradle
                ? ` Gradle needs version ${minGradle} or later to run on Java ${java} (${GRADLE_MIN_FOR_JAVA.source}).`
                : ` Java ${java} is outside the compatibility table this tool knows about.`) +
              (confirmed
                ? ` This build uses Gradle ${gradle}, which is older than that.`
                : gradle
                  ? ` This build uses Gradle ${gradle}, so the incompatible component may be a plugin rather than Gradle itself.`
                  : " The Gradle version is not visible in the log, so this cannot be confirmed."),
            evidence,
            nextSteps: [
              "Run the build with the JDK version your React Native version documents. Recent versions use JDK 17.",
              minGradle
                ? `If you need Java ${java}, upgrade the Gradle wrapper to ${minGradle} or later and check that your Android Gradle Plugin version supports it.`
                : "Check the Gradle compatibility matrix for your Java version.",
              "Check which JDK Gradle uses with `cd android && ./gradlew --version`.",
            ],
            verification:
              "`./gradlew --version` shows a supported Gradle/JVM pair and the task completes.",
          }),
        );
      }
    }
    return out;
  },
};

export const gradleVersionTooLow: Rule = {
  meta: {
    id: "android.gradle-version-too-low",
    title: "Gradle wrapper is older than the Android Gradle Plugin requires",
    platforms: ["android"],
    scope: "log",
    trigger: "Log line 'Minimum supported Gradle version is X. Current version is Y.'",
    evidence: "The error line with both versions.",
    versionScope: "Android Gradle Plugin 4.0+",
    references: [
      "https://developer.android.com/build/releases/gradle-plugin",
      "https://react-native-community.github.io/upgrade-helper/",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-gradle-too-low.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index, match } of eachLine(
        log,
        /Minimum supported Gradle version is ([\d.]+)\.\s*Current version is ([\d.]+)/,
      )) {
        out.push(
          finding(this.meta, {
            title: `Gradle ${match[2]} is below the required minimum ${match[1]}`,
            severity: "error",
            confidence: "high",
            explanation: `The Android Gradle Plugin used by this build requires Gradle ${match[1]} or later, but the build ran Gradle ${match[2]}.`,
            evidence: [
              logEvidence(log.doc, { start: index, end: index + 1 }),
              ...versionEvidence(ctx, ["gradle (wrapper)", "android gradle plugin"]),
            ],
            nextSteps: [
              `Update distributionUrl in android/gradle/wrapper/gradle-wrapper.properties to Gradle ${match[1]} or later.`,
              "React Native CLI projects: compare the wrapper with the template for your React Native version in the Upgrade Helper.",
              "Expo projects with generated native folders: regenerate them with `npx expo prebuild --clean` rather than editing the wrapper by hand.",
            ],
            verification:
              "`cd android && ./gradlew --version` shows the new Gradle version and the build passes configuration.",
          }),
        );
      }
    }
    return out;
  },
};

export const sdkLocationNotFound: Rule = {
  meta: {
    id: "android.sdk-location-not-found",
    title: "Android SDK location not found",
    platforms: ["android"],
    scope: "log",
    trigger: "Log line 'SDK location not found.'",
    evidence: "The error line, which names the expected local.properties path.",
    versionScope: "All Android Gradle Plugin versions",
    references: [
      "https://developer.android.com/tools/variables",
      "https://reactnative.dev/docs/set-up-your-environment",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-sdk-location.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index } of eachLine(log, /SDK location not found\./)) {
        out.push(
          finding(this.meta, {
            severity: "error",
            confidence: "high",
            explanation:
              "Gradle could not locate the Android SDK. It reads sdk.dir from android/local.properties, then the ANDROID_HOME environment variable. Neither was set for the process that ran the build.",
            evidence: [logEvidence(log.doc, { start: index, end: index + 1 })],
            nextSteps: [
              "Install the Android SDK, for example through Android Studio's SDK Manager.",
              "Set ANDROID_HOME (macOS default: ~/Library/Android/sdk) in the shell or CI environment that runs the build.",
              "Or create android/local.properties with `sdk.dir=/absolute/path/to/Android/sdk`, and don't commit it.",
            ],
            verification: "Re-run the build. It should get past the SDK location check.",
          }),
        );
      }
    }
    return out;
  },
};

export const sdkLicensesNotAccepted: Rule = {
  meta: {
    id: "android.sdk-licenses-not-accepted",
    title: "Android SDK licenses have not been accepted",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Log line 'Failed to install the following Android SDK packages as some licences have not been accepted' or 'You have not accepted the license agreements of the following SDK components'.",
    evidence: "The error line and the listed SDK packages.",
    versionScope: "All Android Gradle Plugin versions",
    references: ["https://developer.android.com/tools/sdkmanager"],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-sdk-licenses.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index } of eachLine(
        log,
        /Failed to install the following Android SDK packages as some licen[cs]es have not been accepted|You have not accepted the license agreements of the following SDK components/,
      )) {
        out.push(
          finding(this.meta, {
            severity: "error",
            confidence: "high",
            explanation:
              "Gradle tried to install missing SDK components automatically. It can't, because their licenses haven't been accepted on this machine.",
            evidence: [logEvidence(log.doc, { start: index, end: index + 6 })],
            nextSteps: [
              "Run `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses` and accept the licenses.",
              "On CI, accept licenses during setup (for example `yes | sdkmanager --licenses`) or use an image with the components preinstalled.",
            ],
            verification:
              "Re-run the build. The listed packages should install without the license error.",
          }),
        );
      }
    }
    return out;
  },
};

export const aarMetadataCheck: Rule = {
  meta: {
    id: "android.aar-metadata-check",
    title: "A dependency requires a newer compileSdk or Android Gradle Plugin",
    platforms: ["android"],
    scope: "log",
    trigger:
      "A Gradle failure (typically :app:check*AarMetadata) stating that a dependency requires compiling against API N or later, or requires Android Gradle Plugin X or higher.",
    evidence: "The AAR metadata failure section and each dependency/requirement pair.",
    versionScope: "Android Gradle Plugin 4.2+ (AAR metadata checks)",
    references: [
      "https://developer.android.com/build/releases/gradle-plugin",
      "https://docs.expo.dev/versions/latest/sdk/build-properties/",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-aar-metadata.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const failure of log.gradle.failures) {
        const text = flatten(log.doc, failure);
        const sdk = [
          ...text.matchAll(
            /Dependency '([^']+)' requires libraries and applications that depend on it to compile against version (\d+) or later of the Android APIs\.\s*(:\S+) is currently compiled against android-(\d+)/g,
          ),
        ];
        const agp = [
          ...text.matchAll(
            /Dependency '([^']+)' requires Android Gradle plugin ([\d.]+[\w.-]*) or higher\.\s*This build currently uses Android Gradle plugin ([\d.]+[\w.-]*)/g,
          ),
        ];
        if (!sdk.length && !agp.length) continue;
        const requiredSdk = Math.max(0, ...sdk.map((m) => Number(m[2])));
        const currentSdk = sdk[0]?.[4];
        const requiredAgp = agp
          .map((m) => m[2]!)
          .sort(compareVersions)
          .pop();
        const currentAgp = agp[0]?.[3];
        const evidence: Evidence[] = [logEvidence(log.doc, failure)];
        for (const m of sdk.slice(0, 8)) {
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `${m[1]} requires compileSdk ${m[2]} (${m[3]} uses ${m[4]})`,
          });
        }
        for (const m of agp.slice(0, 8)) {
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `${m[1]} requires AGP ${m[2]} (build uses ${m[3]})`,
          });
        }
        evidence.push(
          ...versionEvidence(ctx, [
            "compileSdk",
            "targetSdk",
            "android gradle plugin",
            "react-native",
            "expo",
          ]),
        );
        const parts: string[] = [];
        if (sdk.length)
          parts.push(`compile against Android API ${requiredSdk} (currently ${currentSdk})`);
        if (agp.length)
          parts.push(
            `use Android Gradle Plugin ${requiredAgp} or higher (currently ${currentAgp})`,
          );
        out.push(
          finding(this.meta, {
            title: `Dependencies require the app to ${parts.join(" and ")}`,
            severity: "error",
            confidence: "high",
            explanation:
              "The Android Gradle Plugin checks AAR metadata published by dependencies before building. At least one resolved dependency declares a minimum that this app doesn't meet. This often happens when a dependency, or a transitive one, upgrades to a version built for a newer Android API.",
            evidence,
            nextSteps: [
              ...(sdk.length
                ? [
                    `React Native CLI: raise compileSdkVersion to ${requiredSdk} in android/build.gradle (ext block). Expo: set android.compileSdkVersion to ${requiredSdk} with the expo-build-properties config plugin.`,
                    `Check that your Android Gradle Plugin version supports API ${requiredSdk}; newer API levels may require a newer AGP.`,
                  ]
                : []),
              ...(agp.length
                ? [
                    `Upgrade the Android Gradle Plugin to ${requiredAgp} or later, together with a compatible Gradle wrapper.`,
                  ]
                : []),
              "Alternatively, pin the listed dependencies to the last version compatible with your current setup. Run `./gradlew :app:dependencies` to find which library pulls them in.",
            ],
            verification:
              "Re-run the failing task (for example `./gradlew :app:checkReleaseAarMetadata`).",
          }),
        );
      }
    }
    return out;
  },
};

export const duplicateClass: Rule = {
  meta: {
    id: "android.duplicate-class",
    title: "Duplicate classes found in Android dependencies",
    platforms: ["android"],
    scope: "log",
    trigger: "Log lines 'Duplicate class X found in modules A and B'.",
    evidence: "The duplicate class lines and the module pairs.",
    versionScope: "Android Gradle Plugin 3.5+ (checkDuplicateClasses task)",
    references: [
      "https://developer.android.com/jetpack/androidx/migrate",
      "https://developer.android.com/build/dependencies",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-duplicate-class.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hits = eachLine(
        log,
        /Duplicate class (\S+) found in modules? (.+?) and (.+?)\s*$/,
        500,
      );
      if (!hits.length) continue;
      const pairs = new Map<string, number>();
      for (const { match } of hits) {
        const key = `${match[2]!.trim()} <-> ${match[3]!.trim()}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
      const supportVsAndroidx = [...pairs.keys()].some(
        (k) => /com\.android\.support:/.test(k) && /androidx\./.test(k),
      );
      out.push(
        finding(this.meta, {
          title: `${hits.length} duplicate class${hits.length === 1 ? "" : "es"} across ${pairs.size} module pair${pairs.size === 1 ? "" : "s"}`,
          severity: "error",
          confidence: "high",
          explanation:
            "Two dependencies ship the same class, so the build can't produce a single dex." +
            (supportVsAndroidx
              ? " At least one pair mixes the legacy Android Support Library with AndroidX. This usually means a dependency still uses com.android.support artifacts."
              : ""),
          evidence: [
            logEvidence(log.doc, { start: hits[0]!.index, end: hits[0]!.index + 2 }),
            ...[...pairs.entries()].slice(0, 6).map(([k, n]) => ({
              source: "log" as const,
              file: log.doc.path,
              detail: `${n}× ${k}`,
            })),
          ],
          nextSteps: [
            ...(supportVsAndroidx
              ? [
                  "Find the dependency that still uses com.android.support. Upgrade it, or make sure android.useAndroidX=true and android.enableJetifier=true are set in android/gradle.properties.",
                ]
              : []),
            "Run `cd android && ./gradlew :app:dependencies` to find which libraries bring each module in, then exclude or align one of them.",
          ],
          verification:
            "`./gradlew :app:checkReleaseDuplicateClasses` (or the debug variant) succeeds.",
        }),
      );
    }
    return out;
  },
};

export const manifestMergerFailed: Rule = {
  meta: {
    id: "android.manifest-merger-failed",
    title: "Android manifest merger failed",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Log line 'Manifest merger failed', including 'uses-sdk:minSdkVersion N cannot be smaller than version M declared in library'.",
    evidence: "The merger error line and the conflicting attribute or element.",
    versionScope: "All Android Gradle Plugin versions",
    references: [
      "https://developer.android.com/build/manage-manifests",
      "https://developer.android.com/about/versions/12/behavior-changes-12#exported",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-manifest-exported.log", "logs/real-rn087-gradle-manifest-minsdk.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index, match } of eachLine(
        log,
        /Manifest merger failed\s*(?:with multiple errors)?\s*:?\s*(.*)$/,
      )) {
        const end = Math.min(log.doc.lines.length - 1, index + 6);
        const context = log.doc.lines.slice(index, end + 1).join(" ");
        const minSdk =
          /uses-sdk:minSdkVersion (\d+) cannot be smaller than version (\d+) declared in library \[([^\]]+)\]/.exec(
            context,
          );
        if (minSdk) {
          const [, appMin, libMin, library] = minSdk;
          const coordinate = library!.split(/\s+/)[0]!;
          const evidence: Evidence[] = [logEvidence(log.doc, { start: index, end })];
          const declared = ctx.project?.versions["minSdk"];
          if (declared)
            evidence.push({
              source: "project",
              file: "android/build.gradle",
              detail: `minSdk: ${declared}`,
            });
          out.push(
            finding(this.meta, {
              title: `${coordinate} needs minSdk ${libMin}, but the app's minSdk is ${appMin}`,
              severity: "error",
              confidence: "high",
              explanation: `The library ${coordinate} declares minSdkVersion ${libMin} in its manifest. The app declares ${appMin}, so it would install on devices the library doesn't support, and the manifest merger stops the build.`,
              evidence,
              nextSteps: [
                ctx.project?.kind === "expo"
                  ? `Raise the minimum SDK to ${libMin} with expo-build-properties (\`android.minSdkVersion\` in app config), then rebuild.`
                  : `Raise minSdkVersion to ${libMin} in android/build.gradle (the \`minSdkVersion\` value in \`buildscript.ext\`). This drops support for Android versions below API ${libMin}.`,
                `Or use a version of ${coordinate.split(":").slice(0, 2).join(":")} (or of the package that pulls it in) that supports minSdk ${appMin}. \`cd android && ./gradlew :app:dependencies\` shows which package requires it.`,
                "Only use tools:overrideLibrary if every call into the library is guarded by a runtime API-level check. Otherwise the app crashes on older devices.",
              ],
              verification:
                "`./gradlew :app:processDebugMainManifest` (or the release variant) succeeds.",
            }),
          );
          continue;
        }
        const exported = /android:exported/.test(context);
        const conflict =
          /Attribute ([\w@:.-]+) value=\(([^)]*)\) from .+? is also present at (.+?) value=\(([^)]*)\)/.exec(
            context,
          );
        out.push(
          finding(this.meta, {
            title: exported
              ? "Manifest merger failed: a component is missing android:exported"
              : conflict
                ? `Manifest merger failed: conflicting ${conflict[1]}`
                : this.meta.title,
            severity: "error",
            confidence: exported || conflict ? "high" : "medium",
            explanation: exported
              ? "Apps targeting Android 12 (API 31) or higher must set android:exported explicitly on every activity, service, or receiver that has an intent filter. A manifest in the app or a library doesn't."
              : conflict
                ? `Two manifests set ${conflict[1]} to different values ('${conflict[2]}' and '${conflict[4]}'), and nothing tells the merger which one wins.`
                : `The Android manifest merger reported: ${match[1] || "see excerpt"}.`,
            evidence: [logEvidence(log.doc, { start: index, end })],
            nextSteps: exported
              ? [
                  "Find the component without android:exported in the merged manifest (app/build/intermediates/merged_manifests) or the merger report.",
                  'If it comes from a library, upgrade that library. If it\'s in your manifest, add android:exported="true" or "false".',
                ]
              : [
                  "Open the merger report (app/build/outputs/logs/manifest-merger-*-report.txt) to see where each value comes from.",
                  "Resolve the conflict with tools:replace or tools:remove in android/app/src/main/AndroidManifest.xml, or align the library versions.",
                ],
            verification:
              "`./gradlew :app:processReleaseMainManifest` (or the debug variant) succeeds.",
          }),
        );
      }
    }
    return out;
  },
};

export const nativeMinSdkBelowLibrary: Rule = {
  meta: {
    id: "android.native-min-sdk-below-library",
    title: "minSdkVersion is lower than a native (prefab) library was built for",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Log line '[CXX1214] ... User has minSdkVersion N but library was built for M [//package/module]', printed when a CMake configure task links a prefab native library built for a higher API level.",
    evidence: "The CXX1214 line, the two API levels, the library, and the declared minSdk.",
    versionScope:
      "Android Gradle Plugin with prefab native dependencies (React Native New Architecture, Expo modules)",
    references: [
      "https://developer.android.com/ndk/guides/sdk-versions",
      "https://developer.android.com/build/native-dependencies",
      "https://docs.expo.dev/versions/latest/sdk/build-properties/",
    ],
    lastVerified: "2026-10-19",
    fixtures: ["logs/real-rn087-gradle-cxx-minsdk.log", "logs/real-expo58-gradle-cxx-minsdk.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { index, match } of eachLine(
        log,
        /\[CXX1214\]\s+(\S+)\s+(\S+)\s*:\s*User has minSdkVersion (\d+) but library was built for (\d+) \[([^\]]+)\]/,
      )) {
        const [, cmakeLists, variant, appMin, libMin, library] = match;
        // Prefab names libraries "//<package>/<module>", e.g. //ReactAndroid/hermestooling.
        const prefab = /^\/\/([^/]+)\/(.+)$/.exec(library!);
        const libraryName = prefab ? `${prefab[2]} from the prefab package ${prefab[1]}` : library!;
        const consumer = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(cmakeLists!)?.[1];
        const task = /configureCMake\w*\[[^\]]+\]/.exec(
          log.doc.lines.slice(Math.max(0, index - 3), index + 1).join(" "),
        )?.[0];
        const evidence: Evidence[] = [
          logEvidence(
            log.doc,
            { start: index, end: index },
            `minSdkVersion ${appMin}; library built for ${libMin}; ${variant}`,
          ),
          ...versionEvidence(ctx, ["minSdk"]),
        ];
        const expo = ctx.project?.kind === "expo";
        out.push(
          finding(this.meta, {
            title: `minSdkVersion ${appMin} is lower than ${library} was built for (${libMin})`,
            severity: "error",
            confidence: "high",
            explanation:
              `The native library ${libraryName} was built for Android API ${libMin}, but the app's minSdkVersion is ${appMin}. ` +
              `The CMake configure step${task ? ` (${task})` : ""}${consumer ? ` in ${consumer}` : ""} refuses to link it, because native code built for a newer API level isn't guaranteed to load on older Android versions. ` +
              "This is a configuration mismatch, not a compile error in your code.",
            evidence,
            nextSteps: [
              expo
                ? `Set \`android.minSdkVersion\` to at least ${libMin} in the expo-build-properties plugin options in your app config (or remove the override to use the SDK default), then run \`npx expo prebuild --clean\`.`
                : `Raise minSdkVersion to at least ${libMin} in android/build.gradle (the \`minSdkVersion\` value in \`buildscript.ext\`). This drops support for Android versions below API ${libMin}.`,
              "If the lower value was set on purpose, check the minimum Android version your React Native or Expo SDK version supports. A native library can't be made to run below the API level it was built for.",
            ],
            verification: expo
              ? "`npx expo prebuild --clean` and then `cd android && ./gradlew assembleRelease` get past the configureCMake tasks."
              : "`cd android && ./gradlew assembleRelease` gets past the configureCMake tasks.",
          }),
        );
      }
    }
    return out;
  },
};

export const jsBundleTaskFailed: Rule = {
  meta: {
    id: "android.js-bundle-task-failed",
    title: "The JavaScript bundling task failed during the Android build",
    platforms: ["android", "javascript"],
    scope: "log",
    trigger: "A Gradle failure for task createBundle<Variant>JsAndAssets.",
    evidence: "The failed task and, when present, the bundler output printed by that task.",
    versionScope: "React Native Gradle plugin (all versions)",
    references: [
      "https://reactnative.dev/docs/signed-apk-android",
      "https://metrobundler.dev/docs/troubleshooting",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/android-bundle-unable-to-resolve.log", "logs/android-bundle-no-detail.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const failure = log.gradle.failures.find(
        (f) => f.task && /createBundle\w*JsAndAssets/.test(f.task),
      );
      if (!failure) continue;
      const metroErrors = log.metro.events.filter((e) => e.kind !== "bundling-failed");
      const evidence: Evidence[] = [
        logEvidence(log.doc, { start: failure.start, end: failure.start + 3 }),
      ];
      if (!metroErrors.length) {
        // Show the output printed by the bundle task so the primary error is visible.
        const taskName = failure.task!.split(":").pop()!;
        const taskStart = findIndex(log.doc, new RegExp(`^> Task :[\\w:-]*${taskName}\\b`));
        if (taskStart >= 0) {
          let end = taskStart + 1;
          while (
            end < log.doc.lines.length &&
            end < taskStart + 40 &&
            !/^(?:> Task |FAILURE:|\* What went wrong)/.test(log.doc.lines[end]!)
          )
            end++;
          if (end > taskStart + 1)
            evidence.push(
              logEvidence(
                log.doc,
                { start: taskStart, end: end - 1 },
                "Output of the bundling task",
              ),
            );
        }
      }
      out.push(
        finding(this.meta, {
          title: metroErrors.length
            ? "JavaScript bundling failed; the Metro error is reported separately"
            : this.meta.title,
          severity: "error",
          confidence: metroErrors.length ? "high" : "medium",
          explanation: metroErrors.length
            ? `Gradle task ${failure.task} failed because Metro couldn't build the JavaScript bundle. The primary error is the Metro finding from line ${logEvidence(log.doc, metroErrors[0]!).line} of this log. The Gradle failure is only the outer symptom.`
            : `Gradle task ${failure.task} failed while bundling JavaScript, but the log doesn't contain a recognized Metro error. The primary error is usually printed just before the task fails. The excerpt shows that output when it's present.`,
          evidence,
          nextSteps: metroErrors.length
            ? ["Fix the Metro error reported in this report first, then re-run the build."]
            : [
                "Reproduce the bundling step directly, for example `npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/index.android.bundle`, or `npx expo export --platform android` for Expo projects.",
                "Run the Gradle task with `--info` so the full bundler output is included, and analyze that log again.",
              ],
          verification: "The bundling command completes and the Gradle task succeeds.",
        }),
      );
    }
    return out;
  },
};

// Kotlin 2: `e: file:///path/File.kt:12:5 message`; Kotlin 1: `e: /path/File.kt: (12, 5): message`.
const KOTLIN_ERROR =
  /^e:\s+(?:file:\/\/)?(.+?\.kts?)(?::(\d+):(\d+)\s+|:\s+\((\d+),\s*(\d+)\):\s+)(.+)$/;
// javac: `/path/File.java:12: error: message`
const JAVA_ERROR = /^(.+?\.java):(\d+):\s+error:\s+(.+)$/;

interface SourceError {
  index: number;
  language: "Kotlin" | "Java";
  file: string;
  line: string;
  column?: string;
  message: string;
}

/** The npm package that owns a path inside node_modules (`node_modules/@scope/pkg/android/...`). */
function nodeModulesPackage(path: string): string | undefined {
  const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(path);
  return match?.[1]?.replace(/\\/g, "/");
}

/** "Kotlin", "Java", or "Kotlin and Java", depending on which compilers reported errors. */
function languages(errors: SourceError[]): string {
  const set = new Set(errors.map((e) => e.language));
  return set.size > 1 ? "Kotlin and Java" : [...set][0]!;
}

export const androidCompileError: Rule = {
  meta: {
    id: "android.compile-error",
    title: "Kotlin or Java compilation failed",
    platforms: ["android"],
    scope: "log",
    trigger:
      "A Gradle log with Kotlin compiler errors ('e: <file>:<line>:<col> <message>', Kotlin 1 and 2 formats) or javac errors ('<file>.java:<line>: error: <message>').",
    evidence:
      "The first compiler errors with file and position, the owning npm package when the file is in node_modules, and the installed versions.",
    versionScope: "Kotlin 1.x and 2.x compiler output; javac (all versions)",
    references: [
      "https://kotlinlang.org/docs/gradle-compiler-options.html",
      "https://reactnative.dev/docs/upgrading",
    ],
    lastVerified: "2026-10-15",
    fixtures: [
      "logs/real-rn087-gradle-kotlin-error.log",
      "logs/real-rn087-gradle-java-error.log",
      "logs/android-kotlin-library-error.log",
      "logs/android-kotlin-app-error.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      if (!log.gradle.detected) continue;
      const errors: SourceError[] = [];
      const seen = new Set<string>();
      log.doc.lines.forEach((raw, index) => {
        const line = raw.trim();
        const kt = KOTLIN_ERROR.exec(line);
        const java = kt ? undefined : JAVA_ERROR.exec(line);
        const error: SourceError | undefined = kt
          ? {
              index,
              language: "Kotlin",
              file: kt[1]!,
              line: kt[2] ?? kt[4]!,
              column: kt[3] ?? kt[5]!,
              message: kt[6]!.trim(),
            }
          : java
            ? { index, language: "Java", file: java[1]!, line: java[2]!, message: java[3]!.trim() }
            : undefined;
        if (!error) return;
        const key = `${error.file}:${error.line}:${error.message}`;
        if (seen.has(key)) return;
        seen.add(key);
        errors.push(error);
      });
      if (!errors.length) continue;
      const first = errors[0]!;
      const name = first.file.split(/[\\/]/).pop()!;
      const position = `${first.line}${first.column ? `:${first.column}` : ""}`;
      const pkg = nodeModulesPackage(first.file);
      const installed = pkg ? ctx.project?.installedVersion(pkg) : undefined;
      const rn = ctx.project?.versions["react-native"];
      const task = log.gradle.failures.find((f) =>
        /compile\w*(?:Kotlin|JavaWithJavac)/.test(f.task ?? ""),
      )?.task;
      const evidence: Evidence[] = errors
        .slice(0, 5)
        .map((e) =>
          logEvidence(
            log.doc,
            { start: e.index, end: e.index + (e.language === "Java" ? 4 : 0) },
            `${e.file}:${e.line}${e.column ? `:${e.column}` : ""}`,
          ),
        );
      if (pkg)
        evidence.push({
          source: "project",
          detail: `${name} belongs to the npm package ${pkg}${installed ? `@${installed}` : ""}${rn ? `; react-native ${rn}` : ""}`,
        });
      out.push(
        finding(this.meta, {
          title: pkg
            ? `${first.language} compile error in ${pkg}: ${first.message.slice(0, 100)}`
            : `${first.language} compile error in ${name}:${position}: ${first.message.slice(0, 100)}`,
          severity: "error",
          confidence: "high",
          explanation:
            `The ${languages(errors)} compiler reported ${errors.length} error${errors.length === 1 ? "" : "s"}${task ? `, so ${task} failed` : ""}. The first is in ${first.file} at ${position}: ${first.message}` +
            (pkg
              ? ` The file belongs to the npm package ${pkg}${installed ? ` (${installed})` : ""}, not to your app code. A library that doesn't compile usually doesn't support the installed React Native${rn ? ` (${rn})` : ""}, Kotlin, or Android Gradle Plugin version.`
              : ""),
          evidence,
          nextSteps: pkg
            ? [
                `Check which ${pkg} version supports React Native${rn ? ` ${rn}` : ""} (its changelog, README compatibility table, or issues for this error message), and upgrade or downgrade it.`,
                "If you patched native code in node_modules (patch-package), check that the patch still applies to the installed version.",
                "Don't edit files in node_modules directly. Changes are lost on the next install.",
              ]
            : [
                `Open ${first.file} at ${position} and fix the reported error.`,
                "If the error appeared after an upgrade, compare the file with the React Native Upgrade Helper diff for your versions.",
              ],
          verification: `\`cd android && ./gradlew ${task ?? ":app:compileDebugKotlin"}\` succeeds.`,
        }),
      );
    }
    return out;
  },
};

export const jvmOptionUnrecognized: Rule = {
  meta: {
    id: "android.jvm-option-unrecognized",
    title: "The JVM rejected an option from the Gradle configuration",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Log line 'Unrecognized VM option 'X'' or 'Unrecognized option: X' together with 'Could not create the Java Virtual Machine'.",
    evidence:
      "The rejected option, the java command from the Gradle daemon command line when present, and the android/gradle.properties line that sets it.",
    versionScope: `All Gradle versions; PermGen options (${PERMGEN_REMOVED.options.join(", ")}) are obsolete since JDK ${PERMGEN_REMOVED.removedInJava}`,
    references: [
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:configuring_jvm_memory",
      PERMGEN_REMOVED.source,
    ],
    lastVerified: PERMGEN_REMOVED.lastVerified,
    fixtures: ["logs/real-gradle93-jvm-maxpermsize.log", "projects/rn-cli-old-permgen"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const index = log.doc.lines.findIndex((l) =>
        /Unrecognized VM option '[^']+'|Unrecognized option: -\S+/.test(l),
      );
      if (index < 0) continue;
      // Other tools also print "Unrecognized option"; require the JVM's own startup failure.
      if (!log.doc.lines.some((l) => /Could not create the Java Virtual Machine/.test(l))) continue;
      const line = log.doc.lines[index]!;
      const raw =
        /Unrecognized VM option '([^']+)'/.exec(line)?.[1] ??
        /Unrecognized option: (-\S+)/.exec(line)![1]!;
      const flag = /Unrecognized VM option/.test(line) ? `-XX:${raw}` : raw;
      const optionName = raw.replace(/^[+-]/, "").split("=")[0]!;
      const permgen = PERMGEN_REMOVED.options.includes(optionName);
      const java = log.doc.lines
        .map((l) => /Process command line:\s+(\S+\/bin\/java)\b/.exec(l)?.[1])
        .find(Boolean);
      const evidence: Evidence[] = [
        logEvidence(log.doc, { start: index, end: Math.min(log.doc.lines.length - 1, index + 2) }),
      ];
      if (java)
        evidence.push({
          source: "log",
          file: log.doc.path,
          detail: `Gradle started the daemon with ${java}`,
        });
      let source: string | undefined;
      if (ctx.project) {
        const props = readProjectFile(ctx.project.root, "android/gradle.properties");
        if (props.ok) {
          const lines = props.text.split(/\r?\n/);
          const at = lines.findIndex((l) => !/^\s*#/.test(l) && l.includes(flag.split("=")[0]!));
          if (at >= 0) {
            evidence.push({
              source: "project",
              file: "android/gradle.properties",
              line: at + 1,
              excerpt: lines[at]!.trim(),
            });
            source = `org.gradle.jvmargs in android/gradle.properties (line ${at + 1})`;
          }
        }
      }
      out.push(
        finding(this.meta, {
          title: `The JVM doesn't accept ${flag}${permgen ? " (removed in JDK 8)" : ""}`,
          severity: "error",
          confidence: "high",
          explanation:
            `Gradle couldn't start its daemon because the JVM rejected the option ${flag}, ${source ? `set by ${source}` : "set by org.gradle.jvmargs (android/gradle.properties or ~/.gradle/gradle.properties), GRADLE_OPTS, or JAVA_OPTS"}.` +
            (permgen
              ? ` JDK ${PERMGEN_REMOVED.removedInJava} removed the permanent generation, so ${optionName} has no effect, and newer JDKs refuse to start with it. Old React Native templates set it by default.`
              : " This JVM version doesn't support the option. It was probably removed from the JDK or is misspelled."),
          evidence,
          nextSteps: [
            permgen
              ? `Remove ${flag} from org.gradle.jvmargs in android/gradle.properties. If you need a metadata limit, use -XX:MaxMetaspaceSize instead.`
              : `Remove or replace ${flag} in org.gradle.jvmargs (android/gradle.properties), GRADLE_OPTS, or JAVA_OPTS.`,
            "Run `cd android && ./gradlew --stop` so no daemon started with the old options is reused.",
          ],
          verification: "`cd android && ./gradlew help` starts the daemon and succeeds.",
        }),
      );
    }
    return out;
  },
};

export const androidLogRules: Rule[] = [
  dependencyResolution,
  agpRequiresNewerJdk,
  unsupportedClassFileVersion,
  gradleVersionTooLow,
  sdkLocationNotFound,
  sdkLicensesNotAccepted,
  aarMetadataCheck,
  duplicateClass,
  manifestMergerFailed,
  nativeMinSdkBelowLibrary,
  jsBundleTaskFailed,
  androidCompileError,
  jvmOptionUnrecognized,
];
