import { collectSourceFiles, findLine, readProjectFile } from "../../collectors/project-files.js";
import type { ProjectContext } from "../../detection/project-type.js";
import { finding, type Rule } from "../../engine/rule.js";
import type { ParsedLog } from "../../parsers/index.js";
import type { JsException } from "../../parsers/runtime.js";
import { logEvidence, logEvidenceLines } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";
import { CLEARTEXT_DEFAULTS, R8_REFLECTIVE_CONSTRUCTORS } from "./compat.js";

const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const DEBUG_MANIFEST = "android/app/src/debug/AndroidManifest.xml";
const OKHTTP_CLEARTEXT =
  /CLEARTEXT communication (?:to (\S+) )?not permitted by network security policy/;
/** Hosts of XML/schema namespace strings that appear in source but are never requested. */
const NAMESPACE_HOSTS = new Set([
  "www.w3.org",
  "w3.org",
  "schemas.android.com",
  "schemas.xmlsoap.org",
  "schemas.microsoft.com",
  "ns.adobe.com",
  "purl.org",
  "xmlns.com",
]);
const MAX_URLS = 5;

interface CleartextPolicy {
  /** true: release builds block cleartext; false: allowed; undefined: can't tell. */
  blocked: boolean | undefined;
  evidence: Evidence[];
  /** Why the policy couldn't be determined, when `blocked` is undefined. */
  unknownReason?: string;
}

/** How a release build of this project treats http:// traffic, read from the manifest or app config. */
export function releaseCleartextPolicy(project: ProjectContext): CleartextPolicy {
  const evidence: Evidence[] = [];
  const debug = readProjectFile(project.root, DEBUG_MANIFEST);
  const debugAllows = debug.ok ? findLine(debug.text, /usesCleartextTraffic="true"/) : undefined;
  const debugEvidence: Evidence[] = debugAllows
    ? [
        {
          source: "project",
          file: DEBUG_MANIFEST,
          line: debugAllows.line,
          excerpt: debugAllows.excerpt,
          detail: "Debug builds allow cleartext, so the same request works in development",
        },
      ]
    : [];

  if (project.hasAndroid) {
    const manifest = readProjectFile(project.root, MANIFEST);
    if (!manifest.ok) return { blocked: undefined, evidence, unknownReason: manifest.message };
    const nsc = findLine(manifest.text, /android:networkSecurityConfig=/);
    if (nsc)
      return {
        blocked: undefined,
        evidence,
        unknownReason: `${MANIFEST} uses a network security config (line ${nsc.line}), which this tool doesn't evaluate`,
      };
    const attr = findLine(manifest.text, /android:usesCleartextTraffic="([^"]*)"/);
    const value = attr
      ? /android:usesCleartextTraffic="([^"]*)"/.exec(attr.excerpt)![1]!
      : undefined;
    if (value === "true") return { blocked: false, evidence };
    if (attr)
      evidence.push({ source: "project", file: MANIFEST, line: attr.line, excerpt: attr.excerpt });
    if (value === "false") return { blocked: true, evidence: [...evidence, ...debugEvidence] };
    if (value === "${usesCleartextTraffic}") {
      const gradle = readProjectFile(project.root, "android/app/build.gradle");
      const override = gradle.ok ? findLine(gradle.text, /usesCleartextTraffic/) : undefined;
      if (override)
        return {
          blocked: undefined,
          evidence,
          unknownReason: `android/app/build.gradle sets usesCleartextTraffic itself (line ${override.line})`,
        };
      evidence.push({
        source: "project",
        detail:
          "The React Native Gradle plugin sets the usesCleartextTraffic placeholder to false for release builds and true for debug builds",
      });
      return { blocked: true, evidence };
    }
    if (value !== undefined)
      return { blocked: undefined, evidence, unknownReason: `usesCleartextTraffic is "${value}"` };
    const targetSdk = Number.parseInt(project.versions["targetSdk"] ?? "", 10);
    if (Number.isFinite(targetSdk) && targetSdk < CLEARTEXT_DEFAULTS.blockedByDefaultFromTargetSdk)
      return { blocked: false, evidence };
    evidence.push({
      source: "project",
      file: MANIFEST,
      detail: `No android:usesCleartextTraffic attribute; apps targeting API ${CLEARTEXT_DEFAULTS.blockedByDefaultFromTargetSdk}+ block cleartext by default${Number.isFinite(targetSdk) ? ` (targetSdk ${targetSdk})` : ""}`,
    });
    return { blocked: true, evidence: [...evidence, ...debugEvidence] };
  }

  if (project.kind === "expo") {
    const dynamic = project.appConfig.dynamicConfig;
    if (dynamic && /usesCleartextTraffic/.test(dynamic.text))
      return {
        blocked: undefined,
        evidence,
        unknownReason: `${dynamic.file} sets usesCleartextTraffic, and dynamic config isn't executed`,
      };
    const plugins = project.appConfig.expo?.["plugins"];
    const buildProps = Array.isArray(plugins)
      ? plugins.find(
          (p): p is [string, Record<string, unknown>] =>
            Array.isArray(p) && p[0] === "expo-build-properties" && typeof p[1] === "object",
        )
      : undefined;
    const android = buildProps?.[1]["android"] as Record<string, unknown> | undefined;
    if (android?.["usesCleartextTraffic"] === true) return { blocked: false, evidence };
    evidence.push({
      source: "project",
      file: "app.json",
      detail:
        "expo-build-properties doesn't set android.usesCleartextTraffic, so release builds use the Android default (blocked for API 28+); Expo's template allows cleartext only in debug builds",
    });
    return { blocked: true, evidence };
  }
  return { blocked: undefined, evidence, unknownReason: "The project has no android/ folder" };
}

