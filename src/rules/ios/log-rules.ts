import semver from "semver";
import { finding, type Rule, type RuleContext, type RuleMeta } from "../../engine/rule.js";
import type { ParsedLog } from "../../parsers/index.js";
import type { XcodeError } from "../../parsers/xcode.js";
import { compareVersions } from "../android/compat.js";
import { RN_NAMESPACED_HEADERS } from "./compat.js";
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
    trigger: "CocoaPods output '[!] Unable to find a specification for `X`'.",
    evidence: "The CocoaPods error naming the pod and its dependent.",
    versionScope: "CocoaPods 1.x",
    references: COCOAPODS_REFS,
    lastVerified: VERIFIED,
    fixtures: ["logs/ios-cocoapods-spec-not-found.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      for (const error of log.cocoapods.errors) {
        const m =
          /Unable to find a specification for [`'"]([^`'"]+)[`'"](?:\s+depended upon by [`'"]([^`'"]+)[`'"])?/.exec(
            error.message,
          );
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

export const nativeCompileError: Rule = {
  meta: {
    id: "ios.compile-error",
    title: "Native iOS compilation error",
    platforms: ["ios"],
    scope: "log",
    trigger:
      "Clang/Swift diagnostics '<file>:<line>:<col>: error: <message>' in an Xcode build log.",
    evidence:
      "The first compiler errors with file and position. For a React Native header ('RCT*.h') not found on React Native 0.87+, the React Native version (from the project, or the ReactNativeHeaders framework in the log).",
    versionScope:
      "Xcode 14+; header namespacing in React Native 0.87+ (prebuilt header XCFrameworks)",
    references: [
      "https://reactnative.dev/docs/integration-with-existing-apps",
      "https://guides.cocoapods.org/using/using-cocoapods.html",
      RN_NAMESPACED_HEADERS.source,
    ],
    lastVerified: RN_NAMESPACED_HEADERS.lastVerified,
    fixtures: ["logs/ios-header-not-found.log", "logs/real-rn087-ios-unnamespaced-header.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      if (!log.xcode.detected) continue;
      const errors = log.xcode.errors.filter((e) => e.file && !isSigningMessage(e.message));
      if (!errors.length) continue;
      const first = errors[0]!;
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

      const evidence: Evidence[] = errors
        .slice(0, 5)
        .map((e) => logEvidence(log.doc, e, `${e.file}:${e.position}`));
      out.push(
        finding(this.meta, {
          title: header
            ? `Header '${header[1]}' not found`
            : module
              ? `Swift module '${module[1]}' not found`
              : `Compiler error: ${first.message}`,
          severity: "error",
          confidence: header || module ? "medium" : "high",
          explanation:
            header || module
              ? `The compiler couldn't find ${header ? `the header ${header[1]}` : `the module ${module![1]}`} while compiling ${first.file}. This usually means the pods are out of sync with node_modules, the build opened the .xcodeproj instead of the .xcworkspace, or the native module that provides it isn't installed or linked.`
              : `Xcode reported ${errors.length} compiler error${errors.length === 1 ? "" : "s"}. The first is in ${first.file}: ${first.message}`,
          evidence,
          nextSteps:
            header || module
              ? [
                  "Reinstall pods: `cd ios && pod install` (Expo: `npx expo prebuild` or `npx pod-install`).",
                  "Build the .xcworkspace, not the .xcodeproj.",
                  "Check that the JavaScript package that provides the native module is installed and compatible with your React Native version.",
                  ...(bareRnHeader && !reactNativeVersion(ctx)
                    ? [
                        `If the project uses React Native ${RN_NAMESPACED_HEADERS.minReactNative.replace(/\.0$/, "")} or later, React Native headers must be imported with their namespace: \`#import <React/${bareRnHeader}>\`. Run this tool with --cwd pointing at the project so it can check the version.`,
                      ]
                    : []),
                ]
              : [
                  `Open ${first.file} at ${first.position} and fix the reported error.`,
                  "If the file is inside Pods or node_modules, check whether that library version supports your React Native and Xcode versions.",
                ],
          verification: "The Xcode build compiles the affected file.",
        }),
      );
    }
    return out;
  },
};

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
                "Set NODE_BINARY in ios/.xcode.env.local to the absolute path of node (`echo export NODE_BINARY=$(command -v node) > ios/.xcode.env.local`).",
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

export const iosLogRules: Rule[] = [
  cocoapodsIncompatibleVersions,
  cocoapodsSpecNotFound,
  codeSigning,
  nativeCompileError,
  linkerError,
  bundlePhaseFailedRule,
];
