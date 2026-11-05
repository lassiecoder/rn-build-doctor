# Changelog

## 0.1.10 (2026-11-05)

From the open items in the 2026-10-28/29 thread research, and a sweep of the 169 issues opened in expo/expo, react/react-native and expo/eas-cli between Oct 28 and Nov 5, 2026. Each log was run through the tool before and after; version facts were checked against the projects' sources (foojay's README, React Native's stable branches, Expo's docs and @expo/package-manager, Gradle's start scripts, npm's docs) on 2026-11-05.

Wrong or misleading output fixed:

- `android.gradle-version-too-low`: the title no longer reads "Gradle 8.5. is below …".
- CocoaPods errors relayed by Expo CLI (`Command \`pod install\` failed.`/`└─ Cause: …`) were reported as "No failure detected"; they now reach the CocoaPods rules, and the line counts as a failure.
- `ios.deployment-target-unsupported` accepts Expo CLI/xcpretty's `❌` form, which `ios.compile-error` used to claim with "Open undefined at undefined". `ios.compile-error` names the target when there's no file and no longer prints a doubled period.
- `android.compile-error`: errors in generated code (`build/generated/…`) are no longer blamed on the package version.
- `javascript.unable-to-resolve-module`: imports with Windows backslashes (`..\assets\x`) are no longer blamed on a missing file or letter case.
- `android.dependency-resolution`: an HTTP status (`Received status code 403 from server`) is named with its host, and refusals no longer suggest that the version doesn't exist.
- "No supported diagnosis" excerpts show the line before `Command … failed` and put `** BUILD FAILED **` last.

New rules: `android.java-not-found`, `android.jdk-not-found` (scan), `android.autolinking-stale-path`, `android.cmake-cache-stale`, `android.hermes-source-missing` (fixed in React Native 0.89.0-rc.0), `android.r8-class-descriptor-mismatch`, `android.foojay-gradle9-incompatible` (React Native 0.82–0.85 pin foojay 0.5.0), `ios.stale-node-binary`, `ios.xcode-env-stale-node` (scan), `ios.swift-compiler-crash`, `expo.config-plugins-module-missing`, `expo.autolinking-script-failed`, `expo.config-evaluation-failed`, `javascript.hermes-compile-error`, `javascript.dev-engines-mismatch`.

Better answers:

- Runtime: `Cannot find native module 'X'` without an earlier native error gives the rebuild / Expo Go / version checklist and, with the project, names the installed package that requests the module. `native call failed: java.lang.NoSuchMethodError` is reported as a native binary mismatch. Android fatal exceptions point at the first app frame, suggest `adb logcat -b crash -d`, use the deepest cause in the title for wrapper exceptions, and explain missing `java.*` classes (java.time before API 26). `No script URL provided` (iOS) is a bundle-load failure. "Missing … credentials" counts as missing configuration, with the SDK 55+ `eas update --environment` behavior.
- Android Studio's Logcat window format and logcat trimmed to `E Tag: message` are recognized.
- `javascript.lockfile-out-of-sync` says when missing entries are peer dependencies (legacy-peer-deps), reading only that key from `.npmrc`.
- `android.compile-error` shows androidx versions a library pins when it calls an unresolved API.
- `ios.uiscene-lifecycle-required` points out `"image": "latest"` in eas.json; `ios.xcode27-simulator-app-not-found` covers Xcode 27.2's `identified as 'com.apple.dt.Xcode'`.
- Small fixes: `EXIT.ai` replaces a literal exit code, and dead code in project detection was removed.

## 0.1.9 (2026-10-25)

Gaps from an audit of the build and setup failures in 1,982 issues opened between Jul 25 and Oct 25, 2026 in expo/expo, react/react-native, eas-cli and 27 popular libraries. Each issue body was run through 0.1.8: of the ~300 build-related issues, 11 got a specific diagnosis before this release and 32 after. Every new rule was reproduced locally (npm/Yarn/pnpm/Bun, CocoaPods 1.16.2, Kotlin 2.1.20, Xcode 26.6, AGP 9.2.1 with an API 34 emulator, dyld) or, where that wasn't possible (Xcode 27), checked against the published package contents and the issue's maintainer replies.