/** http:// URLs in app source and app.json (never .env values). */
export function httpUrlsInSource(project: ProjectContext): Evidence[] {
  const found: Evidence[] = [];
  const texts: { path: string; text: string }[] = collectSourceFiles(project.root).files;
  if (project.appConfig.appJsonText)
    texts.push({ path: "app.json", text: project.appConfig.appJsonText });
  for (const { path, text } of texts) {
    if (!text.includes("http://")) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && found.length < MAX_URLS; i++) {
      const line = lines[i]!;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      const match = /["'`](http:\/\/([^\s"'`/:$?#]+)[^\s"'`]*)/.exec(line);
      if (!match || NAMESPACE_HOSTS.has(match[2]!)) continue;
      found.push({
        source: "project",
        file: path,
        line: i + 1,
        excerpt: line.trim().slice(0, 200),
        detail: `http:// URL to ${match[2]}`,
      });
    }
  }
  return found;
}

function exceptionEvidence(log: ParsedLog, ex: JsException): Evidence {
  if (ex.lines?.length)
    return logEvidenceLines(
      log.doc,
      ex.lines.slice(0, 3),
      `Only lines from ${ex.tid ? `thread ${ex.tid} of ` : ""}process ${ex.pid} are shown`,
    );
  return logEvidence(log.doc, { start: ex.start, end: ex.start });
}

