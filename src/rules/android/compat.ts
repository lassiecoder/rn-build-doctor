/**
 * Version-sensitive data. Every table records its source and the date it was checked; update both
 * together. Do not add rows from memory.
 */

/** Minimum Gradle version that can run on each Java major version. */
export const GRADLE_MIN_FOR_JAVA = {
  source: "https://docs.gradle.org/current/userguide/compatibility.html",
  lastVerified: "2026-10-14",
  table: {
    17: "7.3",
    18: "7.5",
    19: "7.6",
    20: "8.3",
    21: "8.5",
    22: "8.8",
    23: "8.10",
    24: "8.14",
    25: "9.1.0",
    26: "9.4.0",
    27: "9.8.0",
  } as Record<number, string>,
};

/** Android Gradle Plugin 8.0 and later require JDK 17. */
export const AGP_JDK_REQUIREMENT = {
  source: "https://developer.android.com/build/jdks",
  lastVerified: "2026-10-14",
  minAgpMajor: 8,
  minJdk: 17,
};

/** React Native 0.73 and later document JDK 17 as the required version. */
export const RN_JDK_REQUIREMENT = {
  source: "https://reactnative.dev/docs/set-up-your-environment",
  lastVerified: "2026-10-14",
  minReactNative: "0.73.0",
  minJdk: 17,
};

/** Java class file major version to Java release (major 61 = Java 17). */
export function javaFromClassFileMajor(major: number): number {
  return major - 44;
}

/** Compares dotted versions numerically ("8.10" > "8.9"). Non-numeric suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * JDK 8 removed the permanent generation and made its command-line flags obsolete. Old React Native
 * templates set `-XX:MaxPermSize` in org.gradle.jvmargs; JDK 17 rejects it with "Unrecognized VM
 * option" (observed with OpenJDK 17.0.20 and Gradle 9.3.1 on 2026-10-15).
 */
export const PERMGEN_REMOVED = {
  source: "https://openjdk.org/jeps/122",
  lastVerified: "2026-10-15",
  removedInJava: 8,
  options: ["MaxPermSize", "PermSize"],
};

/**
 * AGP 9 applies Kotlin itself ("built-in Kotlin") and uses a new DSL. The org.jetbrains.kotlin.android
 * plugin is incompatible with both, and the opt-out flags go away in AGP 10. The React Native 0.87
 * template and the Expo SDK 58 template both set the two opt-out flags. Observed with AGP 9.2.1 and
 * Gradle 9.4.1 on 2026-10-20: removing builtInKotlin=false gives "Cannot add extension with name
 * 'kotlin'", removing only newDsl=false gives a ClassCastException to BaseExtension.
 */
export const AGP_BUILT_IN_KOTLIN = {
  source: "https://developer.android.com/build/migrate-to-built-in-kotlin",
  templateSources: [
    "https://github.com/react-native-community/template/blob/0.87-stable/template/android/gradle.properties",
    "https://github.com/expo/expo/blob/sdk-58/templates/expo-template-bare-minimum/android/gradle.properties",
  ],
  lastVerified: "2026-10-20",
  introducedInAgpMajor: 9,
  optOutRemovedInAgpMajor: 10,
  optOutFlags: ["android.builtInKotlin=false", "android.newDsl=false"],
};

/**
 * Cleartext (http://) traffic is blocked by default for apps targeting API 28+. The React Native
 * Gradle plugin sets the `usesCleartextTraffic` manifest placeholder to true for debug and false for
 * release (AgpConfiguratorUtils.kt, checked in React Native 0.87.0). The Expo template allows it only
 * in src/debug/AndroidManifest.xml. OkHttp, which React Native's networking uses, reports the block as
 * "CLEARTEXT communication to <host> not permitted by network security policy", but React Native
 * passes only "Network request failed" to JavaScript (observed in a React Native 0.87.0 release
 * build on an Android 14 emulator on 2026-10-20; the same build succeeded once cleartext was allowed).
 */
export const CLEARTEXT_DEFAULTS = {
  sources: [
    "https://developer.android.com/guide/topics/manifest/application-element",
    "https://developer.android.com/privacy-and-security/security-config",
    "https://github.com/square/okhttp/blob/parent-4.12.0/okhttp/src/main/kotlin/okhttp3/internal/connection/RealConnection.kt",
    "https://docs.expo.dev/versions/latest/sdk/build-properties/",
  ],
  lastVerified: "2026-10-20",
  blockedByDefaultFromTargetSdk: 28,
};

