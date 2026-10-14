import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProjectSummary } from "../reports/schema.js";
import {
  fileExists,
  isDirectory,
  readJsonFile,
  readProjectFile,
  type JsonResult,
} from "../collectors/project-files.js";

export type ProjectKind = ProjectSummary["kind"];

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

export type AppConfigFile =
  "app.json" | "app.config.js" | "app.config.ts" | "app.config.mjs" | "app.config.cjs";

export interface AppConfig {
  /** Every app config file present (Expo uses app.config.* and passes app.json to it). */
  files: AppConfigFile[];
  /** Parsed `expo` object from app.json (or the root object when there is no `expo` key). */
  expo?: Record<string, unknown>;
  /** Raw app.json text, for line lookups. */
  appJsonText?: string;
  appJsonError?: { message: string; line?: number };
  /** Text of the dynamic config file, which is never executed. */
  dynamicConfig?: { file: AppConfigFile; text: string };
}

export interface ProjectContext {
  root: string;
  kind: ProjectKind;
  packageJson?: PackageJson;
  packageJsonText?: string;
  packageJsonError?: { message: string; line?: number };
  /** dependencies + devDependencies as declared. */
  declared: Record<string, string>;
  nodeModulesPresent: boolean;
  lockfiles: string[];
  packageManager?: string;
  hasAndroid: boolean;
  hasIos: boolean;
  appConfig: AppConfig;
  versions: Record<string, string>;
  notes: string[];
  /** Resolves the installed version of a package through node_modules, walking up like Node does. */
  installedVersion(pkg: string): string | undefined;
}

const LOCKFILES: [string, string][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

const APP_CONFIG_FILES: AppConfigFile[] = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "app.config.mjs",
  "app.config.cjs",
];

/** How many parent directories to search for hoisted node_modules or a workspace lockfile. */
const MAX_PARENT_LEVELS = 4;