export const cleartextHttpBlocked: Rule = {
  meta: {
    id: "android.cleartext-http-blocked",
    title: "Release build blocks plain HTTP requests",
    platforms: ["android"],
    scope: "log",
    trigger:
      "Logcat with OkHttp's 'CLEARTEXT communication … not permitted by network security policy', or a JavaScript 'Network request failed' in an Android logcat when the project's release configuration blocks cleartext traffic and the app source contains an http:// URL.",
    evidence:
      "The log line, the manifest or Expo setting that blocks cleartext in release builds, and the http:// URLs found in the app source (file and line).",
    versionScope: `Android apps targeting API ${CLEARTEXT_DEFAULTS.blockedByDefaultFromTargetSdk}+ (React Native 0.73+ template, Expo)`,
    references: CLEARTEXT_DEFAULTS.sources,
    lastVerified: CLEARTEXT_DEFAULTS.lastVerified,
    fixtures: [
      "logs/real-rn087-logcat-cleartext-blocked.log",
      "logs/android-okhttp-cleartext.log",
      "logs/studio-logcat-network-request-failed.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const explicitIndex = log.doc.lines.findIndex((l) => OKHTTP_CLEARTEXT.test(l));
      const networkFailure = log.runtime.jsExceptions.find(
        (ex) => ex.pid !== undefined && /^Network request failed\b/.test(ex.message),
      );
      if (explicitIndex < 0 && !networkFailure) continue;

      const policy = ctx.project ? releaseCleartextPolicy(ctx.project) : undefined;
      const urls = ctx.project ? httpUrlsInSource(ctx.project) : [];
      const expo = ctx.project?.kind === "expo" && !ctx.project.hasAndroid;
      const fixSteps = [
        "Use an https:// URL for the server. This is the fix for anything that ships to users.",
        expo
          ? "If the server can only speak HTTP (a local or test backend), set `android.usesCleartextTraffic: true` in the expo-build-properties plugin options and rebuild. This allows HTTP to every host."
          : 'If the server can only speak HTTP (a local or test backend), allow cleartext for that host only with a network security config (res/xml/network_security_config.xml with a <domain-config cleartextTrafficPermitted="true">), or set android:usesCleartextTraffic="true" in AndroidManifest.xml to allow it everywhere.',
        "Rebuild the release variant; the setting is compiled into the APK.",
      ];

      if (explicitIndex >= 0) {
        const host = OKHTTP_CLEARTEXT.exec(log.doc.lines[explicitIndex]!)![1];
        out.push(
          finding(this.meta, {
            title: `Android blocked a plain HTTP request${host ? ` to ${host}` : ""}`,
            severity: "error",
            confidence: "high",
            explanation: `OkHttp refused an http:// request${host ? ` to ${host}` : ""} because the app's network security policy doesn't allow cleartext traffic. Apps targeting API ${CLEARTEXT_DEFAULTS.blockedByDefaultFromTargetSdk}+ block it by default, and React Native and Expo allow it only in debug builds, so the request works in development and fails in release.`,
            evidence: [
              logEvidence(log.doc, { start: explicitIndex, end: explicitIndex }),
              ...urls,
              ...(policy?.evidence ?? []),
            ],
            nextSteps: fixSteps,
            verification: "The request succeeds in a release build.",
          }),
        );
        continue;
      }

      if (!networkFailure || policy?.blocked !== true || urls.length === 0) continue;
      out.push(
        finding(this.meta, {
          title: `Network request failed: release builds block http:// requests (${urls
            .map((u) => u.detail!.replace(/^http:\/\/ URL to /, ""))
            .filter((h, i, all) => all.indexOf(h) === i)
            .slice(0, 2)
            .join(", ")})`,
          severity: "warning",
          confidence: "medium",
          explanation:
            `A fetch failed with "Network request failed", the app's source contains http:// URLs, and this project's release builds don't allow cleartext (HTTP) traffic. ` +
            "Android blocks the request before it leaves the device, and React Native reports only the generic message, so logcat doesn't name the cause. " +
            "Other failures (server down, no network, DNS) produce the same message, so confirm which URL the failing request uses.",
          evidence: [exceptionEvidence(log, networkFailure), ...urls, ...policy.evidence],
          nextSteps: fixSteps,
          verification:
            "The request succeeds in a release build (`npx react-native run-android --mode release` or `npx expo run:android --variant release`).",
          limitations: [
            "URLs that come from .env files or remote config aren't checked; this tool reads .env files for variable names only.",
          ],
        }),
      );
    }
    return out;
  },
};

/** A constructor missing at runtime, or Room failing to create its generated database class. */
export const REFLECTIVE_CONSTRUCTOR =
  /NoSuchMethodException: ([\w.$]+)\.<init>|Failed to create an instance of (?:class )?([\w.$]+?)(?:\.canonicalName)?\s*$/;
