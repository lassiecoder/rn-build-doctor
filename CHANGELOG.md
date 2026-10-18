# Changelog

## Unreleased

Fixes from testing one failure at each stage (development, release build, crash after install) on a React Native CLI app (0.87) and an Expo SDK 58 app, with real logs.

- New rule `android.native-min-sdk-below-library`: `[CXX1214] User has minSdkVersion 23 but library was built for 24`. On React Native 0.87 and Expo SDK 58, lowering minSdk fails in a CMake configure task, not in the manifest merger, and was reported as "No supported diagnosis". Expo projects get the expo-build-properties fix.
- New rule `expo.config-plugin-not-resolved`: `PluginError: Failed to resolve plugin for module "X"` from prebuild or EAS Build was reported as "No failure detected". It now says whether the plugin package isn't declared, isn't installed, or is a local file that doesn't exist. `PluginError:` and `ConfigError:` lines also count as failures for the fallback rules.
- `runtime.javascript-exception`: logcat excerpts show only the exception's thread, so lines from other threads (such as image decoders) no longer push out the JavaScript stack. When the process is then killed by a signal (bridgeless apps abort with SIGABRT on the JS thread), the finding says the app crashed and cites the signal line, instead of reporting a separate native crash.
- `javascript.unable-to-resolve-module`: Expo CLI prints each resolver error twice (relative and absolute path). They're now one finding.
- `runtime.missing-configuration-suspected`: tagged `expo` only for Expo projects.

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
