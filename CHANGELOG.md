# Changelog

## Unreleased

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
