# Changelog

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
