import { readdirSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";
import semver from "semver";
import {
  finding,
  sentence,
  type Rule,
  type RuleContext,
  type RuleMeta,
} from "../../engine/rule.js";
import type { ParsedLog } from "../../parsers/index.js";
import type { XcodeError } from "../../parsers/xcode.js";
import { compareVersions } from "../android/compat.js";
import {
  EXPO_AUTOLINKING_FRAMEWORK_HEADERS,
  EXPO_JSI_XCODE27_ARCHIVE,
  EXPO_SDK_MIN_XCODE,
  EXPO_SWIFT_PACK_SYMBOLS,
  IOS27_UISCENE,
  RN_NAMESPACED_HEADERS,
  XCODE27_DEVICEHUB,
  XCODE272_SIMULATOR_ID,
} from "./compat.js";
import { findLine, readJsonFile, readProjectFile } from "../../collectors/project-files.js";
import { logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

const VERIFIED = "2026-10-14";
const COCOAPODS_REFS = [
  "https://guides.cocoapods.org/using/pod-install-vs-update.html",
  "https://guides.cocoapods.org/using/troubleshooting.html",
];

export const cocoapodsIncompatibleVersions: Rule = {
  meta: {
    id: "ios.cocoapods-incompatible-versions",
    title: "CocoaPods could not find compatible versions for a pod",
    platforms: ["ios"],
    scope: "log",
    trigger: "CocoaPods output '[!] CocoaPods could not find compatible versions for pod \"X\"'.",
    evidence:
      "The CocoaPods error with the conflicting requirements (Podfile, Podfile.lock, dependents).",
    versionScope: "CocoaPods 1.x",
    references: COCOAPODS_REFS,
    lastVerified: VERIFIED,
    fixtures: ["logs/ios-cocoapods-incompatible.log", "logs/real-cocoapods-no-such-version.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const error of log.cocoapods.errors) {
        const pod = /CocoaPods could not find compatible versions for pod "([^"]+)"/.exec(
          error.message,
        )?.[1];
        if (!pod) continue;
        const context = log.doc.lines.slice(error.start, error.end + 1).join("\n");
        const deploymentTarget = /required a higher minimum deployment target/.test(context);
        const snapshot = /In snapshot \(Podfile\.lock\)/.test(context);
        // A single requirement (no comma-separated list) that no spec satisfies: the version doesn't
        // exist, and nothing conflicts.
        const unsatisfiable =
          /None of your spec sources contain a spec satisfying the dependency: `([^`]+)`/.exec(
            context,
          )?.[1];
        const missingVersion = unsatisfiable !== undefined && !unsatisfiable.includes(",");
        const evidence: Evidence[] = [logEvidence(log.doc, error)];
        const target = ctx.project?.versions["ios deployment target (Podfile)"];
        if (target)
          evidence.push({
            source: "project",
            file: "ios/Podfile",
            detail: `platform :ios, '${target}'`,
          });
        out.push(
          finding(this.meta, {
            title: missingVersion
              ? `CocoaPods found no version of "${pod}" matching ${unsatisfiable}`
              : `CocoaPods could not find compatible versions for pod "${pod}"`,
            severity: "error",
            confidence: "high",
            explanation:
              (missingVersion
                ? `No version of ${pod} matching ${unsatisfiable} exists in the spec sources this machine knows about. Nothing else conflicts: either the version doesn't exist, or the local spec repo is out of date.`
                : `The version requirements for ${pod} conflict, so CocoaPods can't pick a version.`) +
              (deploymentTarget
                ? " CocoaPods also reported that matching versions exist but need a higher minimum iOS deployment target than this project declares."
                : "") +
              (snapshot
                ? " One requirement comes from Podfile.lock, so the locked version may conflict with an upgraded dependency."
                : ""),
            evidence,
            nextSteps: [
              ...(deploymentTarget
                ? [
                    "Raise the iOS deployment target (`platform :ios` in ios/Podfile, or `ios.deploymentTarget` via expo-build-properties) to the version the pod requires.",
                  ]
                : []),
              ...(snapshot
                ? [
                    `Run \`cd ios && pod update ${pod}\` to move the locked version, rather than deleting Podfile.lock.`,
                  ]
                : []),
              "Update the local spec repo with `cd ios && pod install --repo-update`.",
              ...(missingVersion
                ? [
                    `Check that ${unsatisfiable} is a published version (\`pod trunk info ${pod}\` or the pod's releases), and fix the version in the Podfile or in the podspec that requires it.`,
                  ]
                : [
                    "Check that the JavaScript packages that bring in the pod are on versions compatible with your React Native or Expo SDK.",
                  ]),
            ],
            verification: "`cd ios && pod install` completes without errors.",
          }),
        );
      }
    }
    return out;
  },
};

export const cocoapodsSpecNotFound: Rule = {
  meta: {
    id: "ios.cocoapods-spec-not-found",
    title: "CocoaPods could not find a pod specification",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "CocoaPods output '[!] Unable to find a specification for `X`', including Expo CLI's relayed form ('Command `pod install` failed.' / '└─ Cause: Unable to find a specification for …', or 'Couldn't install: A » B').",
    evidence: "The CocoaPods error naming the pod and its dependent.",
    versionScope: "CocoaPods 1.x",
    references: COCOAPODS_REFS,
    lastVerified: VERIFIED,
    fixtures: [
      "logs/ios-cocoapods-spec-not-found.log",
      "logs/expo-cli-pod-install-spec-not-found.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const error of log.cocoapods.errors) {
        // CocoaPods' own wording, or Expo CLI's summary of it ("Couldn't install: Expo » ExpoModulesCore").
        const pods =
          /Unable to find a specification for [`'"]([^`'"]+)[`'"](?:\s+depended upon by [`'"]([^`'"]+)[`'"])?/.exec(
            error.message,
          );
        const expo = pods
          ? null
          : /^Couldn't install: (\S+) » (\S+?)\.?(?:\s|$)/.exec(error.message);
        // [pod, the pod that depends on it]
        const m = pods
          ? [pods[0], pods[1], pods[2]]
          : expo
            ? [expo[0], expo[2], expo[1]]
            : undefined;
        if (!m) continue;
        out.push(
          finding(this.meta, {
            title: `No pod specification found for ${m[1]}${m[2] ? ` (required by ${m[2]})` : ""}`,
            severity: "error",
            confidence: "high",
            explanation: `CocoaPods couldn't find a podspec for ${m[1]} in any configured source. Possible causes: the local spec repo is out of date, the version doesn't exist, the name is misspelled, or the pod lives in a private spec repository that the Podfile doesn't declare.`,
            evidence: [logEvidence(log.doc, error)],
            nextSteps: [
              "Run `cd ios && pod install --repo-update`.",
              `Check that ${m[1]} and the requested version exist (\`pod search\` or the package's documentation).`,
              "If it comes from a private spec repo, add that `source` line to the Podfile.",
            ],
            verification: "`cd ios && pod install` completes.",
          }),
        );
      }
    }
    return out;
  },
};

const SIGNING_PATTERNS: [
  RegExp,
  (m: RegExpExecArray) => { title: string; explanation: string; steps: string[] },
][] = [
  [
    /Signing for "([^"]+)" requires a development team/,
    (m) => ({
      title: `Signing for "${m[1]}" requires a development team`,
      explanation: `The target ${m[1]} has no DEVELOPMENT_TEAM set, so Xcode can't sign it.`,
      steps: [
        "In Xcode, select the target > Signing & Capabilities and choose a team, or pass DEVELOPMENT_TEAM to xcodebuild.",
        "For Expo/EAS, let EAS manage credentials (`eas credentials`) or set ios.appleTeamId.",
      ],
    }),
  ],
  [
    /No profiles for '([^']+)' were found/,
    (m) => ({
      title: `No provisioning profile found for ${m[1]}`,
      explanation: `Xcode couldn't find a provisioning profile matching the bundle identifier ${m[1]} for this signing configuration.`,
      steps: [
        "Check that the bundle identifier matches an App ID in your Apple Developer account.",
        "Enable automatic signing with -allowProvisioningUpdates, or download or create the profile manually.",
        "For EAS builds, run `eas credentials` to inspect or regenerate the profile.",
      ],
    }),
  ],
  [
    /No signing certificate "([^"]+)" found/,
    (m) => ({
      title: `Signing certificate "${m[1]}" not found`,
      explanation: `The keychain used for this build doesn't contain a valid "${m[1]}" certificate with its private key.`,
      steps: [
        "Install the certificate and its private key in the build machine's keychain, or let Xcode or EAS manage certificates.",
        "Check that the certificate hasn't expired or been revoked.",
      ],
    }),
  ],
  [
    /Provisioning profile "([^"]+)" (?:doesn't|does not) (include|support|match)[^.]*(?:\.|$)/,
    (m) => ({
      title: `Provisioning profile "${m[1]}" doesn't match the build`,
      explanation: `The provisioning profile ${m[1]} doesn't ${m[2]} what this build needs, for example the signing certificate, an entitlement or capability, or the device.`,
      steps: [
        "Regenerate the profile after adding the missing capability or certificate in the Apple Developer portal.",
        "For EAS builds, run `eas credentials` to sync capabilities and profiles.",
      ],
    }),
  ],
];

export const codeSigning: Rule = {
  meta: {
    id: "ios.code-signing",
    title: "iOS code signing failed",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "Xcode errors 'Signing for \"X\" requires a development team', 'No profiles for ... were found', 'No signing certificate ... found', or 'Provisioning profile ... doesn't include/match'.",
    evidence: "The signing error line naming the target, profile, or certificate.",
    versionScope: "Xcode 14+",
    references: [
      "https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases",
      "https://docs.expo.dev/app-signing/app-credentials/",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/ios-signing-team.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const seen = new Set<string>();
      for (let i = 0; i < log.doc.lines.length; i++) {
        for (const [pattern, describe] of SIGNING_PATTERNS) {
          const m = pattern.exec(log.doc.lines[i]!);
          if (!m || seen.has(m[0])) continue;
          seen.add(m[0]);
          const d = describe(m);
          out.push(
            finding(this.meta, {
              title: d.title,
              severity: "error",
              confidence: "high",
              explanation: d.explanation,
              evidence: [logEvidence(log.doc, { start: i, end: i })],
              nextSteps: d.steps,
              verification: "The archive or build step completes code signing.",
            }),
          );
        }
      }
    }
    return out;
  },
};

function isSigningMessage(message: string): boolean {
  return SIGNING_PATTERNS.some(([p]) => p.test(message));
}

/** Xcode errors that another rule diagnoses, which ios.compile-error must not claim. */
function handledElsewhere(message: string): boolean {
  return (
    isSigningMessage(message) ||
    /deployment target '\w+' is set to [\d.]+, but the range/.test(message)
  );
}

/** React Native version from the project: installed, or the lowest version the declared range allows. */
function reactNativeVersion(ctx: RuleContext): string | undefined {
  const versions = ctx.project?.versions;
  if (!versions) return undefined;
  if (versions["react-native"]) return versions["react-native"];
  const declared = versions["react-native (declared)"];
  if (!declared || !semver.validRange(declared)) return undefined;
  return semver.minVersion(declared)?.version;
}

