# Changelog

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