- New rule `javascript.lockfile-out-of-sync`: frozen-lockfile failures of npm (`npm ci … are in sync`), Yarn 1, pnpm (`ERR_PNPM_OUTDATED_LOCKFILE`) and Bun, with the packages listed as missing and, with the project, the lockfiles present.
- New rule `ios.cocoapods-invalid-spec`: `No podspec found for X in path` (and whether the folder has a podspec with another name), `Invalid X.podspec file` with the package and line from CocoaPods' trace (including Expo prebuild's wrapper), `Invalid Podfile file`, and podspec validation errors.
- New rule `ios.cocoapods-not-found`: `spawn pod ENOENT` and `command not found: pod`, with EAS-specific steps when the log shows EAS Build phases.
- New rule `android.kotlin-metadata-incompatible`: `Class 'X' was compiled with an incompatible version of Kotlin`. When the class comes from Gradle itself (Gradle 9.4+ embeds Kotlin 2.3), the finding names the newest Gradle that the build's Kotlin compiler can read, from the Gradle compatibility table.
- New rule `android.r8-removed-constructor`: release crashes with `NoSuchMethodException: X.<init>` or Room's `Failed to create an instance of class X`, with keep rules (the WorkManager/Room rules from expo/expo#52173) and Expo's `extraProguardRules`. The generic fatal-exception finding no longer repeats it.
- New rule `runtime.hermes-bytecode-mismatch`: `Compiling JS failed: Wrong bytecode version. Expected N but got M`.
- New rules for Xcode 27: `ios.xcode27-simulator-app-not-found` (DeviceHub; @expo/cli 56+ and eas-cli 24.4.2+ support it), `ios.xcode27-exit-code-0-failure` (expo-modules-jsi 58.0.4+ fixes it; not released for SDK 57), `ios.uiscene-lifecycle-required` (React Native 0.88 / Expo SDK 58, or SDK 57's opt-in).
- New rule `ios.codegen-dependency-cycle`: `Cycle in dependencies between targets`, and, with the project, an app `codegenConfig` whose jsSrcsDir has no spec files.
- New rule `ios.dyld-launch-failure`: `Library not loaded` (framework not embedded) and `Symbol not found` at launch, including expo 58.0.8's `_swift_allocateMetadataPack` (fixed in 58.0.9).
- `ios.compile-error`: names the dependency (npm package or pod target) a compile error belongs to, with its installed version. Says when the Xcode in the log is older than the Expo SDK's documented minimum (26.4 for SDK 56-58). For `'React/…' file not found` in Expo SDK 56/57 projects with expo-modules-autolinking before the fix (57.0.10; partly 56.0.22), names that bug and the fixed version. Reads excerpts without xcodebuild markers when they name Apple source files, errors split over two lines, and Swift errors without a column.
- `android.compile-error`: names the library from the failing task (`:react-native-x:compileReleaseKotlin`) when the file path is trimmed, and reads `e: File.kt:1:2` with the message on the next line.
- `javascript.unable-to-resolve-module`: reads `Unable to resolve module X` with `from Y` on the next line.

## 0.1.8 (2026-10-25)

Gaps found in GitHub issues from Oct 20-25 (React Native 0.88 / Expo SDK 58). The two Android failures were reproduced on a Gradle 9.4.1 build (AGP 9.2.1, and AGP 8.12.0 to check the version scope) before the rules were written.

- New rule `android.proguard-android-txt-unsupported`: AGP 9's ``getDefaultProguardFile('proguard-android.txt')` is no longer supported`` was reported as "No supported diagnosis". It now names the library (from the build file path in the log, or the project), quotes the line, and gives the `proguard-android-optimize.txt` patch and the `android.r8.proguardAndroidTxt.disallowed=false` opt-out (both verified to fix the reproduced build; AGP 8.12.0 accepts the old file).
- New rule `android.compile-sdk-not-specified`: `does not specify compileSdk in build.gradle` was reported as "No supported diagnosis". When it comes with `Parameter specified as non-null is null: method ...onGradlePropertyAccess, parameter propertyName`, the finding explains that both errors have one cause, a property name passed unquoted (`safeExtGet(compileSdkVersion, 31)`), and lists the unquoted lines from the library's build.gradle. Quoting the names was verified to fix the reproduced build.
- `javascript.unable-to-resolve-module`: for a package subpath (`some-package/icons/trash-2`), the finding no longer says the package can't be found. With the project, it checks the installed package's `exports`: when the exported path points to a file that isn't there, it says reinstalling or clearing the cache won't help, notes when a `.d.ts` explains why TypeScript accepts the import, and suggests the subpath that the declaration re-exports when that file exists.
- `runtime.javascript-exception` and `runtime.android-fatal-exception`: `Cannot find native module 'X'` after a native error in the same process (for example `Cannot install Expo Modules v2: java.lang.NoClassDefFoundError: ... java/nio/file/Path`) now points to the native error instead of saying "the cause is in JavaScript". Without an earlier native error, the fatal finding lists the usual causes (rebuild after installing, Expo Go, a module that failed to initialize).

## 0.1.7 (2026-10-23)

Gaps found in GitHub issues from the week after the Expo SDK 58 / React Native 0.88 releases. The two Android failures were reproduced on an AGP 9.2.1 / Gradle 9.4.1 build before the rules changed.

- `android.aar-metadata-check`: when the module that fails the check is a library (`:amplitude_experiment-react-native-client is currently compiled against android-31`), the finding no longer says to raise the app's compileSdk, which doesn't help. It names the npm package behind the Gradle project, says when the app's compileSdk is already high enough, quotes the compileSdk lines from the library's android/build.gradle, and suggests upgrading or patching the library. Failures in `:app` keep the previous advice.
- `android.dependency-resolution`: `Could not find org.greenrobot:eventbus:.` (an empty version) is reported as a dependency declared without a version, instead of "the version may not exist in a repository". The finding explains the AGP 9 change to `android.dependency.useConstraints`, names the package that declares the dependency, and gives the `android.dependency.useConstraints=true` workaround (verified to fix the reproduced build). The suggested `dependencies` command now uses the failing project instead of always `:app`.
- New rule `ios.deployment-target-unsupported`: Xcode 27's `The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 13.0, but the range of supported deployment target versions is 15.0 to 27.0.x` was reported as "No supported diagnosis". It now names the pod (from the target name, for example `AsyncStorage` for `AsyncStorage-AsyncStorage_resources`), takes the supported range from the error itself, and gives the Podfile post_install workaround. The same message as a warning doesn't trigger it.

## 0.1.6 (2026-10-20)

Fixes from testing one failure at each stage (development, release build, crash after install) on a React Native CLI app (0.87) and an Expo SDK 58 app, with real logs.

- New rule `android.native-min-sdk-below-library`: `[CXX1214] User has minSdkVersion 23 but library was built for 24`. On React Native 0.87 and Expo SDK 58, lowering minSdk fails in a CMake configure task, not in the manifest merger, and was reported as "No supported diagnosis". Expo projects get the expo-build-properties fix.
- New rule `expo.config-plugin-not-resolved`: `PluginError: Failed to resolve plugin for module "X"` from prebuild or EAS Build was reported as "No failure detected". It now says whether the plugin package isn't declared, isn't installed, or is a local file that doesn't exist. `PluginError:` and `ConfigError:` lines also count as failures for the fallback rules.
- `runtime.javascript-exception`: logcat excerpts show only the exception's thread, so lines from other threads (such as image decoders) no longer push out the JavaScript stack. When the process is then killed by a signal (bridgeless apps abort with SIGABRT on the JS thread), the finding says the app crashed and cites the signal line, instead of reporting a separate native crash.
- `javascript.unable-to-resolve-module`: Expo CLI prints each resolver error twice (relative and absolute path). They're now one finding.
- `runtime.missing-configuration-suspected`: tagged `expo` only for Expo projects.

Gaps found in recent React Native 0.87 / Expo SDK 58 reports, each reproduced on a real React Native 0.87 app before the rule was written:

- `ios.compile-error`: on React Native 0.87+, `'RCTBridge.h' file not found` (any bare `RCT*.h` import) now says the import needs the `React/` namespace (`#import <React/RCTBridge.h>`) and names the package, instead of advising `pod install`, which doesn't help. The version comes from the project, or from the ReactNativeHeaders framework in the log (medium confidence). Older React Native versions keep the previous advice.
- New rule `android.builtin-kotlin-conflict`: AGP 9 `Failed to apply plugin 'org.jetbrains.kotlin.android'` with `Cannot add extension with name 'kotlin'` or the new-DSL `ClassCastException` was reported as "No supported diagnosis". It now points to the `android.builtInKotlin=false` / `android.newDsl=false` opt-out the templates use, and shows what the project's gradle.properties sets.
- New rule `android.ninja-path-too-long`: `ninja: error: ... Filename longer than 260 characters` on Windows, with the SDK CMake/ninja version from the log and the long-path, ninja 1.12+, and short-path fixes.
- New rule `android.cleartext-http-blocked`: in a release build, a blocked `http://` request reaches JavaScript only as `TypeError: Network request failed`. When the project's release build blocks cleartext (manifest, React Native Gradle plugin placeholder, or Expo default) and the source has an `http://` URL, the finding names the URL and the setting. OkHttp's `CLEARTEXT communication ... not permitted` line is diagnosed directly.
- `runtime.javascript-exception`: titles no longer end in a stray `]` when `console.error` prints an error object (`[TypeError: Network request failed]`). "Network request failed" gets network-specific next steps instead of "search your source for the message".

## 0.1.5 (2026-10-18)

Documentation and package metadata only; no behavior changes.

- README: new "Error messages it recognizes" section listing the exact error messages the rules match, so developers searching for an error can find the tool.
- npm: a fuller package description and more keywords (EAS Build, Android Gradle Plugin, JDK, Kotlin, xcodebuild, pod install, logcat, crash reports, code signing, and more).

## 0.1.4 (2026-10-15)

Documentation only.

- README: recipes for common failures, `set -o pipefail` in the CI example (without it the step takes `tee`'s exit code), `ANTHROPIC_API_KEY` and `--dry-run` for `explain`, and absolute GitHub links for files that aren't in the npm package.

## 0.1.3 (2026-10-15)

Fixes from retesting 0.1.2 the same way, with live pipes from real builds and an emulator.

- New rule `runtime.js-bundle-not-loaded`: the app can't load its JavaScript bundle. With the New Architecture, a debug app that can't reach Metro shows a red screen and logs "Unable to load script" without a fatal exception, so it was reported as "No failure detected". Also covers iOS "No bundle URL present".
- CocoaPods: `[!]` warnings such as "hermes-engine has added 1 script phase", printed on every fresh React Native install, are no longer treated as failures. A completed `pod install` is reported as successful.
- `android.compile-error`: a javac-only failure is called a Java error, and the explanation reads "The Java compiler reported 1 error, so :app:compileDebugJavaWithJavac failed."
- `android.jvm-option-unrecognized`: when the option is found in android/gradle.properties, the explanation names that line instead of also listing GRADLE_OPTS and JAVA_OPTS.
- `runtime.missing-configuration-suspected`: React Native CLI projects get advice about .env files and libraries such as react-native-config instead of EAS commands.

## 0.1.2 (2026-10-15)

Fixes from testing 0.1.1 against two real React Native CLI apps (0.86 and 0.87) on Android, iOS, and an emulator.

- New rule `android.compile-error`: Kotlin (1.x and 2.x formats) and javac errors, with the file, position, and, for files inside `node_modules`, the npm package that owns them.
- New rule `android.jvm-option-unrecognized`: Gradle's daemon fails to start because the JVM rejects an option such as `-XX:MaxPermSize` from `org.gradle.jvmargs` (old React Native templates on JDK 17+). Points to the line in `android/gradle.properties`.
- `ios.linker-error`: recognizes the Xcode 15+ linker message `ld: library 'X' not found`. It was reported as "Undefined symbols" with unrelated advice. Missing libraries now get their own next steps.
- Runtime logs: excerpts from an interleaved `adb logcat` show only lines from the crashing process. Errors that follow from an earlier one (`"App" has not been registered`, `Global was not installed`) are listed as evidence of the first error instead of as separate findings.
- `android.manifest-merger-failed`: a library that needs a higher `minSdk` gets a specific title and fix (raise minSdk or use another library version).
- `ios.cocoapods-incompatible-versions`: a requested version that doesn't exist is no longer described as a conflict.
- A successful `react-native bundle` / `expo export` log is reported as successful instead of "may be incomplete".
- Metro errors for relative imports no longer show a stray colon after the file name.
- `scan` shows the JDK and Node.js version it used (`this machine: …`) in the terminal, Markdown, and JSON (`project.environment`).

## 0.1.1 (2026-10-15)

- Fix: `analyze -` crashed with `EAGAIN` when piped from a build that is still running (for example `./gradlew assembleRelease 2>&1 | npx rn-build-doctor analyze -`). Stdin is now read as a stream.
- Docs: troubleshooting entry for `npx` hanging inside projects stored in iCloud-synced folders.

## 0.1.0 (2026-10-14)

- `scan`, `analyze`, `report`, `explain`, and `doctor` commands
- 37 rules across Expo configuration, environment variables, Android/Gradle, Metro, iOS/CocoaPods/Xcode, and runtime/crash logs, plus honest fallbacks
- Log reader with UTF-16 detection, ANSI and CI-timestamp stripping, and head+tail reading for huge logs with original line numbers
- Versioned JSON report (schema 1.0) and Markdown export, with redaction applied to all output
- Optional AI explanations (Anthropic) with confirmation, dry run, schema validation, and evidence-reference checks
- Labeled regression benchmark, including logs captured from real Expo SDK 57, Gradle 9.3, CocoaPods, and Xcode 26 builds