/** Package that owns a source file under node_modules (`@scope/name` or `name`). */
function packageOfFile(file: string): string | undefined {
  return /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
}

/** Source files Xcode compiles; other `file:line:col: error:` lines (TypeScript, scripts) aren't Xcode's. */
const APPLE_SOURCE = /\.(?:swift|m|mm|h|hh|hpp|c|cc|cpp|cxx|modulemap)$/;
/** Xcode's `(in target 'EXUpdates' from project 'Pods')` suffix. */
const IN_TARGET = /\s*\(in target '([^']+)' from project '([^']+)'\)\s*$/;

/** The dependency a compiler error belongs to: npm package, or pod target/folder. */
function dependencyOfError(e: XcodeError): string | undefined {
  if (e.file) {
    const pkg = packageOfFile(e.file.replace(/\\/g, "/"));
    if (pkg) return pkg;
    const pod = /\/Pods\/(?!Headers\/)([^/]+)\//.exec(e.file)?.[1];
    if (pod) return pod;
  }
  const target = IN_TARGET.exec(e.message);
  return target && target[2] === "Pods" ? target[1] : undefined;
}

export const nativeCompileError: Rule = {
  meta: {
    id: "ios.compile-error",
    title: "Native iOS compilation error",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "Clang/Swift diagnostics '<file>:<line>:<col>: error: <message>' in an Xcode build log (or in a pasted excerpt naming an Apple source file), or a bare 'error: …' with Xcode's '(in target 'X' from project 'Pods')' suffix.",
    evidence:
      "The first compiler errors with file and position, and the dependency (npm package or pod) that owns the file with its installed version. For a React Native header ('RCT*.h') not found on React Native 0.87+, the React Native version. For a 'React/…' header in Expo SDK 56/57, the installed expo-modules-autolinking version and ios.useFrameworks. The Xcode version printed in the log, compared with the Expo SDK's minimum.",
    versionScope:
      "Xcode 14+; header namespacing in React Native 0.87+; expo-modules-autolinking 56.x/57.x framework headers; Expo SDK 56-58 minimum Xcode",
    references: [
      "https://reactnative.dev/docs/integration-with-existing-apps",
      "https://guides.cocoapods.org/using/using-cocoapods.html",
      RN_NAMESPACED_HEADERS.source,
      ...EXPO_AUTOLINKING_FRAMEWORK_HEADERS.sources,
      ...EXPO_SDK_MIN_XCODE.sources,
    ],
    lastVerified: EXPO_SDK_MIN_XCODE.lastVerified,
    fixtures: [
      "logs/ios-header-not-found.log",
      "logs/real-rn087-ios-unnamespaced-header.log",
      "logs/real-xcode26-pod-swift-compile-error.log",
      "logs/expo-issue-react-header-framework-wrapped.log",
      "logs/expo-issue-react-header-fatal-wrapped.log",
      "logs/expo-issue-jsi-xcode263.log",
      "logs/expo-issue-swift-error-no-column.log",
      "projects/expo57-framework-headers",
      "projects/rn088-ios-pods",
      "logs/expo-cli-targeted-compile-error.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      // Excerpts pasted without xcodebuild's markers still count when they name Apple source files.
      const located = log.xcode.errors.filter(
        (e) =>
          e.file &&
          !handledElsewhere(e.message) &&
          (log.xcode.detected || APPLE_SOURCE.test(e.file)),
      );
      const targeted = log.xcode.detected
        ? log.xcode.errors.filter(
            (e) => !e.file && IN_TARGET.test(e.message) && !handledElsewhere(e.message),
          )
        : [];
      const errors = located.length ? located : targeted;
      if (!errors.length) continue;
      const first = errors[0]!;
      const firstMessage = first.message.replace(IN_TARGET, "").replace(/\.\s*$/, "");
      const targetName = IN_TARGET.exec(first.message)?.[1];
      // Where the first error is: its file, or the target Xcode names when there's no file.
      const firstWhere = first.file ?? (targetName ? `the target ${targetName}` : "the build");
      const dependency = dependencyOfError(first);
      const header = /'([^']+\.h)' file not found/.exec(first.message);
      const module = /(?:no such module|module) '([^']+)'(?: not found)?/i.exec(first.message);

      // React Native 0.87 resolves its headers only with their namespace (<React/RCTBridge.h>).
      const bareRnHeader = header && /^RCT\w*\.h$/.test(header[1]!) ? header[1]! : undefined;
      if (bareRnHeader) {
        const rn = reactNativeVersion(ctx);
        const rnNamespaced = rn
          ? compareVersions(rn, RN_NAMESPACED_HEADERS.minReactNative) >= 0
          : undefined;
        const headersFramework = log.doc.lines.findIndex((l) => /ReactNativeHeaders/.test(l));
        if (rnNamespaced === true || (rnNamespaced === undefined && headersFramework >= 0)) {
          out.push(
            namespacedHeaderFinding(this.meta, log, errors, bareRnHeader, rn, headersFramework),
          );
          continue;
        }
      }

      // Expo autolinking bugs that broke React headers for pods built as frameworks.
      if (header && /^React(?:-\w+)?\//.test(header[1]!)) {
        const expoHeaders = expoFrameworkHeadersFinding(this.meta, ctx, log, errors, header[1]!);
        if (expoHeaders) {
          out.push(expoHeaders);
          continue;
        }
      }

      const evidence: Evidence[] = errors
        .slice(0, 5)
        .map((e) => logEvidence(log.doc, e, e.file ? `${e.file}:${e.position}` : undefined));
      const npmPackage = packageOfFile((first.file ?? "").replace(/\\/g, "/"));
      const installed = npmPackage ? ctx.project?.installedVersion(npmPackage) : undefined;
      if (npmPackage && installed)
        evidence.push({ source: "project", detail: `${npmPackage}: installed ${installed}` });
      // "Xcode 26.3", "xcode-26.6" (EAS image names), "Xcode: 26.3/17C529" (expo-env-info).
      const xcode = /\bxcode(?:[ -]|:\s*)(\d+\.\d+(?:\.\d+)?)\b/i.exec(
        log.doc.lines.find((l) => /\bxcode(?:[ -]|:\s*)\d+\.\d+/i.test(l)) ?? "",
      )?.[1];
      // Expo SDKs document a minimum Xcode; older ones fail to compile Expo's Swift sources.
      const expoVersion = ctx.project?.installedVersion("expo");
      const sdk = expoVersion && semver.valid(expoVersion) ? semver.major(expoVersion) : undefined;
      const minXcode = sdk !== undefined ? EXPO_SDK_MIN_XCODE.table[sdk] : undefined;
      const xcodeTooOld = xcode && minXcode ? compareVersions(xcode, minXcode) < 0 : false;
      if (xcodeTooOld)
        evidence.push({
          source: "project",
          detail: `Expo SDK ${sdk} requires Xcode ${minXcode}+; the log shows Xcode ${xcode}`,
        });
      out.push(
        finding(this.meta, {
          title: header
            ? `Header '${header[1]}' not found`
            : module
              ? `Swift module '${module[1]}' not found`
              : dependency
                ? `Compiler error in ${dependency}: ${firstMessage}`
                : `Xcode error${targetName ? ` in ${targetName}` : ""}: ${firstMessage}`,
          severity: "error",
          confidence: header || module ? "medium" : "high",
          explanation:
            header || module
              ? `The compiler couldn't find ${header ? `the header ${header[1]}` : `the module ${module![1]}`} while compiling ${first.file ?? dependency ?? "a source file"}. This usually means the pods are out of sync with node_modules, the build opened the .xcodeproj instead of the .xcworkspace, or the native module that provides it isn't installed or linked.`
              : dependency
                ? (xcodeTooOld
                    ? `This build uses Xcode ${xcode}, and Expo SDK ${sdk} requires Xcode ${minXcode} or later: older Xcode versions can't compile its Swift sources. `
                    : "") +
                  `Xcode reported ${errors.length} compiler error${errors.length === 1 ? "" : "s"}. The first is in ${first.file ?? `the target ${dependency}`}, which belongs to the dependency ${dependency}${installed ? ` (installed ${installed})` : ""}, not to your app code: ${sentence(firstMessage)} A compile error inside a dependency usually means that version doesn't support this Xcode (Swift compiler) or React Native version, so the fix is a different version of ${dependency}, not a change in your app.${xcode ? ` This build uses Xcode ${xcode}.` : ""}`
                : `Xcode reported ${errors.length} error${errors.length === 1 ? "" : "s"}. The first is in ${firstWhere}: ${sentence(firstMessage)}`,
          evidence,
          nextSteps:
            header || module
              ? [
                  "Reinstall pods: `cd ios && pod install` (Expo: `npx expo prebuild` or `npx pod-install`).",
                  "Build the .xcworkspace, not the .xcodeproj.",
                  "Check that the JavaScript package that provides the native module is installed and compatible with your React Native version.",
                  ...(header && /^React(?:-\w+)?\//.test(header[1]!) && !ctx.project
                    ? [
                        `In an Expo SDK 56 or 57 project whose pods are built as frameworks (useFrameworks), this is a known expo-modules-autolinking bug, fixed in ${EXPO_AUTOLINKING_FRAMEWORK_HEADERS.fixedIn[57]}. Run this tool with --cwd pointing at the project so it can check the installed version.`,
                      ]
                    : []),
                  ...(bareRnHeader && !reactNativeVersion(ctx)
                    ? [
                        `If the project uses React Native ${RN_NAMESPACED_HEADERS.minReactNative.replace(/\.0$/, "")} or later, React Native headers must be imported with their namespace: \`#import <React/${bareRnHeader}>\`. Run this tool with --cwd pointing at the project so it can check the version.`,
                      ]
                    : []),
                ]
              : dependency
                ? [
                    ...(xcodeTooOld
                      ? [
                          `Update Xcode to ${minXcode} or later (Expo SDK ${sdk}'s minimum), then clean the build folder and build again. On EAS, pick a build image with Xcode ${minXcode}+ in eas.json (ios.image).`,
                        ]
                      : []),
                    `Upgrade ${dependency} to a release that supports your Xcode and React Native versions. Search its issues for the error text ("${firstMessage.slice(0, 60)}")${xcode ? ` together with "Xcode ${xcode}"` : ""}: errors like this are usually reported within days of a new Xcode.`,
                    ...(xcodeTooOld
                      ? []
                      : [
                          `If no fixed release exists yet, build with the previous Xcode version (\`xcodes\` or the Xcode releases page), or patch the file with patch-package until ${dependency} is fixed.`,
                        ]),
                    ...(packageOfFile(first.file ?? "")
                      ? []
                      : [
                          "Then reinstall pods (`cd ios && pod install`, or `npx expo prebuild --clean` in an Expo project) so the new version is compiled.",
                        ]),
                  ]
                : first.file
                  ? [
                      `Open ${first.file} at ${first.position} and fix the reported error.`,
                      "If the file is inside Pods or node_modules, check whether that library version supports your React Native and Xcode versions.",
                    ]
                  : [
                      `Fix the error reported for ${firstWhere}. Xcode's Report navigator (or the full xcodebuild log) shows the command that produced it.`,
                      "If the target was added by a config plugin or a library, check whether a newer version of it fixes the error.",
                    ],
          verification: "The Xcode build compiles the affected file.",
        }),
      );
    }
    return out;
  },
};

