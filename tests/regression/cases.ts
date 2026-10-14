/**
 * Labeled benchmark. `expect` lists every error/warning rule that must fire (exactly; anything
 * else at error/warning severity is a false positive). `info` lists informational rules that must
 * fire. `forbid` documents near-miss rules that must not fire.
 */
export interface Case {
  name: string;
  kind: "log" | "project";
  input: string;
  /** Project directory for log cases (defaults to no project). */
  cwd?: string;
  /** JDK fixture under tests/fixtures/jdks used as JAVA_HOME (defaults to no JDK). */
  javaHome?: string;
  expect: string[];
  info?: string[];
  forbid?: string[];
  /** Substrings that must appear in the first finding for this case's first expected rule. */
  mustMention?: string[];
}

export const CASES: Case[] = [
  // --- Android / Gradle
  {
    name: "missing artifact",
    kind: "log",
    input: "android-dependency-resolution.log",
    expect: ["android.dependency-resolution"],
    forbid: ["android.aar-metadata-check"],
    mustMention: ["com.github.example:image-cropper:4.6.2", "react-native-image-crop-picker"],
  },
  {
    name: "dynamic react-native dependency",
    kind: "log",
    input: "android-dynamic-react-native.log",
    expect: ["android.dependency-resolution"],
    mustMention: ["35210"],
  },
  {
    name: "AGP needs JDK 17",
    kind: "log",
    input: "android-agp-jdk.log",
    expect: ["android.agp-requires-newer-jdk"],
    mustMention: ["Java 11", "Java 17"],
  },
  {
    name: "class file major 65 on Gradle 8.3",
    kind: "log",
    input: "android-class-file-version.log",
    expect: ["android.unsupported-class-file-version"],
    mustMention: ["Java 21", "8.5"],
  },
  {
    name: "Gradle wrapper too old",
    kind: "log",
    input: "android-gradle-too-low.log",
    expect: ["android.gradle-version-too-low"],
    mustMention: ["8.13", "8.10.2"],
  },
  {
    name: "SDK location",
    kind: "log",
    input: "android-sdk-location.log",
    expect: ["android.sdk-location-not-found"],
  },
  {
    name: "SDK licenses",
    kind: "log",
    input: "android-sdk-licenses.log",
    expect: ["android.sdk-licenses-not-accepted"],
    mustMention: ["sdkmanager --licenses"],
  },
  {
    name: "compileSdk 36 required",
    kind: "log",
    input: "android-aar-metadata.log",
    expect: ["android.aar-metadata-check"],
    forbid: ["android.dependency-resolution"],
    mustMention: ["36", "androidx.core:core:1.17.0"],
  },
  {
    name: "duplicate classes support vs androidx",
    kind: "log",
    input: "android-duplicate-class.log",
    expect: ["android.duplicate-class"],
    mustMention: ["Support Library"],
  },
  {
    name: "manifest exported",
    kind: "log",
    input: "android-manifest-exported.log",
    expect: ["android.manifest-merger-failed"],
    mustMention: ["android:exported"],
  },
  {
    name: "bundle task with Metro error (no project)",
    kind: "log",
    input: "android-bundle-unable-to-resolve.log",
    expect: ["javascript.unable-to-resolve-module", "android.js-bundle-task-failed"],
    mustMention: ["react-native-mmkv"],
  },
  {
    name: "bundle task with Metro error (project without the package)",
    kind: "log",
    input: "android-bundle-unable-to-resolve.log",
    cwd: "rn-cli-missing-dependency",
    expect: ["javascript.unable-to-resolve-module", "android.js-bundle-task-failed"],
    mustMention: ["isn't declared in package.json"],
  },
  {
    name: "bundle task without Metro detail",
    kind: "log",
    input: "android-bundle-no-detail.log",
    expect: ["android.js-bundle-task-failed"],
    mustMention: ["ENOSPC"],
  },
  // --- Metro
  {
    name: "expo path alias not resolved",
    kind: "log",
    input: "metro-unable-to-resolve.log",
    expect: ["javascript.unable-to-resolve-module"],
    mustMention: ["path alias"],
  },
  {
    name: "babel syntax error",
    kind: "log",
    input: "metro-syntax-error.log",
    expect: ["javascript.bundle-syntax-error"],
    mustMention: ["42:8"],
  },
  // Captured from a real Expo SDK 57 / React Native 0.86 project (`npx expo export`), paths anonymized.
  {
    name: "real Expo export: missing package",
    kind: "log",
    input: "real-expo57-metro-pkg.log",
    expect: ["javascript.unable-to-resolve-module"],
    mustMention: ["react-native-not-installed-pkg"],
  },
  {
    name: "real Expo export: unresolved alias",
    kind: "log",
    input: "real-expo57-metro-alias.log",
    expect: ["javascript.unable-to-resolve-module"],
    mustMention: ["path alias"],
  },
  {
    name: "real Expo export: syntax error",
    kind: "log",
    input: "real-expo57-metro-syntax.log",
    expect: ["javascript.bundle-syntax-error"],
    mustMention: ["1:11"],
  },
  // Captured from real Gradle 9.3.1 / AGP 8.12 builds of the same project, paths anonymized.
  {
    name: "real Gradle: missing dependency",
    kind: "log",
    input: "real-gradle93-missing-dependency.log",
    expect: ["android.dependency-resolution"],
    mustMention: ["com.example.nonexistent:does-not-exist:9.9.9"],
  },
  {
    name: "real Gradle: 54 AAR metadata issues",
    kind: "log",
    input: "real-gradle93-aar-metadata.log",
    expect: ["android.aar-metadata-check"],
    mustMention: ["Android API 36 (currently 33)", "androidx.core:core-splashscreen:1.2.0"],
  },
  // --- iOS
  {
    name: "pods incompatible + deployment target",
    kind: "log",
    input: "ios-cocoapods-incompatible.log",
    expect: ["ios.cocoapods-incompatible-versions"],
    mustMention: ["FirebaseCore", "deployment target"],
  },
  {
    name: "real pod install: spec not found",
    kind: "log",
    input: "real-cocoapods-spec-not-found.log",
    expect: ["ios.cocoapods-spec-not-found"],
    mustMention: ["RNDoesNotExistAnywhere"],
  },
  {
    name: "pod spec not found",
    kind: "log",
    input: "ios-cocoapods-spec-not-found.log",
    expect: ["ios.cocoapods-spec-not-found"],
    mustMention: ["RNCAsyncStorage"],
  },
  {
    name: "signing team",
    kind: "log",
    input: "ios-signing-team.log",
    expect: ["ios.code-signing"],
    forbid: ["ios.compile-error"],
    mustMention: ["development team"],
  },
  {
    name: "header not found (xcpretty)",
    kind: "log",
    input: "ios-header-not-found.log",
    expect: ["ios.compile-error"],
    mustMention: ["RNBootSplash.h"],
  },
  {
    name: "linker library not found",
    kind: "log",
    input: "ios-linker.log",
    expect: ["ios.linker-error"],
    forbid: ["ios.compile-error"],
    mustMention: ["Pods-MyApp"],
  },
  {
    name: "node binary not found",
    kind: "log",
    input: "ios-node-binary.log",
    expect: ["ios.bundle-phase-failed"],
    forbid: ["ios.compile-error"],
    mustMention: ["NODE_BINARY"],
  },
  {
    name: "real xcodebuild (Xcode 26.6): Swift type error",
    kind: "log",
    input: "real-xcode26-swift-compile-error.log",
    expect: ["ios.compile-error"],
    forbid: ["ios.bundle-phase-failed", "ios.code-signing"],
    mustMention: [
      "AppDelegate.swift:71:24",
      "cannot convert value of type 'String' to specified type 'Int'",
    ],
  },
  // --- Runtime
  {
    name: "JS TypeError via logcat",
    kind: "log",
    input: "runtime-android-js-exception.log",
    expect: ["runtime.javascript-exception", "runtime.android-fatal-exception"],
    forbid: ["runtime.missing-configuration-suspected"],
    mustMention: ["Cannot read property 'map' of undefined"],
  },
  {
    name: "missing Supabase URL in production",
    kind: "log",
    input: "runtime-missing-supabase-url.log",
    expect: [
      "runtime.javascript-exception",
      "runtime.android-fatal-exception",
      "runtime.missing-configuration-suspected",
    ],
    mustMention: ["supabaseUrl is required"],
  },
  {
    name: "release build without bundle",
    kind: "log",
    input: "runtime-android-unable-to-load-script.log",
    expect: ["runtime.android-fatal-exception"],
    mustMention: ["Unable to load script"],
  },
  {
    name: "iOS RCTFatal crash",
    kind: "log",
    input: "ios-crash-rctfatal.crash",
    expect: ["runtime.ios-crash"],
    mustMention: ["RCTFatal"],
  },
  {
    name: "iOS privacy usage description",
    kind: "log",
    input: "ios-privacy-usage.log",
    expect: ["runtime.ios-crash"],
    mustMention: ["NSCameraUsageDescription"],
  },
  // --- Honest fallbacks and near misses
  {
    name: "unknown Kotlin error",
    kind: "log",
    input: "unknown-error.log",
    expect: [],
    info: ["common.no-supported-diagnosis"],
    forbid: ["android.dependency-resolution"],
  },
  {
    name: "resource merge failure (near miss)",
    kind: "log",
    input: "near-miss-network.log",
    expect: [],
    info: ["common.no-supported-diagnosis"],
  },
  {
    name: "successful Android build",
    kind: "log",
    input: "android-success.log",
    expect: [],
    info: ["common.no-failure-detected"],
  },
  {
    name: "successful iOS build",
    kind: "log",
    input: "ios-success.log",
    expect: [],
    info: ["common.no-failure-detected"],
  },
  // --- Projects
  { name: "clean Expo project", kind: "project", input: "expo-clean", expect: [] },
  { name: "clean RN CLI project", kind: "project", input: "rn-cli-clean", expect: [] },
  {
    name: "JDK 17 with Gradle 6.5 (RN 0.63)",
    kind: "project",
    input: "rn-cli-old-gradle",
    javaHome: "jdk17",
    expect: ["android.jdk-too-new-for-gradle"],
    mustMention: ["Java 17", "6.5", "7.3"],
  },
  {
    name: "near miss: JDK 11 with Gradle 6.5",
    kind: "project",
    input: "rn-cli-old-gradle",
    javaHome: "jdk11",
    expect: [],
  },
  {
    name: "near miss: Gradle 6.5 with org.gradle.java.home set",
    kind: "project",
    input: "rn-cli-old-gradle-java-home",
    javaHome: "jdk17",
    expect: [],
  },
  {
    name: "near miss: JDK 17 with Gradle 8.14.3",
    kind: "project",
    input: "rn-cli-clean",
    javaHome: "jdk17",
    expect: [],
  },
  {
    name: "invalid app.json",
    kind: "project",
    input: "expo-invalid-app-json",
    expect: ["expo.invalid-app-json"],
  },
  {
    name: "config plugin not installed",
    kind: "project",
    input: "expo-missing-plugin",
    expect: ["expo.config-plugin-not-installed"],
    mustMention: ["expo-build-properties"],
  },
  {
    name: "Expo SDK mismatch",
    kind: "project",
    input: "expo-version-mismatch",
    expect: ["expo.package-version-mismatch"],
    mustMention: ["react-native-reanimated: installed 3.17.5, expected ~4.1.1"],
  },
  {
    name: "native dirs with prebuild config",
    kind: "project",
    input: "expo-native-dirs",
    expect: ["expo.native-dirs-with-prebuild-config"],
  },
  {
    name: "env var only in ignored .env (demo)",
    kind: "project",
    input: "expo-env-missing-in-eas",
    expect: [
      "expo.env-file-not-available-in-eas",
      "expo.public-env-dynamic-access",
      "env.variable-not-defined-locally",
    ],
    mustMention: ["EXPO_PUBLIC_SUPABASE_URL", "production"],
  },
  {
    name: "multiple lockfiles + SDK not configured",
    kind: "project",
    input: "rn-cli-missing-dependency",
    expect: ["common.multiple-lockfiles", "android.sdk-not-configured"],
  },
  {
    name: "invalid package.json",
    kind: "project",
    input: "invalid-package-json",
    expect: ["common.invalid-package-json"],
    info: ["common.project-not-detected"],
  },
  {
    name: "not a project",
    kind: "project",
    input: "not-a-project",
    expect: [],
    info: ["common.project-not-detected"],
  },
  {
    name: "monorepo root",
    kind: "project",
    input: "monorepo-root",
    expect: [],
    info: ["common.project-not-detected"],
  },
];
