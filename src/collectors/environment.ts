import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JavaInfo {
  /** Major version, e.g. 17. */
  major: number;
  raw: string;
  source: "JAVA_HOME" | "PATH";
}

export interface EnvironmentSnapshot {
  /** Names (never values) of variables in the inspected shell environment. */
  variableNames: Set<string>;
  java?: JavaInfo;
  javaHome?: string;
  /** Whether the JAVA_HOME directory exists (only when JAVA_HOME is set). */
  javaHomeExists?: boolean;
  /** Result of looking for `java` on PATH: skipped when not probed or JAVA_HOME already gave a JDK. */
  javaProbe: "found" | "not-found" | "skipped";
  androidSdk?: { variable: "ANDROID_HOME" | "ANDROID_SDK_ROOT"; exists: boolean };
  nodeVersion: string;
  platform: NodeJS.Platform;
}

export function parseJavaMajor(versionOutput: string): { major: number; raw: string } | undefined {
  const match =
    /version\s+"([^"]+)"/.exec(versionOutput) ?? /^JAVA_VERSION="([^"]+)"/m.exec(versionOutput);
  if (!match) return undefined;
  const raw = match[1]!;
  // "1.8.0_392" => 8, "17.0.11" => 17, "21" => 21
  const parts = raw.split(/[._+-]/);
  const first = Number(parts[0]);
  const major = first === 1 ? Number(parts[1]) : first;
  return Number.isFinite(major) && major > 0 ? { major, raw } : undefined;
}

export interface CollectEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  /** Run `java -version` when JAVA_HOME is not set (local process, no network). */
  probeJava?: boolean;
}

export function collectEnvironment(options: CollectEnvironmentOptions = {}): EnvironmentSnapshot {
  const env = options.env ?? process.env;
  const snapshot: EnvironmentSnapshot = {
    variableNames: new Set(Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== "")),
    nodeVersion: process.versions.node,
    platform: process.platform,
    javaProbe: "skipped",
  };

  const javaHome = env["JAVA_HOME"];
  if (javaHome) {
    snapshot.javaHome = javaHome;
    snapshot.javaHomeExists = existsSync(javaHome);
    try {
      const release = readFileSync(join(javaHome, "release"), "utf8");
      const parsed = parseJavaMajor(release);
      if (parsed) snapshot.java = { ...parsed, source: "JAVA_HOME" };
    } catch {
      // fall through to the PATH probe
    }
  }
  if (!snapshot.java && options.probeJava !== false) {
    try {
      const result = spawnSync("java", ["-version"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        env: { ...env },
      });
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      const parsed = result.error ? undefined : parseJavaMajor(output);
      if (parsed) snapshot.java = { ...parsed, source: "PATH" };
      snapshot.javaProbe = result.error ? "not-found" : "found";
    } catch {
      // java is not installed or not runnable
      snapshot.javaProbe = "not-found";
    }
  }

  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"] as const) {
    const value = env[variable];
    if (value) {
      snapshot.androidSdk = { variable, exists: existsSync(value) };
      break;
    }
  }
  return snapshot;
}