/**
 * A React header not found in an Expo SDK 56/57 project whose expo-modules-autolinking predates the
 * framework-header fixes. Undefined when the installed version is fixed or unknown.
 */
function expoFrameworkHeadersFinding(
  meta: RuleMeta,
  ctx: RuleContext,
  log: ParsedLog,
  errors: XcodeError[],
  header: string,
): DraftFinding | undefined {
  const version = ctx.project?.installedVersion("expo-modules-autolinking");
  if (!version || !semver.valid(version)) return undefined;
  const facts = EXPO_AUTOLINKING_FRAMEWORK_HEADERS;
  const major = semver.major(version);
  const fixed = facts.fixedIn[major];
  const partial = facts.partialFixIn[major];
  const beforeFix = fixed !== undefined && semver.lt(version, fixed);
  if (!beforeFix && partial === undefined) return undefined;
  const props = readJsonFile<Record<string, unknown>>(
    ctx.project!.root,
    "ios/Podfile.properties.json",
  );
  const useFrameworks = props.ok ? props.value["ios.useFrameworks"] : undefined;
  const evidence: Evidence[] = [
    ...errors
      .slice(0, 3)
      .map((e) => logEvidence(log.doc, e, e.file ? `${e.file}:${e.position}` : undefined)),
    { source: "project", detail: `expo-modules-autolinking: installed ${version}` },
  ];
  if (typeof useFrameworks === "string")
    evidence.push({
      source: "project",
      file: "ios/Podfile.properties.json",
      detail: `ios.useFrameworks: ${useFrameworks}`,
    });
  const fix = fixed
    ? `Update to expo-modules-autolinking ${fixed} or later: update expo to the latest SDK ${major} patch (\`npx expo install expo@^${major}.0.0\`, then \`npx expo install --fix\`), and run \`npx expo prebuild --clean\`.`
    : `Update to expo-modules-autolinking ${partial} or later (the latest SDK ${major} patch of expo). That fixes the linkage guard; the header-search-path fix (expo/expo#48665) isn't in any ${major}.x release up to ${facts.checkedThrough[major]}, so if the error remains, apply its one-line change to node_modules/expo-modules-autolinking/scripts/ios/precompiled_modules.rb with patch-package, or upgrade to a newer SDK.`;
  return finding(meta, {
    title: `'${header}' not found: expo-modules-autolinking ${version} breaks React headers for pods built as frameworks`,
    severity: "error",
    confidence: typeof useFrameworks === "string" ? "high" : "medium",
    explanation:
      `expo-modules-autolinking ${version} has a known bug in its precompiled-modules hook that changes how pods built as frameworks (\`useFrameworks\`) find React Native's headers, so '${header}' isn't found${dependencyOfError(errors[0]!) ? ` in ${dependencyOfError(errors[0]!)}` : ""}. ` +
      (beforeFix
        ? `It's fixed in ${fixed}.`
        : `${partial} fixes part of it; the rest isn't in a published ${major}.x release.`) +
      (typeof useFrameworks === "string"
        ? ` This project builds pods as ${useFrameworks} frameworks.`
        : " Check whether the project sets useFrameworks (expo-build-properties ios.useFrameworks); the bug only affects that setup.") +
      " Reinstalling pods doesn't help until the package is updated.",
    evidence,
    references: facts.sources,
    nextSteps: [
      fix,
      "To confirm the cause without upgrading, run `pod install` with EXPO_USE_PRECOMPILED_MODULES=0: the hook only runs when the variable is 1 (EAS Build sets it to 1 for SDKs that support precompiled modules).",
    ],
    verification: "`pod install` and the Xcode build compile the target without the header error.",
  });
}

function namespacedHeaderFinding(
  meta: RuleMeta,
  log: ParsedLog,
  errors: XcodeError[],
  header: string,
  rn: string | undefined,
  headersFrameworkIndex: number,
): DraftFinding {
  const notFound = errors.filter((e) => /'RCT\w*\.h' file not found/.test(e.message));
  // xcodebuild repeats each error per architecture; keep one entry per file and position.
  const unique = [...new Map(notFound.map((e) => [`${e.file}:${e.position}`, e])).values()];
  const packages = [
    ...new Set(unique.map((e) => packageOfFile(e.file!)).filter(Boolean)),
  ] as string[];
  const headers = [...new Set(unique.map((e) => /'(RCT\w*\.h)'/.exec(e.message)![1]!))];
  const evidence: Evidence[] = unique
    .slice(0, 5)
    .map((e) => logEvidence(log.doc, { start: e.start, end: e.start }, `${e.file}:${e.position}`));
  if (rn) evidence.push({ source: "project", detail: `react-native: ${rn}` });
  else
    evidence.push({
      source: "log",
      file: log.doc.path,
      line: headersFrameworkIndex + 1,
      detail:
        "The build uses ReactNativeHeaders (React Native 0.87+ header-only XCFramework); the project wasn't available to confirm the version",
    });
  const owner = packages.length ? packages.join(", ") : undefined;
  const v = RN_NAMESPACED_HEADERS.minReactNative.replace(/\.0$/, "");
  return finding(meta, {
    title: `React Native ${v} header imported without its namespace: '${header}'${owner ? ` in ${owner}` : ""}`,
    severity: "error",
    confidence: rn ? "high" : "medium",
    explanation:
      `Since React Native ${v}, React Native's iOS headers ship in header-only XCFrameworks and resolve only with their namespace. ` +
      `${unique.length === 1 ? "A file" : `${unique.length} files`}${owner ? ` in ${owner}` : ""} import${unique.length === 1 ? "s" : ""} ${headers.map((h) => `'${h}'`).join(", ")} without the 'React/' prefix (as "${header}" or <${header}>), so the compiler can't find ${headers.length === 1 ? "it" : "them"}. ` +
      "Reinstalling pods doesn't change this; the import itself has to change.",
    evidence,
    nextSteps: [
      `Change the import to the namespaced form: \`#import <React/${header}>\`${unique[0] ? ` (first at ${unique[0].file}:${unique[0].position})` : ""}.`,
      owner
        ? `${owner} is a dependency: update it to a release that supports React Native ${v}. Until one exists, patch the imports with patch-package so the change survives reinstalls.`
        : "If the file belongs to a dependency, update it to a release that supports this React Native version, or patch it with patch-package.",
      `Search the same package for other bare imports (\`#import "RCT\` and \`#import <RCT\`); the build stops at the first files it compiles.`,
    ],
    verification: "`pod install` and the Xcode build compile the affected files.",
  });
}

export const linkerError: Rule = {
  meta: {
    id: "ios.linker-error",
    title: "iOS linker error",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "Linker output: 'Undefined symbols for architecture', 'ld: library not found for -lX' / 'ld: library 'X' not found' (Xcode 15+), or the framework equivalents.",
    evidence: "The linker error lines and the missing symbol or library.",
    versionScope: "Xcode 14+",
    references: ["https://guides.cocoapods.org/using/troubleshooting.html"],
    lastVerified: VERIFIED,
    fixtures: ["logs/ios-linker.log", "logs/real-xcode26-linker-library-not-found.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      if (!log.xcode.detected) continue;
      const errors = log.xcode.errors.filter((e) =>
        /Undefined symbols? for architecture|ld: (?:library|framework) not found|^ld: /.test(
          e.message,
        ),
      );
      if (!errors.length) continue;
      const text = errors.map((e) => e.message).join("\n");
      // ld64 (Xcode 14 and earlier): `ld: library not found for -lFoo`, `ld: framework not found Foo`.
      // ld-prime (Xcode 15+): `ld: library 'Foo' not found`, `ld: framework 'Foo' not found`.
      const missingMatch =
        /ld: (library|framework) '([^']+)' not found/.exec(text) ??
        /ld: (library) not found for -l(\S+)/.exec(text) ??
        /ld: (framework) not found (\S+)/.exec(text);
      const kind = missingMatch?.[1] as "library" | "framework" | undefined;
      const missing = missingMatch?.[2];
      const symbol = log.doc.lines
        .slice(errors[0]!.start, errors[0]!.start + 12)
        .map((l) => /^\s*"([^"]+)", referenced from:/.exec(l)?.[1])
        .find(Boolean);
      const fromPods = missing !== undefined && /^Pods[-_]/.test(missing);
      const evidence = errors.slice(0, 3).map((e) => logEvidence(log.doc, e));
      if (missing) {
        out.push(
          finding(this.meta, {
            title: `Linker could not find ${kind} '${missing}'`,
            severity: "error",
            confidence: "high",
            explanation: fromPods
              ? `The app target links ${missing}, which CocoaPods generates. It wasn't built, which usually means the build opened the .xcodeproj instead of the .xcworkspace, or pods weren't installed for this checkout.`
              : `The link step was told to link the ${kind} '${missing}' (\`${kind === "library" ? `-l${missing}` : `-framework ${missing}`}\`), but no ${kind} with that name exists in the search paths. Either the flag is stale (left in OTHER_LDFLAGS, an .xcconfig, or a podspec after a library was removed), or the library that provides it isn't installed or built.`,
            evidence,
            nextSteps: fromPods
              ? [
                  "Build the .xcworkspace, not the .xcodeproj.",
                  "Run `cd ios && pod install` (Expo: `npx pod-install` or `npx expo prebuild`).",
                ]
              : [
                  `Find where the flag comes from: \`grep -rn "${missing}" ios --include=*.pbxproj --include=*.xcconfig --include=*.podspec\` and check Other Linker Flags in the target's Build Settings.`,
                  `If a dependency should provide '${missing}', check that it's installed and that \`cd ios && pod install\` ran after adding it. If nothing should, remove the stale flag.`,
                ],
            verification: "The link step succeeds.",
          }),
        );
        continue;
      }
      out.push(
        finding(this.meta, {
          title: symbol
            ? `Undefined symbol ${symbol} while linking`
            : "Undefined symbols while linking",
          severity: "error",
          confidence: "medium",
          explanation:
            "Linking failed after compilation" +
            (symbol ? `: nothing provides ${symbol}.` : ".") +
            " Possible causes: a native library that isn't installed or linked, a pod built for a different architecture, or mixed static and dynamic framework settings. The log alone doesn't show which.",
          evidence,
          nextSteps: [
            "Reinstall pods (`cd ios && pod deintegrate && pod install`) and clean the build folder.",
            "Check `use_frameworks!` settings against what the failing library documents.",
            "If you build on Apple silicon for the simulator, check the EXCLUDED_ARCHS settings in the Podfile and project.",
          ],
          verification: "The link step succeeds.",
        }),
      );
    }
    return out;
  },
};

