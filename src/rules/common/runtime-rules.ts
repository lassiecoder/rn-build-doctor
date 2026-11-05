import { finding, type Rule } from "../../engine/rule.js";
import { findNativeModuleOwner } from "../expo/native-modules.js";
import { JAVA_TIME_API } from "../android/compat.js";
import { EAS_UPDATE_ENV } from "../javascript/compat.js";
import { REFLECTIVE_CONSTRUCTOR } from "../android/runtime-rules.js";
import type { ParsedLog } from "../../parsers/index.js";
import type { JsException } from "../../parsers/runtime.js";
import { lineNumber } from "../../collectors/build-logs.js";
import { logEvidence, logEvidenceLines, stripLogcatPrefix } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

const VERIFIED = "2026-10-14";
const HERMES_BYTECODE = /Wrong bytecode version\. Expected (\d+) but got (\d+)/;
/** UIKit stopping an iOS 27 SDK app without a scene life cycle (ios.uiscene-lifecycle-required). */
const NO_SCENE_LIFECYCLE =
  /UIScene life cycle is required for apps built with this SDK|_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption/;
const MAX_PER_LOG = 3;

/**
 * Errors React Native reports after an earlier JavaScript error stopped the bundle from loading or
 * the surface from starting. On their own they don't point at a cause.
 */
const FOLLOW_ON = [
  /has not been registered\b/,
  /\bGlobal was not installed\b/,
  /is not a registered callable module/,
];