/**
 * Ninja before 1.12.0 can't open paths longer than 260 characters on Windows, which New Architecture
 * C++ builds exceed in deep project folders. The Android SDK's CMake 3.22.1 package bundles ninja
 * 1.10.2 (checked locally on 2026-10-20). Ninja 1.12 also needs Windows long paths enabled.
 */
export const NINJA_LONG_PATHS = {
  sources: [
    "https://github.com/ninja-build/ninja/releases/tag/v1.12.0",
    "https://github.com/ninja-build/ninja/issues/1900",
    "https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation",
    "https://github.com/expo/expo/issues/36274",
  ],
  lastVerified: "2026-10-20",
  fixedInNinja: "1.12.0",
  sdkCmakeNinja: { "3.22.1": "1.10.2" } as Record<string, string>,
};

/**
 * AGP 9.0 changed `android.dependency.useConstraints` from true to false: AGP no longer copies
 * runtime-classpath versions into the compile classpath as constraints. A dependency declared
 * without a version, whose version used to come only from another dependency's runtime scope, then
 * fails with "Could not find group:artifact:." (empty version). Setting the property to true restores
 * the AGP 8.13 behavior. Reproduced with AGP 9.2.1 and Gradle 9.4.1 on 2026-10-23: the failure, and
 * that both the property and an explicit version fix it.
 */
export const AGP_DEPENDENCY_CONSTRAINTS = {
  sources: [
    "https://developer.android.com/build/releases/agp-9-0-0-release-notes",
    "https://github.com/orbital-systems/react-native-esp-idf-provisioning/issues/144",
  ],
  lastVerified: "2026-10-23",
  changedInAgpMajor: 9,
  property: "android.dependency.useConstraints",
};

/**
 * React Native autolinking names a library's Gradle project after its npm package: characters
 * ~*!'() become "_", and a scope prefix "@scope/" becomes "scope_" (`nameCleansed` in
 * ModelAutolinkingDependenciesJson.kt; checked in @react-native/gradle-plugin 0.86.2 and on main,
 * 2026-10-23). So `@amplitude/experiment-react-native-client` builds as
 * `:amplitude_experiment-react-native-client`.
 */
export const RN_GRADLE_PROJECT_NAMES = {
  source:
    "https://github.com/facebook/react-native/blob/main/packages/gradle-plugin/shared/src/main/kotlin/com/facebook/react/model/ModelAutolinkingDependenciesJson.kt",
  lastVerified: "2026-10-23",
};

/** npm package names that autolinking could have turned into this Gradle project name. */
export function packageCandidatesForGradleProject(project: string): string[] {
  const name = project.replace(/^:/, "");
  const candidates: string[] = [];
  const scoped = /^([\w.-]+?)_(.+)$/.exec(name);
  if (scoped) candidates.push(`@${scoped[1]}/${scoped[2]}`);
  candidates.push(name);
  return candidates;
}

/**
 * AGP 9.0 rejects getDefaultProguardFile('proguard-android.txt'), because that file contains
 * -dontoptimize; only proguard-android-optimize.txt is supported. The build fails while evaluating
 * the module's build.gradle. Reproduced on 2026-10-25 with Gradle 9.4.1: AGP 9.2.1 fails, AGP 8.12.0
 * accepts the same build file, proguard-android-optimize.txt fixes it, and
 * android.r8.proguardAndroidTxt.disallowed=false also lets the build pass (AGP 9.2.1 warns that the
 * option is deprecated).
 */
export const AGP_PROGUARD_ANDROID_TXT = {
  sources: [
    "https://developer.android.com/build/releases/agp-9-0-0-release-notes",
    "https://github.com/126punith/react-native-pdf-jsi/issues/40",
  ],
  lastVerified: "2026-10-25",
  rejectedFromAgpMajor: 9,
  replacement: "proguard-android-optimize.txt",
  optOutProperty: "android.r8.proguardAndroidTxt.disallowed=false",
};