function bundlePhaseFailed(log: ParsedLog): number {
  const fromList = log.xcode.failedCommands.find((c) =>
    /PhaseScriptExecution Bundle\\? React\\? Native/.test(c.command),
  );
  if (fromList) return fromList.index;
  return log.doc.lines.findIndex(
    (l) =>
      /PhaseScriptExecution.*Bundle\\? React\\? Native code and images/.test(l) && /fail/i.test(l),
  );
}

export const bundlePhaseFailedRule: Rule = {
  meta: {
    id: "ios.bundle-phase-failed",
    title: "The 'Bundle React Native code and images' build phase failed",
    platforms: ["ios", "javascript"],
    scope: "log",
    trigger:
      "Xcode lists the 'Bundle React Native code and images' PhaseScriptExecution as failed, or the script reports it can't find the node binary.",
    evidence:
      "The failed build phase and, when present, the bundler or node error printed by the script.",
    versionScope: "React Native 0.69+ (.xcode.env NODE_BINARY)",
    references: [
      "https://reactnative.dev/docs/environment-setup",
      "https://metrobundler.dev/docs/troubleshooting",
    ],
    lastVerified: VERIFIED,
    fixtures: ["logs/ios-node-binary.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const nodeIndex = log.doc.lines.findIndex((l) =>
        /Can't find the '.+' binary to build the React Native bundle|NODE_BINARY.*(?:not found|No such file)/.test(
          l,
        ),
      );
      const phaseIndex = bundlePhaseFailed(log);
      if (nodeIndex < 0 && phaseIndex < 0) continue;
      const metroErrors = log.metro.events.filter((e) => e.kind !== "bundling-failed");
      const evidence: Evidence[] = [];
      if (nodeIndex >= 0)
        evidence.push(logEvidence(log.doc, { start: nodeIndex, end: nodeIndex + 2 }));
      if (phaseIndex >= 0)
        evidence.push(logEvidence(log.doc, { start: phaseIndex, end: phaseIndex }));
      const node = nodeIndex >= 0;
      out.push(
        finding(this.meta, {
          title: node
            ? "Xcode couldn't find Node.js to bundle JavaScript"
            : metroErrors.length
              ? "JavaScript bundling failed in Xcode; the Metro error is reported separately"
              : this.meta.title,
          severity: "error",
          confidence: node || metroErrors.length ? "high" : "low",
          explanation: node
            ? "The React Native bundling script couldn't run node. Xcode doesn't inherit your shell's PATH. Version managers such as nvm, fnm, asdf, or volta install node in locations Xcode doesn't search."
            : metroErrors.length
              ? "The build phase failed because Metro couldn't build the bundle. Fix the Metro error first."
              : "The bundling build phase failed, and the log doesn't contain the script's error output. The phase failure alone doesn't identify the cause.",
          evidence,
          nextSteps: node
            ? [
                "Set NODE_BINARY in ios/.xcode.env.local to the absolute path of node (`echo export NODE_BINARY=$(command -v node) > ios/.xcode.env.local`). This pins that exact node: when a version manager removes it, update or delete the file again.",
                "Rebuild from Xcode or with your run command.",
              ]
            : metroErrors.length
              ? ["Fix the Metro error reported in this report, then rebuild."]
              : [
                  "Open the build log in Xcode's Report navigator and expand the 'Bundle React Native code and images' step to see the script output, then analyze that output.",
                  "Reproduce with `npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/main.jsbundle` (or `npx expo export --platform ios`).",
                ],
          verification: "The build phase completes and main.jsbundle is produced.",
        }),
      );
    }
    return out;
  },
};

// `…Pods.xcodeproj: error: The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to
// 13.0, but the range of supported deployment target versions is 15.0 to 27.0.x. (in target 'X' from
// project 'Pods')`. React Native CLI prints it as `error The iOS Simulator …`. Older Xcode versions
// report the same message as a warning.
const DEPLOYMENT_TARGET =
  /(?:(?:^|[\s:])(error|warning):?|^❌)\s+The ([\w ]+?) deployment target '(\w+)' is set to (\d+(?:\.\d+)*), but the range of supported deployment target versions is (\d+(?:\.\d+)*) to (\d+(?:\.[\dx]+)*)\.?(?:\s*\(in target '([^']+)' from project '([^']+)'\))?/;

/**
 * CocoaPods names a resource bundle target `<pod>-<bundle>`, and bundles are usually named after
 * the pod (`AsyncStorage-AsyncStorage_resources`, `React-Core-React-Core_privacy`).
 */
function podForTarget(target: string): string {
  for (let i = target.indexOf("-"); i > 0; i = target.indexOf("-", i + 1)) {
    const pod = target.slice(0, i);
    if (target.slice(i + 1).startsWith(pod)) return pod;
  }
  return target;
}

export const deploymentTargetUnsupported: Rule = {
  meta: {
    id: "ios.deployment-target-unsupported",
    title: "A target's deployment target is below what this Xcode supports",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "An Xcode error \"The <platform> deployment target '<SETTING>' is set to X, but the range of supported deployment target versions is Y to Z\" (as `error:`, React Native CLI's `error`, or Expo CLI/xcpretty's ❌). The same message as a warning doesn't trigger the rule.",
    evidence:
      "The error lines with each target, its project (Pods or the app), the configured value, and the supported range Xcode printed. The Podfile platform when the project is available.",
    versionScope: "Xcode 14+ (seen as an error with Xcode 27, where the minimum is iOS 15.0)",
    references: [
      "https://developer.apple.com/support/xcode/",
      "https://guides.cocoapods.org/syntax/podspec.html#deployment_target",
      "https://github.com/react-native-async-storage/async-storage/issues/1355",
    ],
    lastVerified: "2026-10-23",
    fixtures: [
      "logs/xcode27-pod-deployment-target.log",
      "logs/expo-cli-xcode27-deployment-target.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hits: { index: number; match: RegExpExecArray }[] = [];
      const seen = new Set<string>();
      log.doc.lines.forEach((line, index) => {
        const match = DEPLOYMENT_TARGET.exec(line);
        // Expo CLI and xcpretty print errors with ❌ instead of "error:".
        if (!match || (match[1] ?? "error") !== "error") return;
        const key = `${match[7] ?? ""}|${match[8] ?? ""}|${match[4]}`;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push({ index, match });
      });
      if (!hits.length) continue;
      const [, , platform, setting, , minimum, maximum] = hits[0]!.match;
      const targets = hits.map((h) => ({
        target: h.match[7],
        project: h.match[8],
        value: h.match[4]!,
      }));
      const pods = targets.filter((t) => t.project === "Pods");
      const podNames = [...new Set(pods.map((t) => t.target && podForTarget(t.target)))].filter(
        (p): p is string => Boolean(p),
      );
      const appTargets = targets.filter((t) => t.project && t.project !== "Pods");
      const named = targets
        .filter((t) => t.target)
        .map((t) => `${t.target} (${t.value})`)
        .slice(0, 6);
      const evidence: Evidence[] = hits
        .slice(0, 5)
        .map((h) =>
          logEvidence(
            log.doc,
            { start: h.index, end: h.index },
            h.match[7]
              ? `${h.match[7]} in ${h.match[8]}: ${h.match[3]} ${h.match[4]}, supported ${h.match[5]} to ${h.match[6]}`
              : undefined,
          ),
        );
      const podfile = ctx.project?.versions["ios deployment target (Podfile)"];
      if (podfile)
        evidence.push({ source: "project", detail: `Podfile platform :ios, ${podfile}` });
      const expo = ctx.project?.kind === "expo";
      out.push(
        finding(this.meta, {
          title:
            podNames.length && pods.length === targets.length
              ? `${podNames.length === 1 ? `Pod ${podNames[0]} has` : `${podNames.length} pods have`} a deployment target below ${minimum}, the minimum this Xcode supports`
              : `${targets.length === 1 && targets[0]!.target ? targets[0]!.target : `${targets.length} targets`} ${targets.length === 1 ? "has" : "have"} a deployment target below ${minimum}, the minimum this Xcode supports`,
          severity: "error",
          confidence: "high",
          explanation:
            `This Xcode supports ${platform} deployment targets from ${minimum} to ${maximum}, and refuses to build a target set below that: ${named.length ? named.join(", ") : `${setting} is ${targets[0]!.value}`}.` +
            (pods.length
              ? ` ${pods.length === targets.length ? (pods.length === 1 ? "This is a CocoaPods target" : "These are CocoaPods targets") : "Some are CocoaPods targets"}${podNames.length ? ` (${podNames.length === 1 ? "pod" : "pods"} ${podNames.join(", ")})` : ""}, ${pods.length === 1 ? "which takes its" : "which take their"} deployment target from the pod's podspec (s.platforms or s.ios.deployment_target), not from your app. Libraries that haven't raised it fail like this when a new Xcode drops old versions.`
              : "") +
            (appTargets.length
              ? ` ${appTargets.map((t) => t.target).join(", ")} ${appTargets.length === 1 ? "belongs" : "belong"} to the app project, so the app's own ${setting} is too low.`
              : ""),
          evidence,
          nextSteps: [
            ...(pods.length
              ? [
                  `Upgrade the ${podNames.length === 1 ? "library that provides the pod" : "libraries that provide the pods"} ${podNames.slice(0, 4).join(", ")} to ${podNames.length === 1 ? "a release whose podspec targets" : "releases whose podspecs target"} ${minimum} or later. To find the npm package, search node_modules for the podspec: \`find node_modules -name "${podNames[0] ?? "*"}.podspec"\`.`,
                  `Until then, raise the pods' setting in the Podfile's existing post_install block (next to react_native_post_install): \`installer.pods_project.targets.each { |t| t.build_configurations.each { |c| c.build_settings['${setting}'] = '${minimum}' if c.build_settings['${setting}'].to_f < ${minimum} } }\`, then run \`cd ios && pod install\`.`,
                  ...(expo
                    ? [
                        "In an Expo project ios/ is generated, so edits to ios/Podfile are lost on `npx expo prebuild --clean`. Apply the post_install change with a config plugin (withPodfile).",
                      ]
                    : []),
                ]
              : []),
            ...(appTargets.length || !pods.length
              ? [
                  `Raise ${setting} to ${minimum} or later for the app target, and \`platform :ios\` in ios/Podfile${expo ? " (Expo: ios.deploymentTarget in expo-build-properties)" : ""}.`,
                ]
              : []),
            "Alternatively, build with the previous Xcode version until the libraries are updated.",
          ],
          verification: `The build no longer reports a deployment target below ${minimum}.`,
        }),
      );
    }
    return out;
  },
};

/** npm package name from a path such as …/node_modules/@scope/pkg/ios/Foo.podspec. */
function packageFromPath(path: string): string | undefined {
  return /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/
    .exec(path)?.[1]
    ?.replace(/\\/g, "/");
}

