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
