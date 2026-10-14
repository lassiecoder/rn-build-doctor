import { finding, type Rule } from "../../engine/rule.js";
import { logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

const VERIFIED = "2026-10-14";
const MAX_PER_LOG = 3;

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
    lastVerified: VERIFIED,
    fixtures: ["logs/runtime-android-js-exception.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const ex of log.runtime.jsExceptions.slice(0, MAX_PER_LOG)) {
        const minified =
          ex.firstFrame &&
          /index\.android\.bundle|main\.jsbundle|^\s*\w@\d+:\d+/.test(ex.firstFrame);
        out.push(
          finding(this.meta, {
            title: `${ex.type}: ${ex.message.length > 120 ? `${ex.message.slice(0, 117)}…` : ex.message}`,
            severity: "error",
            confidence: "high",
            explanation:
              `The app reported a JavaScript ${ex.type} (via ${ex.channel}). This finding confirms the exception, not its root cause.` +
              (minified
                ? " The stack trace points into a minified release bundle and needs source maps to map back to your code."
                : ""),
            evidence: [
              logEvidence(
                log.doc,
                ex,
                [
                  ex.firstFrame && `First stack frame: ${ex.firstFrame}`,
                  ex.component &&
                    `Thrown while rendering <${ex.component}> (React component stack)`,
                ]
                  .filter(Boolean)
                  .join("; ") || undefined,
              ),
            ],
            nextSteps: [
              ...(minified
                ? [
                    "Symbolicate the stack trace with the source map from the same release build (see React Native 'Debugging release builds').",
                  ]
                : []),
              "Reproduce in a local release build (`npx expo run:android --variant release` / `npx react-native run-android --mode release`, or the iOS equivalents).",
              "Compare the configuration and environment variables of the failing build with the working one.",
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
  /\b(?:missing|no|invalid)\s+(?:required\s+)?(api[ _-]?key|url|endpoint|env(?:ironment)? variable|configuration|config)\b/i,
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
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/runtime-missing-supabase-url.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const ex of log.runtime.jsExceptions.slice(0, MAX_PER_LOG)) {
        const match = CONFIG_MESSAGE.map((p) => p.exec(ex.message)).find(Boolean);
        if (!match) continue;
        out.push(
          finding(this.meta, {
            title: `Exception suggests a missing configuration value (${match[1] ?? match[0]})`,
            severity: "warning",
            confidence: "medium",
            explanation: `The exception message "${ex.message}" says a configuration value is absent at runtime. A common cause is a value that exists in development (.env, local shell) but not in the production or release build environment. This is a hypothesis based on the message. The build's environment wasn't inspected.`,
            evidence: [logEvidence(log.doc, ex, `Configuration term: ${match[1] ?? match[0]}`)],
            nextSteps: [
              "Run `rn-build-doctor scan` in the project to list environment variables the code references and where they're defined locally.",
              "For EAS builds, check the environment used by the build profile: `eas env:list --environment production` and the `env`/`environment` fields in eas.json.",
              "Remember that EXPO_PUBLIC_ variables are inlined at build time. Changing them requires a new build or update, not just a restart.",
            ],
            verification:
              "Build again with the value defined for that environment, and confirm the exception no longer occurs at startup.",
            limitations: [
              "Local scanning can't see variables stored in EAS or another CI service.",
            ],
          }),
        );
      }
    }
    return out;
  },
};

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
    lastVerified: VERIFIED,
    fixtures: [
      "logs/runtime-android-unable-to-load-script.log",
      "logs/runtime-android-js-exception.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const fatal of log.runtime.androidFatals.slice(0, MAX_PER_LOG)) {
        const all = [fatal.message, ...fatal.causes].join(" ");
        const evidence: Evidence[] = [
          logEvidence(
            log.doc,
            fatal,
            `${fatal.exception}${fatal.process ? ` in ${fatal.process}` : ""}`,
          ),
        ];
        let title = `Fatal ${fatal.exception.split(".").pop()}${fatal.message ? `: ${fatal.message.slice(0, 100)}` : ""}`;
        let explanation = `The app process${fatal.process ? ` ${fatal.process}` : ""} crashed with ${fatal.exception}. The log identifies the exception but not, by itself, the cause.`;
        let confidence: DraftFinding["confidence"] = "low";
        let nextSteps = [
          "Read the full stack trace and the first 'Caused by' entry. The deepest cause is usually the most specific.",
          "Reproduce with a local release build while capturing `adb logcat`.",
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
          title = `JavaScript error crashed the app: ${fatal.message.split(",")[0]?.slice(0, 100) ?? ""}`;
          confidence = "high";
          explanation =
            "A JavaScript exception was thrown and React Native turned it into a fatal native crash. The cause is in JavaScript. See the JavaScript exception finding.";
        }
        out.push(
          finding(this.meta, {
            title,
            severity: "error",
            confidence,
            explanation,
            evidence,
            nextSteps,
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
      for (const crash of log.runtime.iosCrashes.slice(0, MAX_PER_LOG)) {
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

export const runtimeRules: Rule[] = [
  javascriptException,
  missingConfigurationSuspected,
  androidFatalException,
  iosCrash,
];