/** Stack frames that only appear in R8-processed code. */
const R8_FRAME = /\(r8-map-id-[0-9a-f]+:\d+\)|\bat [a-z]{1,3}\.[a-z]{1,3}\(/;

export const r8RemovedConstructor: Rule = {
  meta: {
    id: "android.r8-removed-constructor",
    title: "R8 removed a constructor that a library calls by reflection",
    platforms: ["android"],
    scope: "log",
    trigger:
      "A logcat FATAL EXCEPTION whose message or 'Caused by' chain has 'NoSuchMethodException: X.<init>' or Room's 'Failed to create an instance of class X'.",
    evidence:
      "The fatal exception and cause lines, the class whose constructor is missing, and stack frames that show R8 processed the code (r8-map-id frames or obfuscated names).",
    versionScope:
      "Android release builds with R8 (minifyEnabled / enableMinifyInReleaseBuilds); AGP 8+",
    references: R8_REFLECTIVE_CONSTRUCTORS.sources,
    lastVerified: R8_REFLECTIVE_CONSTRUCTORS.lastVerified,
    fixtures: [
      "logs/real-logcat-r8-removed-constructor.log",
      "logs/real-logcat-expo58-workmanager-r8.log",
      "logs/studio-logcat-r8-removed-constructor.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const fatal of log.runtime.androidFatals.slice(0, 3)) {
        const chain = [fatal.message, ...fatal.causes];
        const hit = chain.map((c) => REFLECTIVE_CONSTRUCTOR.exec(c)).find(Boolean);
        if (!hit) continue;
        const cls = (hit[1] ?? hit[2])!;
        const frames = log.doc.lines.slice(fatal.start, fatal.end + 1);
        const r8 =
          frames.some((l) => R8_FRAME.test(l)) || /^[a-z]{1,3}(?:\.[a-z]{1,3})?$/.test(cls);
        const workManager = /^androidx\.work\./.test(cls);
        const obfuscated = /^[a-z]{1,3}(?:\.[a-z]{1,3})?$/.test(cls);
        const expo = ctx.project?.kind === "expo";
        const keep = workManager
          ? R8_REFLECTIVE_CONSTRUCTORS.workManagerKeepRules
          : [
              `-keep class ${obfuscated ? "<original class name>" : cls.replace(/\.canonicalName$/, "")} { <init>(); }`,
            ];
        const evidence: Evidence[] = [
          logEvidence(
            log.doc,
            fatal,
            `${fatal.exception}${fatal.process ? ` in ${fatal.process}` : ""}`,
          ),
        ];
        const r8Line = frames.findIndex((l) => R8_FRAME.test(l));
        if (r8Line >= 0)
          evidence.push({
            source: "log",
            file: log.doc.path,
            line: fatal.start + r8Line + 1,
            detail: "Stack frame from R8-processed code",
          });
        out.push(
          finding(this.meta, {
            title: `Release build crash: R8 removed the constructor of ${cls}${workManager ? " (WorkManager)" : ""}`,
            severity: "error",
            confidence: r8 ? "high" : "medium",
            explanation:
              `The app crashed creating ${cls} by reflection: ${hit[1] ? "its no-argument constructor doesn't exist at runtime" : "Room couldn't create the generated database class"}. ` +
              "R8, which shrinks release builds, keeps a class that's referenced but removes constructors nothing calls directly, so code that creates the class reflectively breaks only in minified builds. " +
              (r8
                ? "The stack trace shows R8-processed code. "
                : "The stack trace doesn't prove R8 ran; check that the crash only happens in a release (minified) build. ") +
              (workManager
                ? "Here it's WorkManager's Room database: in Expo SDK 58, WorkManager 2.9.1 / Room 2.5.0 (pulled in by expo-background-task or expo-widgets) crash this way at startup with minify on (expo/expo#52173)."
                : obfuscated
                  ? "The class name is obfuscated; look it up in the mapping file to find the original class."
                  : ""),
            evidence,
            nextSteps: [
              `Add keep rule${keep.length > 1 ? "s" : ""} for the constructor${keep.length > 1 ? "s" : ""}: ${keep.map((k) => `\`${k}\``).join(" and ")}. ${expo ? "In an Expo project, add them with the expo-build-properties option android.extraProguardRules." : "Add them to android/app/proguard-rules.pro (Expo: the expo-build-properties option android.extraProguardRules)."}`,
              ...(obfuscated
                ? [
                    `Find the original name of '${cls}' in android/app/build/outputs/mapping/release/mapping.txt (lines like \`com.example.Foo -> ${cls}:\`), or run the stack trace through \`retrace\` with that file.`,
                  ]
                : []),
              workManager
                ? "Check for a newer release of the package that brings in WorkManager (expo-background-task, expo-widgets) that ships these rules itself, then remove yours."
                : "Report it to the library that creates the class: libraries should ship consumer keep rules for classes they create by reflection.",
              "Rebuild the release variant and launch it; debug builds aren't minified and won't show the crash.",
            ],
            verification: "The release build starts without the exception.",
          }),
        );
      }
    }
    return out;
  },
};

export const androidRuntimeRules: Rule[] = [cleartextHttpBlocked, r8RemovedConstructor];