export function detectProject(rootInput: string): ProjectContext {
  const root = resolve(rootInput);
  const notes: string[] = [];
  const versions: Record<string, string> = {};

  const pkg = readJsonFile<PackageJson>(root, "package.json");
  let packageJson: PackageJson | undefined;
  let packageJsonError: ProjectContext["packageJsonError"];
  if (pkg.ok) {
    packageJson = pkg.value && typeof pkg.value === "object" ? pkg.value : {};
  } else if (pkg.reason === "invalid") {
    packageJsonError = { message: pkg.message, ...(pkg.line ? { line: pkg.line } : {}) };
    notes.push(`package.json could not be parsed: ${pkg.message}`);
  } else if (pkg.reason !== "missing") {
    notes.push(`package.json could not be read: ${pkg.message}`);
  }

  const declared: Record<string, string> = {
    ...asStringRecord(packageJson?.devDependencies),
    ...asStringRecord(packageJson?.dependencies),
  };

  const searchDirs = [root];
  for (let dir = root, i = 0; i < MAX_PARENT_LEVELS; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    searchDirs.push(parent);
    dir = parent;
  }

  const versionCache = new Map<string, string | undefined>();
  const installedVersion = (name: string): string | undefined => {
    if (versionCache.has(name)) return versionCache.get(name);
    let found: string | undefined;
    for (const dir of searchDirs) {
      const manifest = join(dir, "node_modules", name, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown })
          .version;
        if (typeof version === "string") found = version;
      } catch {
        // ignore unreadable manifests
      }
      break;
    }
    versionCache.set(name, found);
    return found;
  };

  const nodeModulesPresent = searchDirs.some((d) => existsSync(join(d, "node_modules")));

  let lockfiles = LOCKFILES.filter(([file]) => fileExists(root, file)).map(([file]) => file);
  let lockfileDir = root;
  if (lockfiles.length === 0) {
    for (const dir of searchDirs.slice(1)) {
      const found = LOCKFILES.filter(([file]) => existsSync(join(dir, file))).map(([f]) => f);
      if (found.length) {
        lockfiles = found;
        lockfileDir = dir;
        notes.push(`Lockfile found in parent directory ${dir} (workspace root).`);
        break;
      }
    }
  }
  let packageManager: string | undefined;
  if (typeof packageJson?.packageManager === "string") {
    packageManager = packageJson.packageManager.split("@")[0];
  } else if (lockfiles.length > 0) {
    packageManager = LOCKFILES.find(([file]) => file === lockfiles[0])?.[1];
  }
  void lockfileDir;

  const hasAndroid = isDirectory(root, "android");
  const hasIos = isDirectory(root, "ios");
  const appConfig = readAppConfig(root);

  for (const name of ["react-native", "expo", "react"]) {
    const installed = installedVersion(name);
    if (installed) versions[name] = installed;
    else if (declared[name]) versions[`${name} (declared)`] = declared[name];
  }

  let kind: ProjectKind = "unknown";
  if (declared["expo"]) kind = "expo";
  else if (declared["react-native"]) kind = "react-native-cli";
  else if (packageJson && (packageJson.workspaces || fileExists(root, "pnpm-workspace.yaml"))) {
    kind = "monorepo-root";
    notes.push(
      "This looks like a monorepo root without React Native dependencies. Run the command with --cwd pointing at the app package.",
    );
  } else if (!pkg.ok && pkg.reason === "missing") {
    notes.push("No package.json found; this directory is not a supported JavaScript project.");
  } else if (packageJson) {
    notes.push(
      "package.json does not declare react-native or expo; project-specific checks were skipped.",
    );
  }

  if (hasAndroid) Object.assign(versions, readAndroidVersions(root, installedVersion, notes));
  if (hasIos) Object.assign(versions, readIosVersions(root));

  return {
    root,
    kind,
    ...(packageJson ? { packageJson } : {}),
    ...(pkg.ok ? { packageJsonText: pkg.text } : {}),
    ...(packageJsonError ? { packageJsonError } : {}),
    declared,
    nodeModulesPresent,
    lockfiles,
    ...(packageManager ? { packageManager } : {}),
    hasAndroid,
    hasIos,
    appConfig,
    versions,
    notes,
    installedVersion,
  };
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function readAppConfig(root: string): AppConfig {
  const files = APP_CONFIG_FILES.filter((f) => fileExists(root, f));
  const config: AppConfig = { files };
  if (files.includes("app.json")) {
    const result: JsonResult<unknown> = readJsonFile(root, "app.json");
    if (result.ok) {
      config.appJsonText = result.text;
      const value = result.value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const expo = record["expo"];
        config.expo =
          expo && typeof expo === "object" && !Array.isArray(expo)
            ? (expo as Record<string, unknown>)
            : record;
      } else {
        config.appJsonError = { message: "app.json must contain a JSON object" };
      }
    } else if (result.reason === "invalid") {
      config.appJsonText = result.text ?? "";
      config.appJsonError = {
        message: result.message,
        ...(result.line ? { line: result.line } : {}),
      };
    } else {
      config.appJsonError = { message: result.message };
    }
  }
  const dynamic = files.find((f) => f !== "app.json");
  if (dynamic) {
    const text = readProjectFile(root, dynamic);
    if (text.ok) config.dynamicConfig = { file: dynamic, text: text.text };
  }
  return config;
}