/** JavaScript errors saying a native module isn't available in this build. */
const NATIVE_MODULE_MISSING =
  /Cannot find native module '([^']+)'|TurboModuleRegistry\.getEnforcing\(\.\.\.\): '([^']+)' could not be found/;
/** Native errors that stop native modules from being set up. */
const NATIVE_INIT_ERROR =
  /\b(?:NoClassDefFoundError|ClassNotFoundException|UnsatisfiedLinkError|NoSuchMethodError|ExceptionInInitializerError)\b|Cannot install Expo Modules/;
const JS_TAGS = new Set(["ReactNativeJS", "AndroidRuntime"]);
/** A Java linkage error passed to JavaScript (Expo Modules "native call failed: …"). */
const NATIVE_BINARY_MISMATCH = /\b(?:java\.lang\.)?(NoSuchMethodError|NoClassDefFoundError)\b/;

interface NativeCause {
  /** Line indices: the native error and up to three "Caused by" lines from the same process. */
  lines: number[];
  message: string;
  /** A missing class from the Java standard library (java.* / javax.*). */
  javaClass?: string;
}

/**
 * The first native initialization error logged before `before` by the same process (when both
 * lines have a pid). It explains a later "Cannot find native module" error.
 */
export function earlierNativeError(
  log: ParsedLog,
  before: number,
  pid: string | undefined,
): NativeCause | undefined {
  const lines = log.doc.lines;
  for (let i = 0; i < Math.min(before, lines.length); i++) {
    const entry = stripLogcatPrefix(lines[i]!);
    if (entry.tag && JS_TAGS.has(entry.tag)) continue;
    if (pid && entry.pid && entry.pid !== pid) continue;
    if (!NATIVE_INIT_ERROR.test(entry.message)) continue;
    const picked = [i];
    for (let j = i + 1; j < Math.min(before, i + 12) && picked.length < 4; j++) {
      const next = stripLogcatPrefix(lines[j]!);
      if (pid && next.pid && next.pid !== pid) continue;
      if (/^\s*Caused by:/.test(next.message)) picked.push(j);
    }
    const all = picked.map((k) => stripLogcatPrefix(lines[k]!).message).join(" ");
    const javaClass =
      /(?:NoClassDefFoundError|ClassNotFoundException)[^"]*?(?:L|")?((?:java|javax)[./][\w./$]+?)[;"]/.exec(
        all,
      )?.[1];
    return {
      lines: picked,
      message: entry.message.trim().slice(0, 200),
      ...(javaClass ? { javaClass: javaClass.replace(/\//g, ".") } : {}),
    };
  }
  return undefined;
}

/** Next steps for a native error that left a native module unavailable. */
function nativeCauseSteps(native: NativeCause): string[] {
  return [
    "Start from the earlier native error and its 'Caused by' lines (shown as evidence), not the JavaScript error.",
    ...(native.javaClass
      ? [
          `The missing class ${native.javaClass} is part of the Java standard library, so this device's Android version probably doesn't provide it. Check the device's Android version (\`adb shell getprop ro.build.version.sdk\`) and run the same build on a newer one. If it fails only on older versions, the library that uses the class doesn't support them: raise minSdkVersion to drop them, or wait for a fix in that library.`,
        ]
      : []),
    "Search the issues of the library named in the native stack trace for the error text.",
  ];
}

interface ExceptionGroup {
  primary: JsException;
  followOns: JsException[];
}

/** Groups follow-on errors under the earlier exception from the same process. */
export function groupJsExceptions(exceptions: JsException[]): ExceptionGroup[] {
  const groups: ExceptionGroup[] = [];
  for (const ex of exceptions) {
    const owner = FOLLOW_ON.some((p) => p.test(ex.message))
      ? [...groups].reverse().find((g) => !g.primary.pid || !ex.pid || g.primary.pid === ex.pid)
      : undefined;
    if (owner) owner.followOns.push(ex);
    else groups.push({ primary: ex, followOns: [] });
  }
  return groups;
}

/**
 * Evidence for an exception: only lines from the same thread (or process, when the log has no thread
 * ids) when the log is an interleaved logcat.
 */
function exceptionEvidence(log: ParsedLog, ex: JsException, detail?: string): Evidence {
  if (ex.lines?.length) {
    const note = ex.tid
      ? `Only lines from thread ${ex.tid} of process ${ex.pid} are shown`
      : `Only lines from process ${ex.pid} are shown`;
    return logEvidenceLines(log.doc, ex.lines, detail ? `${detail}; ${note}` : note);
  }
  return logEvidence(log.doc, ex, detail);
}

export const javascriptException: Rule = {
  meta: {
    id: "runtime.javascript-exception",
    title: "JavaScript exception at runtime",
    platforms: ["javascript"],
    scope: "log",
    trigger:
      "A JavaScript error surfaced through a React Native runtime channel: logcat ReactNativeJS, JavascriptException, RCTFatal/'Unhandled JS Exception', Metro console ERROR, or uncaught errors.",
    evidence:
      "The exception line, the channel it came through, and the first stack frame when present.",
    versionScope: "React Native (all versions)",
    references: [
      "https://reactnative.dev/docs/debugging-release-builds",
      "https://docs.expo.dev/debugging/runtime-issues/",
    ],
    lastVerified: "2026-10-25",
    fixtures: [
      "logs/runtime-android-js-exception.log",
      "logs/real-logcat-js-startup-crash.log",
      "logs/logcat-native-module-init-failed.log",
      "logs/expo-go-cannot-find-native-module.log",
      "logs/logcat-native-call-nosuchmethod.log",
      "projects/expo-native-module-missing",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { primary: ex, followOns } of groupJsExceptions(log.runtime.jsExceptions).slice(
        0,
        MAX_PER_LOG,
      )) {
        // Diagnosed by runtime.hermes-bytecode-mismatch.
        if (HERMES_BYTECODE.test(ex.message)) continue;
        const nativeCause = NATIVE_MODULE_MISSING.test(ex.message)
          ? earlierNativeError(log, ex.start, ex.pid)
          : undefined;
        const minified =
          ex.firstFrame &&
          /index\.android\.bundle|main\.jsbundle|^\s*\w@\d+:\d+/.test(ex.firstFrame);
        const missing = NATIVE_MODULE_MISSING.exec(ex.message);
        const moduleName = missing ? (missing[1] ?? missing[2]) : undefined;
        // Without an earlier native error, find which installed package asks for the module.
        const owner =
          moduleName && !nativeCause && ctx.project
            ? findNativeModuleOwner(ctx.project, moduleName)
            : undefined;
        const expoGo = log.doc.lines.some((l) => /\bExpo Go\b|exp:\/\//.test(l));
        // "native call failed: java.lang.NoSuchMethodError: … "Lexpo/modules/haptics/HapticsModule;…"
        const binary = NATIVE_BINARY_MISMATCH.exec(ex.message);
        const nativeClass = binary
          ? /"L([\w/$]+);/.exec(ex.message)?.[1]?.replace(/\//g, ".")
          : undefined;
        const evidence: Evidence[] = [
          exceptionEvidence(
            log,
            ex,
            [
              ex.firstFrame && `First stack frame: ${ex.firstFrame}`,
              ex.component && `Thrown while rendering <${ex.component}> (React component stack)`,
            ]
              .filter(Boolean)
              .join("; ") || undefined,
          ),
          ...followOns.map((f) =>
            logEvidenceLines(
              log.doc,
              [f.start],
              `Follow-on error caused by the first one: ${f.type}: ${f.message.slice(0, 160)}`,
            ),
          ),
          ...(nativeCause
            ? [
                logEvidenceLines(
                  log.doc,
                  nativeCause.lines,
                  "Native error logged earlier by the same process",
                ),
              ]
            : []),
          ...(ex.termination
            ? [
                logEvidenceLines(
                  log.doc,
                  [ex.termination.index],
                  `The process was then killed by ${ex.termination.signal}${ex.termination.thread ? ` on thread ${ex.termination.thread}` : ""}`,
                ),
              ]
            : []),
          ...(owner
            ? [
                {
                  source: "project" as const,
                  file: owner.file,
                  line: owner.line,
                  excerpt: owner.excerpt,
                  detail: `${owner.pkg}${owner.version ? `@${owner.version}` : ""} requests the native module ${moduleName}`,
                },
              ]
            : []),
        ];
        out.push(
          finding(this.meta, {
            title: `${ex.type}: ${ex.message.length > 120 ? `${ex.message.slice(0, 117)}…` : ex.message}`,
            severity: "error",
            confidence: "high",
            explanation:
              `The app reported a JavaScript ${ex.type} (via ${ex.channel}). This finding confirms the exception, not its root cause.` +
              (nativeCause
                ? ` Native code failed earlier in the same process ("${nativeCause.message}"), which is the likely reason the native module isn't available: fix that error first.`
                : "") +
              (ex.termination
                ? ` The exception wasn't caught, and the app crashed: the process was killed by ${ex.termination.signal}${ex.termination.thread ? ` on its JavaScript thread (${ex.termination.thread})` : ""}. The native crash that follows in the log is a consequence of this exception, not a separate native bug.`
                : "") +
              (followOns.length
                ? ` ${followOns.length} later error${followOns.length === 1 ? "" : "s"} (such as "${followOns[0]!.message.slice(0, 80)}") ${followOns.length === 1 ? "is a consequence" : "are consequences"} of this one: once the bundle fails to run, React Native can't register or start the app. ${followOns.length === 1 ? "It's" : "They're"} listed as evidence here instead of as separate findings.`
                : "") +
              (minified
                ? " The stack trace points into a minified release bundle and needs source maps to map back to your code."
                : "") +
              (moduleName && !nativeCause
                ? ` JavaScript asked for the native module '${moduleName}'${owner ? ` (requested by ${owner.pkg}${owner.version ? ` ${owner.version}` : ""}, which is installed)` : ""}, and the native app that's running doesn't register it. The JavaScript side is there; the native build isn't: the app was built before the package was installed, it runs in a prebuilt client such as Expo Go that doesn't include the module, or the native and JavaScript versions don't match.${expoGo ? " The log mentions Expo Go." : ""}`
                : "") +
              (binary
                ? ` The message is a Java ${binary[1]} passed through to JavaScript${nativeClass ? `, for ${nativeClass}` : ""}: native code calls a method or class that the compiled binary doesn't have. That happens when a native module was compiled against a different version of the library it calls (for Expo modules, expo-modules-core), for example a prebuilt or cached native build from an older version.`
                : ""),
            evidence,
            nextSteps: [
              ...(nativeCause ? nativeCauseSteps(nativeCause) : []),
              ...(moduleName && !nativeCause
                ? [
                    `Rebuild the native app after installing ${owner?.pkg ?? "the package"} (\`npx expo run:android\` / \`npx expo run:ios\`, \`npx react-native run-android\` / \`run-ios\`, or a new EAS build). Reloading JavaScript isn't enough.`,
                    "Expo Go only contains the native modules it ships and registers. If the app runs in Expo Go, use a development build instead (`npx expo install expo-dev-client`, then `npx expo run:android` or `eas build --profile development`).",
                    "Check that native package versions match the Expo SDK or React Native version: `npx expo install --check` in Expo projects.",
                    "With an ios/ folder, run `cd ios && pod install` after installing native packages.",
                  ]
                : []),
              ...(binary
                ? [
                    "Align native package versions (`npx expo install --check`, then `npx expo install --fix` in Expo projects) so modules and their core library come from the same release.",
                    "Rebuild from clean native state: `cd android && ./gradlew clean` (or delete android/app/build), and for EAS `eas build --clear-cache`, so no prebuilt or cached native module from an older version is reused.",
                  ]
                : []),
              ...(/^Network request failed\b/.test(ex.message)
                ? [
                    "This message comes from React Native's networking layer and hides the cause: the server is unreachable from the device, DNS or TLS failed, or (Android release builds) the URL uses http://, which Android blocks by default. Check the URL the request uses and open it in the device's browser.",
                    ...(ctx.project
                      ? []
                      : [
                          "Run this tool from the project folder (or with --cwd) so it can check whether release builds block http:// URLs used in the app.",
                        ]),
                  ]
                : []),
              ...(minified
                ? [
                    "Symbolicate the stack trace with the source map from the same release build (see React Native 'Debugging release builds').",
                  ]
                : moduleName || binary
                  ? []
                  : ex.firstFrame
                    ? [`Start at the first stack frame: ${ex.firstFrame}.`]
                    : /^Network request failed\b/.test(ex.message) || nativeCause
                      ? []
                      : [
                          `Search your source for the message text ("${ex.message.slice(0, 60)}") to find where it's thrown.`,
                        ]),
              ...(moduleName && !nativeCause
                ? []
                : [
                    "If it happens only in release builds, reproduce with a local release build (`npx expo run:android --variant release` / `npx react-native run-android --mode release`, or the iOS equivalents).",
                    "Compare the configuration and environment variables of the failing build with the working one.",
                  ]),
            ],
            limitations: [
              "A runtime log shows what failed, not why. The cause has to be confirmed in code or configuration.",
            ],
          }),
        );
      }
    }
    return out;
  },
};

const CONFIG_MESSAGE = [
  /\b(EXPO_PUBLIC_[A-Z0-9_]+|REACT_APP_[A-Z0-9_]+|REACT_NATIVE_[A-Z0-9_]+)\b/,
  /\b(\w*(?:url|uri|key|token|dsn|endpoint|host|projectid|config|secret|apikey|api_key))\b[^.]{0,30}\b(?:is required|is missing|must be (?:provided|set|defined|specified)|not (?:set|defined|provided|configured|specified)|is undefined|cannot be (?:empty|undefined|null))/i,
  /\b(?:missing|no|invalid)\s+(?:required\s+)?(?:[A-Z]\w+\s+)?(api[ _-]?key|credentials?|url|endpoint|env(?:ironment)? variable|configuration|config)\b/i,
];

export const missingConfigurationSuspected: Rule = {
  meta: {
    id: "runtime.missing-configuration-suspected",
    title: "Runtime error mentions missing configuration",
    platforms: ["javascript", "expo"],
    scope: "log",
    trigger:
      "A runtime JavaScript exception whose message names an EXPO_PUBLIC_/REACT_APP_ variable or says a URL, key, token, endpoint, or config value is required, missing, or undefined.",
    evidence: "The exception message and the configuration term it mentions.",
    versionScope: "Expo SDK 49+ (EXPO_PUBLIC_ variables); React Native (all versions)",
    references: [
      "https://docs.expo.dev/guides/environment-variables/",
      "https://docs.expo.dev/eas/environment-variables/",
      ...EAS_UPDATE_ENV.sources,
    ],
    lastVerified: EAS_UPDATE_ENV.lastVerified,
    fixtures: [
      "logs/runtime-missing-supabase-url.log",
      "logs/runtime-missing-supabase-credentials.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const { primary: ex } of groupJsExceptions(log.runtime.jsExceptions).slice(
        0,
        MAX_PER_LOG,
      )) {
        const match = CONFIG_MESSAGE.map((p) => p.exec(ex.message)).find(Boolean);
        if (!match) continue;
        out.push(
          finding(this.meta, {
            title: `Exception suggests a missing configuration value (${match[1] ?? match[0]})`,
            severity: "warning",
            confidence: "medium",
            explanation: `The exception message "${ex.message}" says a configuration value is absent at runtime. A common cause is a value that exists in development (.env, local shell) but not in the production or release build environment. This is a hypothesis based on the message. The build's environment wasn't inspected.`,
            platforms: ctx.project?.kind === "expo" ? ["javascript", "expo"] : ["javascript"],
            evidence: [exceptionEvidence(log, ex, `Configuration term: ${match[1] ?? match[0]}`)],
            nextSteps:
              ctx.project?.kind === "react-native-cli"
                ? [
                    `Find where ${match[1] ?? "the value"} is supposed to come from (search the source for it): a .env file read by a library such as react-native-config or a Babel plugin, a config file, or a native build setting.`,
                    "Check that the source exists for this build: .env files are often git-ignored, so CI and other machines don't have them.",
                    "Values read from .env at build time are compiled into the app. Rebuild the app after changing them; reloading JavaScript isn't always enough.",
                  ]
                : [
                    "Run `rn-build-doctor scan` in the project to list environment variables the code references and where they're defined locally.",
                    "For EAS builds, check the environment used by the build profile: `eas env:list --environment production` and the `env`/`environment` fields in eas.json.",
                    "Remember that EXPO_PUBLIC_ variables are inlined at build time. Changing them requires a new build or update, not just a restart.",
                    `If the failing JavaScript came from an EAS Update: from SDK ${EAS_UPDATE_ENV.requiredFromSdk}, \`eas update --environment <env>\` uses only that EAS environment's variables (not .env files, and not a build profile's env in eas.json). Check \`eas env:list --environment <env>\`, then publish again with \`--clear\` so Metro doesn't reuse cached transforms.`,
                  ],
            verification:
              "Build again with the value defined for that environment, and confirm the exception no longer occurs at startup.",
            limitations: [
              ctx.project?.kind === "react-native-cli"
                ? "This tool doesn't know how this app loads configuration, and can't see values stored in CI."
                : "Local scanning can't see variables stored in EAS or another CI service.",
            ],
          }),
        );
      }
    }
    return out;
  },
};

/** A java.* / javax.* class the runtime couldn't load (missing on this Android version). */
function missingJavaClass(exception: string, text: string): string | undefined {
  if (!/NoClassDefFoundError|ClassNotFoundException/.test(`${exception} ${text}`)) return undefined;
  return /(?:Failed resolution of: L|Didn't find class "|NoClassDefFoundError: |ClassNotFoundException: )((?:java|javax)[/.][\w/.$]+?)[;"\s]/
    .exec(`${text} `)?.[1]
    ?.replace(/\//g, ".");
}

/** Exceptions that only wrap the error that caused them. */
function isWrapperException(exception: string, message: string): boolean {
  return (
    /^java\.lang\.(?:ExceptionInInitializerError|reflect\.InvocationTargetException)$/.test(
      exception,
    ) ||
    (exception === "java.lang.RuntimeException" &&
      /^Unable to (?:start activity|create application|get provider|instantiate)/.test(message))
  );
}

/** Frames from Android, Java, Kotlin, and React Native internals, which rarely hold the bug. */
const FRAMEWORK_FRAME =
  /^(?:android|androidx|java|javax|kotlin|kotlinx|dalvik|libcore|sun|jdk|com\.android|com\.google\.android|com\.facebook\.(?:react|hermes|jni|soloader|fbreact|yoga)|okhttp3|okio)\./;

/** The first `at pkg.Class.method(File.kt:42)` frame of a fatal exception outside framework code. */
function firstAppFrame(
  log: ParsedLog,
  fatal: { start: number; end: number },
): { index: number; frame: string; location: string; method: string } | undefined {
  for (let i = fatal.start; i <= fatal.end; i++) {
    const text = stripLogcatPrefix(log.doc.lines[i]!).message.trim();
    const m = /^at ([\w.$<>]+)\(([^)]+:\d+)\)/.exec(text);
    // Obfuscated R8 names (`t6.m`) need the mapping file before they point anywhere.
    const obfuscated = /^[A-Za-z]{1,3}\d*(?:\.[A-Za-z$]{1,3}\d*)+$/.test(m?.[1] ?? "");
    if (m && !FRAMEWORK_FRAME.test(m[1]!) && !obfuscated)
      return { index: i, frame: `${m[1]}(${m[2]})`, location: m[2]!, method: m[1]! };
  }
  return undefined;
}

export const androidFatalException: Rule = {
  meta: {
    id: "runtime.android-fatal-exception",
    title: "Android app crashed with a fatal exception",
    platforms: ["android"],
    scope: "log",
    trigger: "Logcat 'FATAL EXCEPTION' block from AndroidRuntime.",
    evidence: "The exception class, message, process, and 'Caused by' chain.",
    versionScope: "Android (all versions)",
    references: [
      "https://developer.android.com/studio/debug/logcat",
      "https://reactnative.dev/docs/signed-apk-android",
    ],
    lastVerified: "2026-10-25",
    fixtures: [
      "logs/runtime-android-unable-to-load-script.log",
      "logs/runtime-android-js-exception.log",
      "logs/logcat-fatal-native-module-init-failed.log",
      "logs/logcat-fatal-npe-app-frame.log",
      "logs/logcat-fatal-wrapped-soloader.log",
      "logs/studio-logcat-fatal-npe.log",
      "logs/expo-issue-android7-java-time.log",
      "logs/rn-issue-trimmed-logcat-websocket.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const fatal of log.runtime.androidFatals.slice(0, MAX_PER_LOG)) {
        const all = [fatal.message, ...fatal.causes].join(" ");
        // Diagnosed by android.r8-removed-constructor.
        if ([fatal.message, ...fatal.causes].some((c) => REFLECTIVE_CONSTRUCTOR.test(c))) continue;
        const evidence: Evidence[] = [
          logEvidence(
            log.doc,
            fatal,
            `${fatal.exception}${fatal.process ? ` in ${fatal.process}` : ""}`,
          ),
        ];
        // Wrapper exceptions say nothing on their own; the deepest "Caused by" is the real error.
        const deepest = fatal.causes.at(-1);
        const wrapped = deepest !== undefined && isWrapperException(fatal.exception, fatal.message);
        const shown = wrapped
          ? {
              exception: deepest.split(":")[0]!,
              message: deepest.slice(deepest.indexOf(":") + 1).trim(),
            }
          : { exception: fatal.exception, message: fatal.message };
        const shownMessage = shown.message === shown.exception ? "" : shown.message;
        const appFrame = firstAppFrame(log, fatal);
        if (appFrame)
          evidence.push({
            source: "log",
            file: log.doc.path,
            line: lineNumber(log.doc, appFrame.index),
            detail: `First frame outside Android, Java, Kotlin and React Native: ${appFrame.frame}`,
          });
        let title = `Fatal ${shown.exception.split(".").pop()}${shownMessage ? `: ${shownMessage.slice(0, 100)}` : ""}${wrapped ? ` (inside ${fatal.exception.split(".").pop()})` : ""}`;
        let explanation =
          `The app process${fatal.process ? ` ${fatal.process}` : ""} crashed with ${fatal.exception}.` +
          (wrapped
            ? ` That exception only wraps another one; the deepest cause is ${deepest}.`
            : "") +
          " The log identifies the exception but not, by itself, the cause.";
        let confidence: DraftFinding["confidence"] = "low";
        let references: string[] | undefined;
        let nextSteps = [
          ...(appFrame
            ? [
                `Look here first: ${appFrame.location} (${appFrame.method}), the first stack frame outside Android, Java, Kotlin and React Native code.`,
              ]
            : []),
          "Read the full stack trace and the first 'Caused by' entry. The deepest cause is usually the most specific.",
          "Reproduce with a local release build while capturing `adb logcat`. If the process already died, `adb logcat -b crash -d` prints the crash buffer, which keeps recent crashes.",
        ];
        if (/Unable to load script/.test(all)) {
          title = "Release build tried to load JavaScript from Metro instead of the bundled file";
          confidence = "high";
          explanation =
            "React Native reported 'Unable to load script'. The app looked for a JavaScript bundle and found none packaged in the APK, so it fell back to a Metro dev server that isn't running. This happens when the bundle wasn't generated for this variant, or when a debug build runs without Metro.";
          nextSteps = [
            "If this is a debug build, start Metro (`npx react-native start` / `npx expo start`) and run `adb reverse tcp:8081 tcp:8081` for a USB device.",
            "For release builds, confirm the createBundle<Variant>JsAndAssets task ran and assets/index.android.bundle is in the APK (`unzip -l app-release.apk | grep bundle`).",
          ];
        } else if (missingJavaClass(fatal.exception, all)) {
          const cls = missingJavaClass(fatal.exception, all)!;
          const javaTime = cls.startsWith("java.time.");
          title = `${cls} isn't available on this device's Android version`;
          confidence = "medium";
          explanation =
            `The app crashed because ${cls}, a Java standard library class, doesn't exist on the device: Android only includes the Java APIs of its own API level.` +
            (javaTime
              ? ` java.time was added in API ${JAVA_TIME_API.addedInApi} (Android 8.0), so it's missing on Android 7 and older.`
              : "") +
            (appFrame
              ? ` The first code outside the framework that uses it is ${appFrame.frame}.`
              : "") +
            " The app's minSdkVersion allows this device, so the code using the class needs a fallback, or the app needs a higher minSdkVersion.";
          nextSteps = [
            ...(appFrame
              ? [`Look at ${appFrame.location} (${appFrame.method}): it uses ${cls}.`]
              : []),
            "If that code is in a library, check its issues for the crash on older Android versions and update it; if no fix exists, raising minSdkVersion drops the affected devices.",
            ...(javaTime
              ? [
                  "If it's your code, either guard it with a `Build.VERSION.SDK_INT >= 26` check or use an older API, or enable core library desugaring (coreLibraryDesugaringEnabled), which provides much of java.time on older versions.",
                ]
              : []),
            "Check the device's API level with `adb shell getprop ro.build.version.sdk` and test on the oldest version minSdkVersion allows.",
          ];
          references = JAVA_TIME_API.sources;
        } else if (
          /UnsatisfiedLinkError/.test(fatal.exception + all) &&
          /couldn't find DSO to load|lib\w+\.so/.test(all)
        ) {
          const lib = /(lib[\w-]+\.so)/.exec(all)?.[1];
          title = `Native library ${lib ?? ""} could not be loaded`.replace("  ", " ");
          confidence = "medium";
          explanation = `The app couldn't load the native library ${lib ?? "named in the log"}. Possible causes: the library wasn't packaged for this device's ABI, the JavaScript engine settings (for example hermesEnabled) don't match the dependencies, or native dependencies are out of sync.`;
          nextSteps = [
            "Check that the APK contains the library for the device ABI (`unzip -l app.apk | grep <lib>`).",
            "Check hermesEnabled in android/gradle.properties and any abiFilters/splits settings.",
            "Clean and rebuild native code (`cd android && ./gradlew clean`).",
          ];
        } else if (/JavascriptException/.test(fatal.exception)) {
          const missing = NATIVE_MODULE_MISSING.exec(fatal.message);
          const moduleName = missing?.[1] ?? missing?.[2];
          const native = missing
            ? earlierNativeError(
                log,
                fatal.start,
                stripLogcatPrefix(log.doc.lines[fatal.start]!).pid,
              )
            : undefined;
          if (native) {
            title = `Native module '${moduleName}' wasn't available because native code failed earlier`;
            confidence = "medium";
            evidence.push(
              logEvidenceLines(log.doc, native.lines, "Native error logged before the crash"),
            );
            explanation =
              `The crash is a JavaScript error ("${fatal.message.split(",")[0]?.slice(0, 100) ?? ""}"), but it's a consequence. Earlier in the log, the same process failed in native code: "${native.message}". When native module setup fails, JavaScript can't find the module, and the failure only surfaces as a JavaScript error.` +
              "";
            nextSteps = nativeCauseSteps(native);
          } else if (missing) {
            title = `JavaScript couldn't find native module '${moduleName}'`;
            confidence = "medium";
            explanation = `JavaScript asked for the native module '${moduleName}', and this build doesn't provide it. Common causes: the package was installed after the native app was built, the app runs in Expo Go or another prebuilt client that doesn't include the module, or the module failed to initialize (no native error was found earlier in this log, but it may have been logged before the capture started).`;
            nextSteps = [
              "Rebuild the native app after installing the package (`npx expo run:android`, `npx react-native run-android`, or a new EAS build). Reloading JavaScript isn't enough.",
              "Expo Go only contains the native modules it ships and registers. If the app runs in Expo Go, use a development build instead (`npx expo install expo-dev-client`, then `npx expo run:android` or `eas build --profile development`).",
              "Check that native package versions match the Expo SDK or React Native version: `npx expo install --check` in Expo projects.",
              "Capture logcat from app launch (`adb logcat -c` before starting the app) to see whether native code logged an error first.",
            ];
          } else {
            title = `JavaScript error crashed the app: ${fatal.message.split(",")[0]?.slice(0, 100) ?? ""}`;
            confidence = "high";
            explanation =
              "A JavaScript exception was thrown and React Native turned it into a fatal native crash. The cause is in JavaScript. See the JavaScript exception finding.";
          }
        }
        out.push(
          finding(this.meta, {
            title,
            severity: "error",
            confidence,
            explanation,
            evidence,
            nextSteps,
            ...(references ? { references: [...this.meta.references, ...references] } : {}),
          }),
        );
      }
    }
    return out;
  },
};

const PRIVACY =
  /attempted to access privacy-sensitive data without a usage description\.\s*The app's Info\.plist must contain an? (\w+) key/;

export const iosCrash: Rule = {
  meta: {
    id: "runtime.ios-crash",
    title: "iOS app crash report",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "An iOS crash report (text or .ips), an uncaught NSException, or the system message about privacy-sensitive data without a usage description.",
    evidence:
      "Exception type, signal, termination reason, NSException reason, and top backtrace frames.",
    versionScope: "iOS 15+ (.ips) and legacy text crash reports",
    references: [
      "https://developer.apple.com/documentation/xcode/diagnosing-issues-using-crash-reports-and-device-logs",
      "https://developer.apple.com/documentation/bundleresources/information-property-list",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/ios-crash-rctfatal.crash", "logs/ios-privacy-usage.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const privacyIndex = log.doc.lines.findIndex((l) => PRIVACY.test(l));
      if (privacyIndex >= 0) {
        const key = PRIVACY.exec(log.doc.lines[privacyIndex]!)![1]!;
        out.push(
          finding(this.meta, {
            title: `Missing Info.plist usage description: ${key}`,
            severity: "error",
            confidence: "high",
            explanation: `iOS terminated the app because it accessed a protected resource without the ${key} entry in Info.plist. The system message states this directly.`,
            evidence: [logEvidence(log.doc, { start: privacyIndex, end: privacyIndex })],
            nextSteps: [
              `Add ${key} with a user-facing explanation. Expo: set it under ios.infoPlist in app config (or through the relevant library's config plugin), then rebuild. React Native CLI: add it to ios/<App>/Info.plist.`,
            ],
            verification:
              "Rebuild and trigger the same feature. The permission prompt should appear instead of a crash.",
          }),
        );
      }
      // Diagnosed by ios.uiscene-lifecycle-required.
      const noScene = log.doc.lines.some((l) => NO_SCENE_LIFECYCLE.test(l));
      for (const crash of log.runtime.iosCrashes.slice(0, noScene ? 0 : MAX_PER_LOG)) {
        const rctFatal = crash.frames.some((f) =>
          /RCTFatal|RCTExceptionsManager|facebook::react::.*JSError/.test(f),
        );
        const evidence: Evidence[] = [logEvidence(log.doc, crash)];
        if (crash.exceptionType)
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `Exception type: ${crash.exceptionType}`,
          });
        if (crash.terminationReason)
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `Termination: ${crash.terminationReason}`,
          });
        if (crash.nsException)
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `${crash.nsException.name}: ${crash.nsException.reason}`,
          });
        if (crash.frames.length)
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `Top frames: ${crash.frames.slice(0, 5).join(" | ")}`,
          });
        const signature = crash.nsException
          ? `${crash.nsException.name}: ${crash.nsException.reason.slice(0, 100)}`
          : (crash.exceptionType ?? "unknown exception");
        out.push(
          finding(this.meta, {
            title: rctFatal
              ? "JavaScript fatal error crashed the iOS app (RCTFatal)"
              : `iOS crash: ${signature}`,
            severity: "error",
            confidence: rctFatal ? "medium" : "low",
            explanation: rctFatal
              ? "The crashing backtrace goes through RCTFatal, which React Native uses to turn an unhandled JavaScript error into a native crash. The JavaScript error message is in the device log (console output), not in the crash report."
              : `The crash report shows ${signature}. This tool doesn't map this signature to a specific cause. The signature is shown so it can be investigated.`,
            evidence,
            nextSteps: rctFatal
              ? [
                  "Collect the device console log around the crash time (Console.app or `xcrun simctl spawn booted log stream`) to find the 'Unhandled JS Exception' message.",
                  "Run `rn-build-doctor analyze` on that log for the JavaScript exception.",
                ]
              : [
                  "Symbolicate the crash report with the matching dSYM (Xcode Organizer or `atos`).",
                  "Look at the first frames that belong to your app or a library to identify the failing component.",
                ],
            limitations: [
              "Unsymbolicated frames and missing console output limit what can be established from a crash report alone.",
            ],
          }),
        );
      }
    }
    return out;
  },
};

