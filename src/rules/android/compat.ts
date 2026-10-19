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