function matchFirst(text: string | undefined, patterns: RegExp[]): string | undefined {
  if (!text) return undefined;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function readText(root: string, rel: string): string | undefined {
  const result = readProjectFile(root, rel);
  return result.ok ? result.text : undefined;
}

function readAndroidVersions(
  root: string,
  installedVersion: (name: string) => string | undefined,
  notes: string[],
): Record<string, string> {
  const versions: Record<string, string> = {};
  const wrapper = readText(root, "android/gradle/wrapper/gradle-wrapper.properties");
  const gradle = matchFirst(wrapper, [
    /distributionUrl=.*gradle-([0-9][0-9A-Za-z.-]*?)-(?:bin|all)\.zip/,
  ]);
  if (gradle) versions["gradle (wrapper)"] = gradle;

  const rootBuild =
    readText(root, "android/build.gradle") ?? readText(root, "android/build.gradle.kts");
  const settings =
    readText(root, "android/settings.gradle") ?? readText(root, "android/settings.gradle.kts");
  const catalog = readText(root, "android/gradle/libs.versions.toml");

  const agp =
    matchFirst(rootBuild, [/com\.android\.tools\.build:gradle:([0-9][0-9A-Za-z.-]*)/]) ??
    matchFirst(settings, [
      /id\s*\(?\s*["']com\.android\.application["']\s*\)?\s*version\s*["']([^"']+)["']/,
    ]) ??
    matchFirst(catalog, [/^\s*agp\s*=\s*["']([^"']+)["']/m]);
  if (agp) {
    versions["android gradle plugin"] = agp;
  } else if (rootBuild && /com\.android\.tools\.build:gradle["')]/.test(rootBuild)) {
    // React Native templates leave AGP unversioned; it comes from React Native's version catalog.
    const rnRoot = installedVersion("react-native")
      ? findPackageDir(root, "react-native")
      : undefined;
    const rnCatalog = rnRoot ? safeRead(join(rnRoot, "gradle", "libs.versions.toml")) : undefined;
    const fromRn = matchFirst(rnCatalog, [/^\s*agp\s*=\s*["']([^"']+)["']/m]);
    if (fromRn) {
      versions["android gradle plugin"] = fromRn;
      notes.push(
        "Android Gradle Plugin version taken from react-native/gradle/libs.versions.toml.",
      );
    }
  }

  const ext = (name: string) =>
    matchFirst(rootBuild, [new RegExp(`\\b${name}\\s*=\\s*["']?([0-9][0-9A-Za-z.\\-]*)`)]);
  const fields: [string, string][] = [
    ["compileSdkVersion", "compileSdk"],
    ["targetSdkVersion", "targetSdk"],
    ["minSdkVersion", "minSdk"],
    ["buildToolsVersion", "buildTools"],
    ["ndkVersion", "ndk"],
    ["kotlinVersion", "kotlin"],
  ];
  for (const [field, label] of fields) {
    const value = ext(field);
    if (value) versions[label] = value;
  }

  const gradleProps = readText(root, "android/gradle.properties");
  // Expo templates configure SDK levels through gradle.properties (android.compileSdkVersion=...).
  for (const [prop, label] of [
    ["android.compileSdkVersion", "compileSdk"],
    ["android.targetSdkVersion", "targetSdk"],
    ["android.minSdkVersion", "minSdk"],
  ] as const) {
    const value = matchFirst(gradleProps, [
      new RegExp(`^\\s*${prop.replace(".", "\\.")}\\s*=\\s*(\\d+)`, "m"),
    ]);
    if (value && !versions[label]) versions[label] = value;
  }
  const newArch = matchFirst(gradleProps, [/^\s*newArchEnabled\s*=\s*(true|false)/m]);
  if (newArch) versions["newArchEnabled (android)"] = newArch;
  const hermes = matchFirst(gradleProps, [/^\s*hermesEnabled\s*=\s*(true|false)/m]);
  if (hermes) versions["hermesEnabled (android)"] = hermes;
  return versions;
}

function readIosVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {};
  const podfile = readText(root, "ios/Podfile");
  const target = matchFirst(podfile, [/^\s*platform\s+:ios\s*,\s*["']([0-9.]+)["']/m]);
  if (target) versions["ios deployment target (Podfile)"] = target;
  const lock = readText(root, "ios/Podfile.lock");
  const cocoapods = matchFirst(lock, [/^COCOAPODS:\s*([0-9.]+)/m]);
  if (cocoapods) versions["cocoapods (Podfile.lock)"] = cocoapods;
  return versions;
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function findPackageDir(root: string, name: string): string | undefined {
  let dir = resolve(root);
  for (let i = 0; i <= MAX_PARENT_LEVELS; i++) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function summarizeProject(ctx: ProjectContext): ProjectSummary {
  return {
    root: ctx.root,
    kind: ctx.kind,
    ...(ctx.packageManager ? { packageManager: ctx.packageManager } : {}),
    lockfiles: ctx.lockfiles,
    hasAndroid: ctx.hasAndroid,
    hasIos: ctx.hasIos,
    versions: ctx.versions,
    notes: ctx.notes,
  };
}