export const jsBundleNotLoaded: Rule = {
  meta: {
    id: "runtime.js-bundle-not-loaded",
    title: "The app couldn't load its JavaScript bundle",
    platforms: ["android", "ios", "javascript"],
    scope: "log",
    trigger:
      "A device log with 'Unable to load script' (Android, including the New Architecture's non-fatal handleHostException), 'No bundle URL present' or 'No script URL provided' (iOS), or 'Could not connect to development server', when no fatal exception for it is reported.",
    evidence:
      "The bundle-loading error from the app's process and, when present, the line saying the packager (Metro) couldn't be reached.",
    versionScope: "React Native (all versions); New Architecture red screen since 0.76",
    references: [
      "https://reactnative.dev/docs/running-on-device",
      "https://reactnative.dev/docs/signed-apk-android",
    ],
    lastVerified: "2026-10-15",
    fixtures: ["logs/real-logcat-metro-not-running.log", "logs/ios-no-script-url.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const failure = log.runtime.bundleLoadFailures[0];
      if (!failure) continue;
      // The fatal-exception rule already explains "Unable to load script" crashes.
      if (
        log.runtime.androidFatals.some((f) =>
          /Unable to load script/.test([f.message, ...f.causes].join(" ")),
        )
      )
        continue;
      const evidence: Evidence[] = [
        failure.lines?.length
          ? logEvidenceLines(
              log.doc,
              failure.lines,
              `Only lines from process ${failure.pid} are shown`,
            )
          : logEvidence(log.doc, failure),
      ];
      const unreachable = failure.packagerUnreachableIndex;
      // RCTBridge/RCTHost wording on iOS: the app got no URL at all, not an unreachable one.
      const noUrl = /No (?:bundle|script) URL/.test(failure.message);
      if (unreachable !== undefined)
        evidence.push(
          logEvidenceLines(log.doc, [unreachable], "Metro (the packager) was not reachable"),
        );
      out.push(
        finding(this.meta, {
          title:
            unreachable !== undefined
              ? "The app couldn't reach Metro to load its JavaScript bundle"
              : this.meta.title,
          severity: "error",
          confidence: unreachable !== undefined ? "high" : "medium",
          explanation:
            "The app started, but React Native found no JavaScript to run: " +
            (unreachable !== undefined
              ? "it's a debug build, which loads JavaScript from the Metro dev server, and Metro wasn't reachable from the device."
              : noUrl
                ? "the app had no URL to load JavaScript from. In a debug build that means bundleURL() returned nothing (Metro couldn't be found, or the Debug branch didn't run); in a release build, main.jsbundle wasn't embedded."
                : "either a debug build couldn't reach Metro, or a release build doesn't contain the bundled JavaScript.") +
            " The app shows a red error screen instead of crashing, so nothing appears as a fatal exception.",
          evidence,
          nextSteps: noUrl
            ? [
                "Start Metro in the project folder (`npx react-native start`, or `npx expo start` for Expo) and keep it running, then reload the app.",
                "On a physical iPhone, the phone and the computer must be on the same network, and the app must be allowed to reach it (Settings > Privacy & Security > Local Network). Open http://<computer-ip>:8081/status in the phone's browser: it should say packager-status:running.",
                "If Metro is reachable, check bundleURL() in the AppDelegate (or the React Native factory delegate): in Debug builds it has to return the Metro URL from RCTBundleURLProvider, and only Release builds should return main.jsbundle. A scheme that builds the Release configuration, or an AppDelegate migration that changed the #if DEBUG branch, gives this error.",
                "If this is a release build, the bundle wasn't embedded: check that the 'Bundle React Native code and images' phase ran and main.jsbundle is in the .app.",
              ]
            : [
                "Start Metro in the project folder (`npx react-native start`, or `npx expo start` for Expo) and keep it running, then reload the app.",
                "On a USB-connected Android device, run `adb reverse tcp:8081 tcp:8081`. On Wi-Fi, set the dev server address in the dev menu to your computer's IP and port 8081, on the same network.",
                "If this is a release build, the bundle wasn't packaged: check that createBundleReleaseJsAndAssets ran (Android) or the 'Bundle React Native code and images' phase ran (iOS).",
              ],
          verification:
            "Reload the app. It shows your first screen instead of the red error screen.",
        }),
      );
    }
    return out;
  },
};