const NO_PODSPEC =
  /No podspec found for [`'"]?([\w@/.+-]+?)[`'"]?(?: in [`'"]([^`'"]+)[`'"])?\s*\.?$/;
const INVALID_FILE = /Invalid [`']([^`']+\.podspec|Podfile)[`'] file: (.+?)\s*$/;
const FAILED_VALIDATE = /The [`']([^`']+)[`'] pod failed to validate due to (\d+) errors?/;
/** CocoaPods points at the Ruby source line: " #  from /path/to/File.podspec:134". */
const FROM_LINE = /^\s*#\s+from (.+?):(\d+)\s*$/;

export const cocoapodsInvalidSpec: Rule = {
  meta: {
    id: "ios.cocoapods-invalid-spec",
    title: "CocoaPods couldn't load a Podfile or podspec",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "pod install output (directly or through Expo prebuild/EAS) with 'No podspec found for `X` in `path`', 'Invalid `X.podspec` file: …', 'Invalid `Podfile` file: …', or 'The `X` pod failed to validate due to N errors'.",
    evidence:
      "The CocoaPods error, the file and line from its ' #  from <file>:<line>' trace, and with the project, whether the pod path exists and which podspecs it contains.",
    versionScope: "CocoaPods 1.x (messages checked with CocoaPods 1.16.2)",
    references: [
      ...COCOAPODS_REFS,
      "https://guides.cocoapods.org/syntax/podspec.html",
      "https://guides.cocoapods.org/syntax/podfile.html",
    ],
    lastVerified: "2026-10-25",
    fixtures: [
      "logs/real-cocoapods-no-podspec-found.log",
      "logs/real-cocoapods-invalid-podspec.log",
      "logs/real-cocoapods-invalid-podfile.log",
      "logs/real-cocoapods-pod-failed-validate.log",
      "logs/expo-prebuild-pod-install-invalid-podspec.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const lines = log.doc.lines;
      const find = (pattern: RegExp) => {
        for (let i = 0; i < lines.length; i++) {
          const m = pattern.exec(lines[i]!);
          if (m) return { index: i, match: m };
        }
        return undefined;
      };
      const traceAfter = (index: number) => {
        for (let i = index; i < Math.min(lines.length, index + 6); i++) {
          const m = FROM_LINE.exec(lines[i]!);
          if (m) return { index: i, file: m[1]!, line: Number(m[2]) };
        }
        return undefined;
      };
      const span = (start: number) => {
        let end = start;
        while (end + 1 < lines.length && end - start < 12 && lines[end + 1]!.trim() !== "") end++;
        return { start, end };
      };
      const expo = ctx.project?.kind === "expo" && !ctx.project.hasIos;
      const regenerate = expo
        ? "In an Expo project, ios/ is generated: run `npx expo prebuild --clean` after the fix, so the Podfile and autolinking are regenerated."
        : "Run `cd ios && pod install` again after the fix.";

      // A podspec error is more specific than the Podfile error that wraps it (Expo's facades).
      const invalidSpec = [...lines.entries()]
        .map(([i, l]) => ({ index: i, match: INVALID_FILE.exec(l) }))
        .filter((x) => x.match)
        .sort((a, b) => Number(a.match![1] === "Podfile") - Number(b.match![1] === "Podfile"))[0];
      const noPodspec = find(NO_PODSPEC);
      const validate = find(FAILED_VALIDATE);

      if (noPodspec) {
        const [, pod, path] = noPodspec.match;
        const evidence: Evidence[] = [logEvidence(log.doc, span(noPodspec.index))];
        let contents: string[] | undefined;
        if (ctx.project && path) {
          // Podfile paths are relative to ios/.
          const dir = posix.normalize(posix.join("ios", path.replace(/\\/g, "/")));
          contents = listPodspecs(ctx.project.root, dir);
          evidence.push({
            source: "project",
            detail:
              contents === undefined
                ? `${dir} doesn't exist`
                : contents.length
                  ? `Podspecs in ${dir}: ${contents.join(", ")}`
                  : `${dir} exists but contains no .podspec file`,
          });
        }
        const pkg = path ? packageFromPath(`/${path.replace(/^(\.\.\/)+/, "")}/`) : undefined;
        out.push(
          finding(this.meta, {
            title: `No podspec found for ${pod}${path ? ` in ${path}` : ""}`,
            severity: "error",
            confidence: "high",
            explanation:
              `The Podfile asks for the pod ${pod}${path ? ` from ${path}` : ""}, and CocoaPods found no ${pod}.podspec there. ` +
              (contents === undefined && path && ctx.project
                ? `The folder doesn't exist, so ${pkg ? `the package ${pkg}` : "the package"} probably isn't installed.`
                : contents?.length
                  ? `The folder has ${contents.join(", ")} instead, so the Podfile (or the autolinking or config plugin that wrote it) uses a pod name the installed version no longer ships.`
                  : "Either the package isn't installed, or the installed version names its podspec differently (a renamed pod or a version mismatch)."),
            evidence,
            nextSteps: [
              `Check that ${pkg ?? "the package"} is installed (\`ls ${path ?? "node_modules/<package>"}\`); reinstall dependencies if the folder is missing.`,
              `If the folder has a podspec with another name, the pod was renamed in this version: remove the old \`pod '${pod}'\` line (or the plugin option that adds it) and let autolinking add the current one.`,
              regenerate,
            ],
            verification: "`cd ios && pod install` completes.",
          }),
        );
        continue;
      }

      if (invalidSpec) {
        const [, file, message] = invalidSpec.match!;
        const trace = traceAfter(invalidSpec.index + 1);
        const pkg = trace ? packageFromPath(trace.file) : undefined;
        const isPodfile = file === "Podfile";
        const evidence: Evidence[] = [
          logEvidence(log.doc, {
            start: invalidSpec.index,
            end: Math.min(lines.length - 1, (trace?.index ?? invalidSpec.index) + 4),
          }),
        ];
        if (trace)
          evidence.push({
            source: "log",
            file: log.doc.path,
            detail: `Raised at ${trace.file}:${trace.line}`,
          });
        for (const key of ["react-native", "expo"]) {
          const version = ctx.project?.versions[key];
          if (version) evidence.push({ source: "project", detail: `${key}: ${version}` });
        }
        out.push(
          finding(this.meta, {
            title: isPodfile
              ? `The Podfile failed to load: ${message!.slice(0, 100)}`
              : `${file} ${pkg ? `(from ${pkg}) ` : ""}failed to load: ${message!.slice(0, 100)}`,
            severity: "error",
            confidence: "high",
            explanation: isPodfile
              ? `CocoaPods runs the Podfile as Ruby code, and it raised an error${trace ? ` at line ${trace.line}` : ""}: ${message}. Nothing is installed until the Podfile loads.`
              : `A podspec is Ruby code, and CocoaPods couldn't evaluate ${file}${pkg ? ` from the npm package ${pkg}` : ""}: ${message}${trace ? ` (line ${trace.line})` : ""}. This is an error in that package's podspec, or in how it's combined with the installed React Native, Ruby or CocoaPods versions, not in your app code.`,
            evidence,
            nextSteps: isPodfile
              ? [
                  `Open ${trace ? `${trace.file} at line ${trace.line}` : "ios/Podfile"} and fix the reported error.`,
                  ...(expo
                    ? [
                        "In an Expo project the Podfile is generated: a config plugin that edits it may have produced the error. `npx expo prebuild --clean` regenerates it without manual edits.",
                      ]
                    : []),
                ]
              : [
                  pkg === "react-native"
                    ? "The failing podspec is React Native's own. Check that react-native and the packages that wrap it (expo, @react-native/*, libraries that call React Native's podspec helpers) are on matching versions (`npx expo install --check` in Expo projects), then reinstall node_modules."
                    : `Upgrade ${pkg ?? "the package that ships the podspec"} to a version that supports your React Native version, or check its issues for the error text.`,
                  "Note the CocoaPods and Ruby versions (`pod --version`, `ruby -v`): a podspec written for newer Ruby can fail on an older one, and the reverse.",
                  regenerate,
                ],
            verification: "`cd ios && pod install` completes.",
          }),
        );
        continue;
      }

      if (validate) {
        const [, pod, count] = validate.match;
        const errors: string[] = [];
        for (let i = validate.index + 1; i < Math.min(lines.length, validate.index + 12); i++) {
          const m = /^\s*-\s*ERROR \| (.+)$/.exec(lines[i]!);
          if (m) errors.push(m[1]!.trim());
        }
        out.push(
          finding(this.meta, {
            title: `The ${pod} podspec failed validation (${count} error${count === "1" ? "" : "s"})`,
            severity: "error",
            confidence: "high",
            explanation: `CocoaPods loaded the ${pod} podspec but rejected its contents: ${errors.slice(0, 3).join("; ") || "see the excerpt"}. The podspec sets an attribute to a value CocoaPods doesn't accept, so this is a problem in the package that ships it.`,
            evidence: [logEvidence(log.doc, span(validate.index))],
            nextSteps: [
              `Upgrade the package that ships the ${pod} podspec, or check its issues for the error.`,
              "Until it's fixed, patch the attribute named in the error (with patch-package for an npm package).",
              regenerate,
            ],
            verification: "`cd ios && pod install` completes.",
          }),
        );
      }
    }
    return out;
  },
};

/** Podspec file names in a project directory, or undefined when the directory doesn't exist. */
function listPodspecs(root: string, dir: string): string[] | undefined {
  try {
    return readdirSync(join(root, dir)).filter((f) => f.endsWith(".podspec"));
  } catch {
    return undefined;
  }
}

const POD_NOT_FOUND = /spawn pod ENOENT|command not found: pod\b|\bpod: command not found/;

export const cocoapodsNotFound: Rule = {
  meta: {
    id: "ios.cocoapods-not-found",
    title: "The pod command isn't available",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "'spawn pod ENOENT' (Node, Expo CLI, EAS Build) or a shell 'command not found: pod' / 'pod: command not found'.",
    evidence: "The error line, and whether the log shows EAS Build phases.",
    versionScope: "CocoaPods 1.x; Expo CLI and EAS Build",
    references: [
      "https://guides.cocoapods.org/using/getting-started.html",
      "https://github.com/expo/eas-cli/issues/4111",
    ],
    lastVerified: "2026-10-25",
    fixtures: ["logs/real-node-spawn-pod-enoent.log", "logs/eas-install-pods-spawn-enoent.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const index = log.doc.lines.findIndex((l) => POD_NOT_FOUND.test(l));
      if (index < 0) continue;
      const eas = log.doc.lines.some((l) => /\bINSTALL_PODS\b|Start phase:|eas-build-/.test(l));
      out.push(
        finding(this.meta, {
          title: "pod install couldn't start: the pod command wasn't found",
          severity: "error",
          confidence: "high",
          explanation:
            "The process that runs `pod install` couldn't find the `pod` executable on its PATH, so CocoaPods never ran. Either CocoaPods isn't installed, or it's installed somewhere that isn't on the PATH of that process (a different shell, an IDE, a Node version manager or a CI step can each have their own PATH)." +
            (eas
              ? " On EAS Build, CocoaPods is installed on the build image; if `pod --version` works in an eas-build-pre-install hook but this phase still fails, the problem is in the build image or the build tools, not your project (reported in expo/eas-cli#4111)."
              : ""),
          evidence: [logEvidence(log.doc, { start: Math.max(0, index - 2), end: index })],
          nextSteps: eas
            ? [
                "Add `pod --version` and `echo $PATH` to an eas-build-pre-install script to see what the build machine has.",
                "If pod is present there, try a different build image in eas.json (`ios.image`) and report the failing build to Expo with its ID.",
              ]
            : [
                "Install CocoaPods (`brew install cocoapods`, or `gem install cocoapods`), then check `which pod` in the same terminal that runs the build.",
                "If `which pod` works in your terminal but not in the failing tool, start the tool from that terminal or add the directory `which pod` prints to its PATH.",
              ],
          verification:
            "`pod --version` prints a version in the same environment, and `cd ios && pod install` runs.",
        }),
      );
    }
    return out;
  },
};