/**
 * A Groovy build script that passes a null name to a project property lookup, typically
 * `safeExtGet(compileSdkVersion, 31)` with the name unquoted, fails with "Parameter specified as
 * non-null is null: method …onGradlePropertyAccess, parameter propertyName". The script stops at
 * that line, so compileSdk is never set and AGP then reports that the project "does not specify
 * compileSdk". Reproduced on 2026-10-25 with Gradle 9.4.1 and both AGP 8.12.0 and 9.2.1, with and
 * without the configuration cache; quoting the names fixes it. Older Gradle versions weren't tested.
 */
export const GRADLE_NULL_PROPERTY_NAME = {
  sources: [
    "https://github.com/JuanSeBestia/react-native-wifi-reborn/issues/456",
    "https://github.com/JuanSeBestia/react-native-wifi-reborn/pull/453",
  ],
  lastVerified: "2026-10-25",
  observedWithGradle: "9.4.1",
};

/**
 * Kotlin version embedded in each Gradle release (Gradle compatibility matrix, "Embedded Kotlin
 * version", checked on 2026-10-25 against the Gradle 9.8.2 docs). Build logic compiled by an older
 * Kotlin compiler can't read classes from a newer embedded Kotlin: a compiler reads binaries of the
 * next language release at most ("1.9 can understand most binaries from 2.0, but not 2.1"). The
 * error was reproduced on 2026-10-25 with Kotlin 2.1.20 reading a class with 2.3.0 metadata.
 */
export const GRADLE_EMBEDDED_KOTLIN = {
  sources: [
    "https://docs.gradle.org/current/userguide/compatibility.html",
    "https://kotlinlang.org/docs/kotlin-evolution-principles.html",
    "https://github.com/expo/expo/issues/49550",
  ],
  lastVerified: "2026-10-25",
  /** [minimum Gradle version, embedded Kotlin version], oldest first. */
  table: [
    ["9.0.0", "2.2.0"],
    ["9.2.0", "2.2.20"],
    ["9.3.0", "2.2.21"],
    ["9.4.0", "2.3.0"],
    ["9.5.0", "2.3.20"],
    ["9.6.0", "2.3.21"],
    ["9.7.0", "2.4.0"],
    ["9.8.0", "2.4.10"],
  ] as [string, string][],
};

/** The Kotlin version embedded in a Gradle version, when the table covers it. */
export function embeddedKotlinFor(gradle: string): string | undefined {
  let found: string | undefined;
  for (const [min, kotlin] of GRADLE_EMBEDDED_KOTLIN.table)
    if (compareVersions(gradle, min) >= 0) found = kotlin;
  return found;
}

/** The newest Gradle version in the table whose embedded Kotlin is at most `maxKotlin` (x.y). */
export function newestGradleEmbeddingAtMost(maxKotlin: string): string | undefined {
  const [major, minor] = maxKotlin.split(".").map(Number);
  let found: string | undefined;
  for (const [min, kotlin] of GRADLE_EMBEDDED_KOTLIN.table) {
    const [kMajor, kMinor] = kotlin.split(".").map(Number);
    if (kMajor! < major! || (kMajor === major && kMinor! <= minor!)) found = min;
  }
  return found;
}

/**
 * R8 keeps a class that's referenced but removes a constructor nothing calls directly, so a
 * library that creates the class by reflection crashes in minified release builds
 * (NoSuchMethodException: X.<init>, or Room's "Failed to create an instance of class X").
 * Reproduced on 2026-10-25 with AGP 9.2.1 (R8, proguard-android-optimize.txt) on an API 34
 * emulator; a `-keep class X { <init>(); }` rule fixed it. For WorkManager 2.9.1 / Room 2.5.0 in
 * Expo SDK 58 the keep rules below fixed startup (expo/expo#52173).
 */
export const R8_REFLECTIVE_CONSTRUCTORS = {
  sources: [
    "https://developer.android.com/topic/performance/app-optimization/add-keep-rules",
    "https://github.com/expo/expo/issues/52173",
    "https://github.com/expo/expo/issues/52114",
    "https://docs.expo.dev/versions/latest/sdk/build-properties/",
  ],
  lastVerified: "2026-10-25",
  workManagerKeepRules: [
    "-keep class * extends androidx.room.RoomDatabase { <init>(); }",
    "-keep class * extends androidx.work.InputMerger { <init>(); }",
  ],
};