export const hermesBytecodeMismatch: Rule = {
  meta: {
    id: "runtime.hermes-bytecode-mismatch",
    title: "The JavaScript bundle was compiled by a different Hermes version",
    platforms: ["javascript"],
    scope: "log",
    trigger:
      "Hermes 'Compiling JS failed: Wrong bytecode version. Expected N but got M' at app start.",
    evidence:
      "The error line with both bytecode versions, and with the project, the React Native version and whether expo-updates is installed.",
    versionScope: "Hermes (React Native 0.70+), including over-the-air updates",
    references: [
      "https://github.com/react/react-native/issues/57917",
      "https://reactnative.dev/docs/hermes",
      "https://docs.expo.dev/eas-update/runtime-versions/",
    ],
    lastVerified: "2026-10-25",
    fixtures: ["logs/rn-issue-hermes-bytecode-mismatch.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const index = log.doc.lines.findIndex((l) => HERMES_BYTECODE.test(l));
      if (index < 0) continue;
      const [, expected, got] = HERMES_BYTECODE.exec(log.doc.lines[index]!)!;
      const ota = ctx.project?.installedVersion("expo-updates");
      const rn = ctx.project?.versions["react-native"];
      const evidence: Evidence[] = [logEvidence(log.doc, { start: index, end: index })];
      if (rn) evidence.push({ source: "project", detail: `react-native: ${rn}` });
      if (ota) evidence.push({ source: "project", detail: `expo-updates: installed ${ota}` });
      out.push(
        finding(this.meta, {
          title: `Hermes can't run the bundle: compiled as bytecode ${got}, the app expects ${expected}`,
          severity: "error",
          confidence: "high",
          explanation:
            `The app's Hermes runtime reads bytecode version ${expected}, but the JavaScript bundle was compiled to version ${got}, so it fails before any JavaScript runs. The bundle and the app come from different Hermes versions: for example a bundle compiled by another React Native version's hermesc, a stale prebuilt bundle, or an over-the-air update built for a different app binary.` +
            (Number(got) < Number(expected)
              ? " The bundle is older than the runtime."
              : " The bundle is newer than the runtime."),
          evidence,
          nextSteps: [
            "Rebuild the app and its bundle together from a clean state (delete ios/build or android/app/build), so both use the hermesc that ships with the installed React Native.",
            ...(ota
              ? [
                  "If the crash started after an update was downloaded, the update was built for a different native build: check the runtimeVersion policy so updates only reach binaries built from the same React Native version, and roll back the update.",
                ]
              : []),
            "If you build with a custom toolchain (Swift Package Manager, a CI cache, a vendored hermesc), check which hermesc compiled the bundle (the Hermes release and HBC bytecode version it prints) against the Hermes runtime the app links (react/react-native#57917).",
          ],
          verification: "The app starts and runs the bundle without the bytecode error.",
        }),
      );
    }
    return out;
  },
};

export const runtimeRules: Rule[] = [
  jsBundleNotLoaded,
  javascriptException,
  missingConfigurationSuspected,
  androidFatalException,
  iosCrash,
  hermesBytecodeMismatch,
];