/** First line index matching `pattern`, with the match. */
function firstMatch(
  log: ParsedLog,
  pattern: RegExp,
): { index: number; match: RegExpExecArray } | undefined {
  for (let i = 0; i < log.doc.lines.length; i++) {
    const match = pattern.exec(log.doc.lines[i]!);
    if (match) return { index: i, match };
  }
  return undefined;
}

export const xcode27SimulatorApp: Rule = {
  meta: {
    id: "ios.xcode27-simulator-app-not-found",
    title: "The CLI can't find the Simulator app (Xcode 27 DeviceHub)",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "\"Can't determine id of Simulator app; the Simulator is most likely not installed on this machine\" from Expo CLI or EAS CLI, or Expo CLI's \"Device Hub or Simulator is installed but is identified as 'com.apple.dt.Xcode'\" (Xcode 27.2).",
    evidence: "The error line, and with the project, the installed @expo/cli version.",
    versionScope: `Xcode 27+; Expo CLI before SDK ${XCODE27_DEVICEHUB.expoCliFirstSupportedMajor}, EAS CLI before ${XCODE27_DEVICEHUB.easCliFixedIn}; Xcode 27.2 with @expo/cli up to ${XCODE272_SIMULATOR_ID.reportedWithExpoCli}`,
    references: [...XCODE27_DEVICEHUB.sources, ...XCODE272_SIMULATOR_ID.sources],
    lastVerified: XCODE272_SIMULATOR_ID.lastVerified,
    fixtures: [
      "logs/eas-issue-xcode27-simulator-app.log",
      "logs/expo-issue-xcode27-simulator-app.log",
      "logs/expo-issue-xcode272-simulator-is-xcode.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const xcodeId = firstMatch(
        log,
        /Device Hub or Simulator is installed but is identified as '([^']+)'/,
      );
      if (xcodeId) {
        const cli = ctx.project?.installedVersion("@expo/cli");
        out.push(
          finding(this.meta, {
            title: `Expo CLI found ${xcodeId.match[1]} where it looked for the Simulator app (Xcode 27.2)`,
            severity: "error",
            confidence: "high",
            explanation: `With Xcode 27.2, macOS answers the lookup for an app named "Simulator" with Xcode itself (${xcodeId.match[1]}). Expo CLI looks up "Simulator" before "DeviceHub", gets an answer, and stops because it doesn't recognize it, so its DeviceHub support never runs. Reported with @expo/cli ${XCODE272_SIMULATOR_ID.reportedWithExpoCli} (expo/expo#52721); no fix was released when this rule was last checked.`,
            evidence: [
              logEvidence(log.doc, { start: xcodeId.index, end: xcodeId.index }),
              ...(cli
                ? [{ source: "project" as const, detail: `@expo/cli: installed ${cli}` }]
                : []),
            ],
            references: XCODE272_SIMULATOR_ID.sources,
            nextSteps: [
              "Check for a newer @expo/cli (update expo to the latest patch of your SDK) that looks up DeviceHub first.",
              "Until then, open the .xcworkspace in ios/ and run the app from Xcode, or build with `xcodebuild` and install with `xcrun simctl install booted <app>`, with Metro started separately (`npx expo start`).",
            ],
            verification: "The app installs and launches on a simulator.",
          }),
        );
        continue;
      }
      const hit = firstMatch(log, /Can't determine id of Simulator app/);
      if (!hit) continue;
      const eas = log.doc.lines.some((l) =>
        /\beas (?:build|build:dev|build:run)\b|build:dev command failed/.test(l),
      );
      const cli = ctx.project?.installedVersion("@expo/cli");
      const cliMajor = cli && semver.valid(cli) ? semver.major(cli) : undefined;
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: hit.index,
          end: Math.min(log.doc.lines.length - 1, hit.index + 1),
        }),
      ];
      if (cli) evidence.push({ source: "project", detail: `@expo/cli: installed ${cli}` });
      out.push(
        finding(this.meta, {
          title: `${eas ? "EAS CLI" : "Expo CLI"} can't find the Simulator app: Xcode 27 replaced it with DeviceHub`,
          severity: "error",
          confidence: "high",
          explanation:
            "Xcode 27 replaces Simulator.app with DeviceHub.app (bundle id com.apple.dt.Devices). CLI versions that look up the app named \"Simulator\" can't find it, so the build installs nothing. The suggested `xcode-select` command doesn't help, because the developer directory is already correct." +
            (cliMajor !== undefined && cliMajor >= XCODE27_DEVICEHUB.expoCliFirstSupportedMajor
              ? ` The installed @expo/cli ${cli} supports DeviceHub, so if this came from \`expo run:ios\`, check that the command uses this project's CLI (\`npx expo\`), not a global one.`
              : ""),
          evidence,
          nextSteps: eas
            ? [
                `Update EAS CLI to ${XCODE27_DEVICEHUB.easCliFixedIn} or later (\`npm install -g eas-cli@latest\`).`,
              ]
            : [
                `Use Expo SDK ${XCODE27_DEVICEHUB.expoCliFirstSupportedMajor} or later: its CLI supports DeviceHub. The SDK 54 and 55 CLIs don't (checked through @expo/cli 54.0.28 and 55.0.37).`,
                "Until you can upgrade, build and run from Xcode (open the .xcworkspace in ios/), or keep Xcode 26 installed for this project (`xcode-select -s` to switch).",
              ],
          verification: "The command installs and launches the app on a simulator.",
        }),
      );
    }
    return out;
  },
};

export const xcode27PhantomCommandFailure: Rule = {
  meta: {
    id: "ios.xcode27-exit-code-0-failure",
    title: "Xcode 27 reports a successful command as failed",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "Xcode output 'error: the following command failed with exit code 0 but produced no further output'.",
    evidence:
      "The error line, the script phase or package named nearby, and with the project, the installed expo-modules-jsi version.",
    versionScope: `Xcode 27; expo-modules-jsi before ${EXPO_JSI_XCODE27_ARCHIVE.fixedIn}`,
    references: EXPO_JSI_XCODE27_ARCHIVE.sources,
    lastVerified: EXPO_JSI_XCODE27_ARCHIVE.lastVerified,
    fixtures: ["logs/expo-issue-xcode27-jsi-exit-code-0.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit = firstMatch(
        log,
        /the following command failed with exit code 0 but produced no further output/,
      );
      if (!hit) continue;
      const near = log.doc.lines.slice(Math.max(0, hit.index - 15), hit.index + 15).join("\n");
      const jsi = /ExpoModulesJSI|expo-modules-jsi|build-xcframework\.sh/.test(near);
      // Real compiler errors elsewhere in the log come first; this line may only be a side effect.
      const otherErrors = log.xcode.errors.filter((e) => e.file).length;
      const installed = ctx.project?.installedVersion("expo-modules-jsi");
      const fixed =
        installed && semver.valid(installed)
          ? semver.gte(installed, EXPO_JSI_XCODE27_ARCHIVE.fixedIn)
          : undefined;
      const evidence: Evidence[] = [
        logEvidence(log.doc, { start: Math.max(0, hit.index - 1), end: hit.index }),
      ];
      if (installed)
        evidence.push({ source: "project", detail: `expo-modules-jsi: installed ${installed}` });
      out.push(
        finding(this.meta, {
          title: jsi
            ? "Xcode 27 fails the ExpoModulesJSI xcframework phase although the build succeeded"
            : "Xcode 27 reported a command that exited with code 0 as failed",
          severity: "error",
          confidence: otherErrors ? "low" : jsi ? "high" : "medium",
          explanation:
            '"failed with exit code 0" means the command succeeded: Xcode 27 prints this error line for a successful compile job inside a nested `xcodebuild -quiet` run, and a script that treats any `error:` line as a failure then fails the build.' +
            (jsi
              ? ` In this build it's the "[CP-User] Build ExpoModulesJSI xcframework" phase of expo-modules-jsi, fixed in ${EXPO_JSI_XCODE27_ARCHIVE.fixedIn} (expo/expo#50587).${fixed === true ? ` The installed ${installed} already has that fix, so look for another script phase that runs xcodebuild.` : ""}`
              : " Find the script phase that runs a nested xcodebuild; that script needs to ignore this line.") +
            (otherErrors
              ? ` The log also has ${otherErrors} compiler error${otherErrors === 1 ? "" : "s"} with a file and line; fix ${otherErrors === 1 ? "that" : "those"} first, since they're real failures, while this line comes from a command that succeeded.`
              : ""),
          evidence,
          nextSteps: jsi
            ? [
                `Update expo-modules-jsi to ${EXPO_JSI_XCODE27_ARCHIVE.fixedIn} or later: update expo to the latest SDK 58 patch, then \`npx expo install --fix\`.`,
                `On SDK 57 the fix isn't released (checked through expo-modules-jsi ${EXPO_JSI_XCODE27_ARCHIVE.notFixedThrough57}): upgrade to SDK 58, or archive with Xcode 26.`,
              ]
            : [
                "Find the script phase whose nested xcodebuild printed the line (the build log shows the phase name just above it), and update the package that owns it.",
                "Until it's fixed, archive with Xcode 26.",
              ],
          verification: "The archive completes without the exit code 0 error.",
        }),
      );
    }
    return out;
  },
};

const SPEC_FILE = /^(?:Native\w+|\w+NativeComponent)\.(?:ts|tsx|js|jsx)$/;

/** Whether a directory (searched a few levels deep) contains codegen spec files. */
function hasSpecFiles(root: string, dir: string, depth = 4): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && SPEC_FILE.test(entry.name)) return true;
    if (
      entry.isDirectory() &&
      depth > 0 &&
      entry.name !== "node_modules" &&
      !entry.name.startsWith(".")
    )
      if (hasSpecFiles(root, `${dir}/${entry.name}`, depth - 1)) return true;
  }
  return false;
}

