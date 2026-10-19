import { collectSourceFiles, findLine, readProjectFile } from "../../collectors/project-files.js";
import type { ProjectContext } from "../../detection/project-type.js";
import { finding, type Rule } from "../../engine/rule.js";
import type { ParsedLog } from "../../parsers/index.js";
import type { JsException } from "../../parsers/runtime.js";
import { logEvidence, logEvidenceLines } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";
import { CLEARTEXT_DEFAULTS } from "./compat.js";

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
    fixtures: ["logs/real-rn087-logcat-cleartext-blocked.log", "logs/android-okhttp-cleartext.log"],
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

export const androidRuntimeRules: Rule[] = [cleartextHttpBlocked];