export const codegenDependencyCycle: Rule = {
  meta: {
    id: "ios.codegen-dependency-cycle",
    title: "Xcode found a dependency cycle between targets",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "Xcode 'Cycle in dependencies between targets 'A' and 'B'; building could produce unreliable results'.",
    evidence:
      "The cycle error and path, and with the project, the app's codegenConfig in package.json and whether its jsSrcsDir contains any spec files.",
    versionScope: "React Native New Architecture (codegen); Xcode 14+",
    references: [
      "https://github.com/react/react-native/issues/57760",
      "https://github.com/react/react-native/pull/57759",
      "https://github.com/react/react-native/issues/58621",
    ],
    lastVerified: "2026-10-25",
    fixtures: ["logs/rn-issue-codegen-dependency-cycle.log", "projects/rn088-empty-codegen-config"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit = firstMatch(log, /Cycle in dependencies between targets '([^']+)' and '([^']+)'/);
      if (!hit) continue;
      const [, a, b] = hit.match;
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: hit.index,
          end: Math.min(log.doc.lines.length - 1, hit.index + 1),
        }),
      ];
      const pkg = ctx.project
        ? readJsonFile<{ codegenConfig?: { jsSrcsDir?: string; name?: string } }>(
            ctx.project.root,
            "package.json",
          )
        : undefined;
      const codegen = pkg?.ok ? pkg.value.codegenConfig : undefined;
      const emptyCodegen =
        codegen !== undefined && !hasSpecFiles(ctx.project!.root, codegen.jsSrcsDir ?? ".");
      if (codegen)
        evidence.push({
          source: "project",
          file: "package.json",
          detail: `codegenConfig${codegen.name ? ` "${codegen.name}"` : ""} with jsSrcsDir "${codegen.jsSrcsDir ?? "."}": ${emptyCodegen ? "no spec files (Native*.ts / *NativeComponent.ts) found there" : "spec files found"}`,
        });
      const involvesCodegen = a === "ReactCodegen" || b === "ReactCodegen";
      out.push(
        finding(this.meta, {
          title: emptyCodegen
            ? "Dependency cycle caused by an app codegenConfig with no spec files"
            : `Dependency cycle between targets '${a}' and '${b}'`,
          severity: "error",
          confidence: emptyCodegen ? "high" : involvesCodegen ? "medium" : "low",
          explanation: emptyCodegen
            ? "The app's package.json declares a codegenConfig, but its jsSrcsDir has no spec files. React Native's codegen then writes a directory (the app root) as an input of the \"[CP-User] Generate Specs\" phase instead of an empty list, so every pod becomes an input of ReactCodegen and an incremental build finds a cycle (react/react-native#57760)."
            : involvesCodegen
              ? "The cycle involves ReactCodegen. A known cause is an app codegenConfig whose jsSrcsDir has no spec files: codegen then lists the app root as an input of its script phase, which makes other targets depend on it (react/react-native#57760). Other script phases with broad input or output paths can cause the same error."
              : "Two targets depend on each other through their build phases, often a script phase with broad input or output paths. It frequently appears only on incremental builds.",
          evidence,
          nextSteps: emptyCodegen
            ? [
                "Remove the codegenConfig from package.json if the app doesn't define its own native modules, or point jsSrcsDir at the folder that has the specs.",
                "Run `cd ios && pod install`, then build again.",
              ]
            : [
                ...(ctx.project
                  ? []
                  : [
                      "Run this tool with --cwd pointing at the project so it can check package.json for an empty codegenConfig.",
                    ]),
                "Check package.json: if it has a codegenConfig but the app defines no native module specs, remove it and run `pod install`.",
                "Otherwise look at the script phases of the two targets for input or output paths that point at a directory.",
                "Deleting DerivedData only hides the cycle until the next incremental build.",
              ],
          verification:
            "Two consecutive builds (a clean one, then an incremental one) both succeed.",
        }),
      );
    }
    return out;
  },
};

export const dyldLaunchFailure: Rule = {
  meta: {
    id: "ios.dyld-launch-failure",
    title: "The app was stopped at launch by the dynamic linker",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "dyld output in a crash report or device log: 'Library not loaded: <path>' or 'Symbol not found: <symbol>' (Termination Reason Namespace DYLD).",
    evidence:
      "The dyld lines (library or symbol, Referenced from, Expected in), and for Expo, the installed expo version.",
    versionScope: "iOS (all versions)",
    references: [
      "https://developer.apple.com/documentation/xcode/addressing-missing-framework-crashes",
      ...EXPO_SWIFT_PACK_SYMBOLS.sources,
      "https://github.com/expo/expo/issues/50236",
    ],
    lastVerified: "2026-10-25",
    fixtures: ["logs/expo-issue-dyld-symbol-missing.log", "logs/ios-dyld-library-not-loaded.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const lib = firstMatch(log, /Library not loaded: (\S+)/);
      const sym = lib ? undefined : firstMatch(log, /Symbol not found: (\S+)/);
      const hit = lib ?? sym;
      if (!hit) continue;
      const lines = log.doc.lines.slice(hit.index, hit.index + 4);
      const referencedFrom = lines
        .map((l) => /Referenced from:\s*(?:<[^>]+>\s*)?(\S+)/.exec(l)?.[1])
        .find(Boolean);
      const expectedIn = lines
        .map((l) => /Expected in:\s*(?:<[^>]+>\s*)?(\S+)/.exec(l)?.[1])
        .find(Boolean);
      const name = hit.match[1]!;
      const framework = (p?: string) => p && /([\w-]+)\.framework/.exec(p)?.[1];
      const expoPack =
        sym &&
        EXPO_SWIFT_PACK_SYMBOLS.symbols.includes(name) &&
        /ExpoModules/.test(lines.join(" "));
      const expo = ctx.project?.installedVersion("expo");
      const evidence: Evidence[] = [
        logEvidence(log.doc, {
          start: Math.max(0, hit.index - 1),
          end: Math.min(log.doc.lines.length - 1, hit.index + 2),
        }),
      ];
      if (expo) evidence.push({ source: "project", detail: `expo: installed ${expo}` });
      const expoFixed =
        expo && semver.valid(expo)
          ? semver.gte(expo, EXPO_SWIFT_PACK_SYMBOLS.fixedInExpo)
          : undefined;
      out.push(
        finding(this.meta, {
          title: lib
            ? `App crashed at launch: ${framework(name) ?? name} isn't in the app bundle`
            : `App crashed at launch: ${name} is missing from ${framework(expectedIn) ?? "a linked framework"}`,
          severity: "error",
          confidence: expoPack || lib ? "high" : "medium",
          explanation: lib
            ? `dyld couldn't load ${name}${referencedFrom ? `, which ${framework(referencedFrom) ?? referencedFrom} needs` : ""}. The app links the framework but the build didn't embed it in the app's Frameworks folder, so the app stops before any code runs.`
            : expoPack
              ? `The precompiled ExpoModulesCore imports ${name} from ExpoModulesJSI, but the ExpoModulesJSI built for this app doesn't export it (it comes from a Swift compatibility library that Xcode 27 marks private), so dyld stops the app before main. This is expo/expo#51454, fixed in expo ${EXPO_SWIFT_PACK_SYMBOLS.fixedInExpo}.${expoFixed === true ? ` The installed expo ${expo} should already have the fix; check that \`npx expo install --fix\` updated expo-modules-core and expo-modules-jsi too.` : ""}`
              : `${framework(referencedFrom) ?? "A binary in the app"} expects ${name} in ${framework(expectedIn) ?? expectedIn ?? "another framework"}, and it isn't there. The two were built from different versions or with different toolchains, so they don't match.`,
          evidence,
          nextSteps: lib
            ? [
                `Check that ${framework(name) ?? "the framework"} is embedded: in Xcode, the app target's General > Frameworks, Libraries, and Embedded Content must list it as "Embed & Sign" (CocoaPods does this in the "[CP] Embed Pods Frameworks" phase).`,
                "Run `cd ios && pod install` (Expo: `npx expo prebuild --clean`), clean the build folder, and build again.",
                "If it only happens in some builds (EAS, archive, app thinning), compare those build logs for the framework's embed step.",
              ]
            : expoPack
              ? [
                  `Update expo to ${EXPO_SWIFT_PACK_SYMBOLS.fixedInExpo} or later and run \`npx expo install --fix\`, then \`npx expo prebuild --clean\` and rebuild.`,
                ]
              : [
                  `Rebuild both ${framework(referencedFrom) ?? "binaries"} and ${framework(expectedIn) ?? "the framework"} from matching versions: reinstall pods, clean the build folder, and build again.`,
                  "If one of them is precompiled (an XCFramework from a package), check that its version matches the other package, and that it was built with a compatible Xcode.",
                ],
          verification: "The app launches past the splash screen.",
        }),
      );
    }
    return out;
  },
};

export const uisceneLifecycleRequired: Rule = {
  meta: {
    id: "ios.uiscene-lifecycle-required",
    title: "iOS 27 SDK apps must adopt the UIScene life cycle",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "'UIScene life cycle is required for apps built with this SDK', or a crash in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption.",
    evidence:
      "The UIKit message or crash frame, and with the project, the React Native or Expo SDK version and whether Info.plist declares a scene manifest.",
    versionScope: "Xcode 27 / iOS 27 SDK; React Native before 0.88, Expo before SDK 58",
    references: IOS27_UISCENE.sources,
    lastVerified: IOS27_UISCENE.lastVerified,
    fixtures: [
      "logs/expo-issue-ios27-uiscene-required.log",
      "logs/issue-ios27-uiscene-crash-report.log",
      "projects/expo54-eas-image-latest",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hit =
        firstMatch(log, /UIScene life cycle is required for apps built with this SDK/) ??
        firstMatch(log, /_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption/);
      if (!hit) continue;
      const rn = reactNativeVersion(ctx);
      const expo = ctx.project?.installedVersion("expo");
      const expoMajor = expo && semver.valid(expo) ? semver.major(expo) : undefined;
      const isExpo = ctx.project?.kind === "expo";
      const oldRn = rn ? compareVersions(rn, IOS27_UISCENE.minReactNative) < 0 : undefined;
      const oldExpo = expoMajor !== undefined ? expoMajor < IOS27_UISCENE.minExpoSdk : undefined;
      const evidence: Evidence[] = [logEvidence(log.doc, { start: hit.index, end: hit.index })];
      if (rn) evidence.push({ source: "project", detail: `react-native: ${rn}` });
      if (expo) evidence.push({ source: "project", detail: `expo: ${expo}` });
      const needsUpgrade = isExpo ? oldExpo : oldRn;
      // EAS profiles with ios.image "latest" switch Xcode versions without a code change.
      const easText = ctx.project ? readProjectFile(ctx.project.root, "eas.json") : undefined;
      const latestImage = easText?.ok
        ? findLine(easText.text, /"image"\s*:\s*"latest"/)
        : undefined;
      if (latestImage)
        evidence.push({
          source: "project",
          file: "eas.json",
          line: latestImage.line,
          excerpt: latestImage.excerpt,
          detail: 'An EAS build profile uses image "latest"',
        });
      out.push(
        finding(this.meta, {
          title:
            "App built with the iOS 27 SDK doesn't use the UIScene life cycle, so it can't launch",
          severity: "error",
          confidence: "high",
          explanation:
            "Starting with the iOS 27 SDK (Xcode 27), UIKit stops apps that don't adopt the UIScene life cycle at launch. The app still starts React Native from its AppDelegate, without a scene manifest in Info.plist." +
            (needsUpgrade === true
              ? isExpo
                ? ` Expo SDK ${expoMajor} doesn't generate a scene delegate; SDK ${IOS27_UISCENE.minExpoSdk} does.`
                : ` React Native ${rn} templates don't include a SceneDelegate; ${IOS27_UISCENE.minReactNative.replace(/\.0$/, "")} adds scene support.`
              : needsUpgrade === false
                ? " This project's React Native or Expo version supports scenes, so the native project probably wasn't migrated (an older ios/ folder kept through the upgrade)."
                : ""),
          evidence,
          nextSteps: isExpo
            ? [
                `Upgrade to Expo SDK ${IOS27_UISCENE.minExpoSdk}: \`npx expo prebuild --clean\` then generates SceneDelegate.swift and the UIApplicationSceneManifest entry.${expoMajor === 57 ? " On SDK 57 there's an opt-in: ios.enableSceneSupport in the expo-build-properties plugin." : ""}`,
                "If ios/ is maintained by hand, follow Expo's scene life cycle guide to move app startup into a scene delegate.",
                "Until then, build with Xcode 26 (the iOS 26 SDK), which doesn't require scenes.",
                ...(latestImage
                  ? [
                      'eas.json uses `"image": "latest"`, so EAS picked up Xcode 27 when the image changed. Pin `ios.image` to an Xcode 26 image (see the EAS build server infrastructure page) for production builds until the app supports scenes.',
                    ]
                  : []),
              ]
            : [
                `Upgrade to React Native ${IOS27_UISCENE.minReactNative.replace(/\.0$/, "")} or later, then migrate: move the React Native entry point from AppDelegate to a SceneDelegate, forward the scene's URL and user-activity callbacks to RCTLinkingManager, and add UIApplicationSceneManifest to Info.plist (see the template's SceneDelegate.swift).`,
                "Until then, build with Xcode 26 (the iOS 26 SDK), which doesn't require scenes.",
              ],
          verification: "The app launches on an iOS 27 device or simulator.",
        }),
      );
    }
    return out;
  },
};

/** A script phase sourcing NODE_BINARY that no longer exists: `…Script-X.sh: line 9: /…/bin/node: No such file or directory`. */
const MISSING_NODE = /^(.+?\.sh): line \d+: (\/\S*\/(?:bin\/)?node): No such file or directory\s*$/;

export const staleNodeBinary: Rule = {
  meta: {
    id: "ios.stale-node-binary",
    title: "An Xcode script phase runs a node that no longer exists",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "An Xcode script phase line '<Script-….sh>: line N: <absolute path>/node: No such file or directory'.",
    evidence:
      "The script error lines with the missing node path, the script phases that failed, and with the project, the NODE_BINARY line in ios/.xcode.env.local.",
    versionScope: "React Native 0.69+ (.xcode.env / .xcode.env.local NODE_BINARY)",
    references: [
      "https://github.com/react/react-native/issues/59538",
      "https://github.com/react/react-native/issues/51466",
      "https://github.com/react/react-native/blob/main/packages/react-native/scripts/xcode/with-environment.sh",
    ],
    lastVerified: "2026-11-05",
    fixtures: ["logs/rn-issue-xcode-env-local-stale-node.log", "projects/rn088-stale-xcode-env"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const hits = log.doc.lines
        .map((l, index) => ({ index, match: MISSING_NODE.exec(l.trim()) }))
        .filter((h): h is { index: number; match: RegExpExecArray } => h.match !== null);
      if (!hits.length) continue;
      const node = hits[0]!.match[2]!;
      const local = ctx.project
        ? readProjectFile(ctx.project.root, "ios/.xcode.env.local")
        : undefined;
      const pinned = local?.ok ? findLine(local.text, /^\s*export\s+NODE_BINARY=/) : undefined;
      const evidence: Evidence[] = hits.slice(0, 3).map((h) =>
        logEvidence(log.doc, {
          start: h.index,
          end: Math.min(log.doc.lines.length - 1, h.index + 1),
        }),
      );
      if (pinned)
        evidence.push({
          source: "project",
          file: "ios/.xcode.env.local",
          line: pinned.line,
          excerpt: pinned.excerpt,
        });
      out.push(
        finding(this.meta, {
          title: `Xcode script phases run ${node}, which no longer exists`,
          severity: "error",
          confidence: "high",
          explanation:
            `${hits.length} script phase${hits.length === 1 ? "" : "s"} tried to run node at ${node} and the file isn't there. React Native's script phases take node from NODE_BINARY: ios/.xcode.env sets it, then ios/.xcode.env.local overrides it. \`pod install\` writes .xcode.env.local with the absolute path of the node it ran under, only when the file doesn't exist yet, and never updates it. A version manager (nvm, fnm, asdf, volta) that removed that node version leaves every build pointing at a missing binary, and running \`pod install\` again doesn't fix it (react/react-native#59538).` +
            (pinned ? " This project's ios/.xcode.env.local pins that path." : ""),
          evidence,
          nextSteps: [
            "With the node version you want active, delete ios/.xcode.env.local (or change NODE_BINARY in it to the output of `command -v node`), then run `cd ios && pod install` and build again.",
            "Don't commit ios/.xcode.env.local: it's machine-specific. ios/.xcode.env, with `export NODE_BINARY=$(command -v node)`, is the shared one.",
          ],
          verification:
            "`grep NODE_BINARY ios/.xcode.env.local` names a node that exists (`ls -l` it), and the build passes the script phases.",
        }),
      );
    }
    return out;
  },
};

export const swiftCompilerCrash: Rule = {
  meta: {
    id: "ios.swift-compiler-crash",
    title: "The Swift compiler crashed",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "A 'Stack dump:' with swift-frontend in its program arguments or an 'Apple Swift version' line, or (with 'Command SwiftCompile failed') an 'Apple Swift version' line followed by the compiler's 'While evaluating request / While silgen …' frames, and no error: diagnostic.",
    evidence:
      "The stack dump lines with the Swift version, the module being compiled, and the source file and line the compiler was working on.",
    versionScope: "Xcode 14+ (swift-frontend)",
    references: [
      "https://github.com/expo/expo/issues/52231",
      "https://github.com/expo/expo/issues/52610",
      "https://github.com/swiftlang/swift/issues/93625",
      "https://github.com/swiftlang/swift/issues",
    ],
    lastVerified: "2026-11-05",
    fixtures: [
      "logs/expo-issue-swift-frontend-crash.log",
      "logs/expo-issue-swift-crash-no-stack-dump.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const lines = log.doc.lines;
      let dump = lines.findIndex((l, i) => {
        if (l.trim() !== "Stack dump:") return false;
        const next = lines.slice(i + 1, i + 4).join(" ");
        return /swift-frontend|Apple Swift version/.test(next);
      });
      // Pasted or abridged logs often keep only the numbered frames: "Apple Swift version …" followed
      // by the compiler's "While evaluating request / While silgen …" stack, and SwiftCompile failing.
      if (dump < 0 && lines.some((l) => /^Command SwiftCompile failed/.test(l.trim())))
        dump = lines.findIndex(
          (l, i) =>
            /Apple Swift version \S+/.test(l) &&
            lines
              .slice(i + 1, i + 5)
              .some((n) =>
                /^\s*(?:\d+\.\s+)?While (?:evaluating request|silgen|type-checking|emitting)/.test(
                  n,
                ),
              ),
        );
      if (dump < 0) continue;
      const body = lines.slice(dump, dump + 25);
      const swift = body.map((l) => /Apple Swift version (\S+)/.exec(l)?.[1]).find(Boolean);
      const module = body.map((l) => /for module (\w+)\)/.exec(l)?.[1]).find(Boolean);
      const at = body.map((l) => /\(at (\S+?\.swift):(\d+):(\d+)\)/.exec(l)).find(Boolean);
      const file = at?.[1];
      const pkg = file ? packageOfFile(file.replace(/\\/g, "/")) : undefined;
      const installed = pkg ? ctx.project?.installedVersion(pkg) : undefined;
      const evidence: Evidence[] = [
        logEvidence(log.doc, { start: dump, end: Math.min(lines.length - 1, dump + 9) }),
      ];
      if (swift)
        evidence.push({ source: "log", file: log.doc.path, detail: `Apple Swift ${swift}` });
      if (file)
        evidence.push({ source: "log", file: log.doc.path, detail: `Compiling ${file}:${at![2]}` });
      if (pkg && installed)
        evidence.push({ source: "project", detail: `${pkg}: installed ${installed}` });
      const name = file ? file.split("/").pop()! : undefined;
      out.push(
        finding(this.meta, {
          title: `The Swift compiler crashed${module ? ` compiling ${module}` : ""}${name ? ` (${name}:${at![2]})` : ""}`,
          severity: "error",
          confidence: "medium",
          explanation: `swift-frontend${swift ? ` (Swift ${swift})` : ""} crashed and printed a stack dump instead of an error, so Xcode only reports that SwiftCompile failed. This is a compiler bug triggered by specific code, not a mistake the compiler found.${file ? ` It was working on ${file}, line ${at![2]}${pkg ? `, which belongs to the dependency ${pkg}${installed ? ` (installed ${installed})` : ""}` : ""}.` : ""} The same code can compile with another Swift version.`,
          evidence,
          nextSteps: [
            ...(pkg
              ? [
                  `Search ${pkg}'s issues for ${name ?? "the file"} or "Stack dump". If the library offers precompiled builds (for Expo modules, avoid ios.buildReactNativeFromSource unless you need it), using them skips compiling this file.`,
                ]
              : []),
            "Build with a different Xcode version (an older or newer Swift compiler); the crash is often specific to one release.",
            `If you can isolate the code, a workaround is usually a small rewrite of the construct at ${name ? `${name}:${at![2]}` : "the reported line"}. Report the crash to the Swift project (swiftlang/swift) with the stack dump.`,
          ],
          verification: "The SwiftCompile step for that file completes.",
        }),
      );
    }
    return out;
  },
};

export const iosLogRules: Rule[] = [
  staleNodeBinary,
  swiftCompilerCrash,
  deploymentTargetUnsupported,
  cocoapodsIncompatibleVersions,
  cocoapodsSpecNotFound,
  cocoapodsInvalidSpec,
  cocoapodsNotFound,
  xcode27SimulatorApp,
  xcode27PhantomCommandFailure,
  codegenDependencyCycle,
  dyldLaunchFailure,
  uisceneLifecycleRequired,
  codeSigning,
  nativeCompileError,
  linkerError,
  bundlePhaseFailedRule,
];
