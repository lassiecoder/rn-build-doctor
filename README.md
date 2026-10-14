# RN Build Doctor

Evidence-based diagnostics for React Native and Expo build, release, and startup failures.

`rn-build-doctor` reads your project and the logs you give it, runs deterministic checks, and tells you:

1. **What failed:** the primary error, not the final `BUILD FAILED` line.
2. **What evidence supports it:** log excerpts with original line numbers, and the project files and versions involved.
3. **What to check next:** specific steps, with a way to verify the fix.
4. **How to share it safely:** a redacted Markdown or JSON report you can review before posting.

It never guesses silently. When a log doesn't match a supported pattern, it says **"No supported diagnosis"** and shows the first error lines instead of inventing a cause. AI is optional, opt-in, and shown separately from verified findings.

> **Status: 0.1 preview.** The rule catalog is narrow on purpose: 39 rules, each with fixtures and a cited source. See [supported checks](docs/supported-checks.md) and [known limitations](#limitations).

## Install

Requires Node.js 22.12 or later.

```sh
npx rn-build-doctor --help          # run without installing
npm install --save-dev rn-build-doctor
```

## Quickstart

```sh
# 1. Check the project and local environment (offline)
npx rn-build-doctor scan

# 2. Analyze a failing build, device log, or crash report
npx rn-build-doctor analyze ./android-build.log
cd android && ./gradlew assembleRelease 2>&1 | npx rn-build-doctor analyze -   # or pipe it in

# 3. Export everything as a shareable, redacted report
npx rn-build-doctor report --output build-report.md
```

Example: the output for a real `npx expo export` failure (Expo SDK 57). The log is in `tests/fixtures/logs/real-expo57-metro-syntax.log`.

```text
ERROR F1 Syntax error in /Users/dev/realexpo/src/app/index.tsx (1:11)
      javascript.bundle-syntax-error · confidence high · javascript
      Babel couldn't parse /Users/dev/realexpo/src/app/index.tsx: Unexpected token.
      Evidence:
      - log real-expo57-metro-syntax.log:7
        │ SyntaxError: SyntaxError: /Users/dev/realexpo/src/app/index.tsx: Unexpected token (1:11)
        │
        │ > 1 | const x = (;
        │     |            ^
      Next steps:
      1. Fix the syntax at /Users/dev/realexpo/src/app/index.tsx:1:11.
      2. Run your type checker or linter to find similar problems.
      Verify: The bundle builds without the syntax error.
```

## Commands

| Command             | What it does                                                                                                    | Network                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `scan`              | Detects Expo / React Native CLI, native folders, versions, and package manager, then runs project checks        | none (`--expo-doctor` opts into running `npx expo-doctor`) |
| `analyze <logs...>` | Parses Gradle, Metro/Expo CLI, xcodebuild/xcpretty/EAS, CocoaPods, logcat, and iOS crash logs (`-` reads stdin) | none                                                       |
| `report`            | Merges saved `scan`/`analyze` results into Markdown (default) or JSON                                           | none                                                       |
| `explain`           | Optional: sends the redacted report to Anthropic and shows AI suggestions, labeled unverified                   | yes, after confirmation                                    |
| `doctor`            | Lists every check, supported inputs, and limitations                                                            | none                                                       |

Common options: `--cwd <dir>`, `--json`, `--no-save`, `--fail-on <error|warning|info|none>`, `--redact <value>` (repeatable), `--verbose`, `--no-color`.

`scan` and `analyze` save their results to `.rn-build-doctor/` in the project. The folder contains its own `.gitignore`, so reports are never committed.

**Exit codes:** `0` completed · `1` a finding at or above `--fail-on` · `2` invalid input or usage · `3` internal error · `4` AI provider failure.

### Use in CI

```yaml
- run: npx expo export --platform android 2>&1 | tee build.log
- if: failure()
  run: npx rn-build-doctor analyze build.log && npx rn-build-doctor report --output $GITHUB_STEP_SUMMARY
```

## What it can diagnose

| Area                  | Examples                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expo configuration    | invalid `app.json`, config plugins that aren't installed, packages outside the SDK's expected versions (from the installed `expo` package's data), committed native folders that ignore app config                                      |
| Environment variables | `EXPO_PUBLIC_` values read with bracket syntax, variables defined only in a git-ignored `.env` that EAS Build never receives, variables defined nowhere locally                                                                         |
| Android / Gradle      | unresolved dependencies, JDK vs AGP mismatches, Gradle too old, class-file version errors, missing SDK or licenses, AAR metadata (`compileSdk` / AGP requirements), duplicate classes, manifest merge failures, JS bundle task failures |
| Metro                 | unresolved modules (missing package, undeclared package, path alias, Node built-in, relative path case), Babel syntax errors                                                                                                            |
| iOS                   | CocoaPods version conflicts and missing specs, code signing, compile errors (including missing headers), linker errors, the bundle build phase (including `node` not found)                                                             |
| Runtime               | JavaScript exceptions, Android fatal exceptions (including "Unable to load script"), iOS crash reports (text and `.ips`), missing Info.plist usage descriptions, configuration-related startup errors                                   |

The full catalog with triggers, evidence, version scope, sources, and fixtures is in [docs/supported-checks.md](docs/supported-checks.md).

## How it decides

Every finding has a **confidence** level:

- **High:** the evidence directly satisfies the rule, for example the exact error line is present.
- **Medium:** the evidence matches a known pattern, but something important can't be observed. Example: a variable may exist in EAS, which a local scan can't read.
- **Low:** the symptom is suggestive but isn't enough to establish a cause.

Findings explain what is confirmed and what is only a hypothesis, and list the tool's own limitations for that case. High confidence in a diagnosis doesn't mean a fix is safe. Review each next step.

## Privacy

- `scan` and `analyze` run entirely locally. There's no telemetry, and the test suite fails if they open a network connection.
- Only supported config files and the logs you pass are read. `.env` files are parsed for variable **names**. Their values are never read into reports.
- Reports are redacted (tokens, keys, passwords, auth headers, cookies, private keys, URL credentials, sensitive environment values, and your home directory) before they're printed or saved. Redaction is best-effort, so review reports before sharing them.
- `explain` shows what will be sent and where, asks for confirmation, and supports `--dry-run`. It never runs suggested commands or edits files.

Details: [docs/privacy.md](docs/privacy.md).

## Benchmark

The labeled regression benchmark (`npm run benchmark`) has **64 cases**: 49 log cases and 15 project cases. Sixteen of the logs were captured from real builds with deliberately introduced failures: a fresh `create-expo-app` project (Expo SDK 57, React Native 0.86, Gradle 9.3.1, CocoaPods 1.16, Xcode 26.6), two React Native CLI apps (React Native 0.86 and 0.87, Gradle 9.3 and 9.4, AGP 8.12 and 9.2, Kotlin 2.1 and 2.2), and an Android 14 emulator. The rest are synthetic logs that reproduce documented error formats, including near misses that must not trigger rules. The current result is **100% precision, 100% recall, and 0 false positives**.

The authors built this small benchmark alongside the rules, so treat it as a regression gate, not as proof of real-world accuracy. Real, anonymized failure logs are the most valuable contribution.

## Limitations

- Only listed patterns are diagnosed. Everything else gets an honest "no supported diagnosis" with excerpts.
- It can't see EAS or CI environment variables, cloud build logs, or devices unless you supply logs.
- It doesn't run builds. iOS logs can be analyzed on any OS, but reproducing an Xcode build needs macOS.
- `app.config.js`/`ts` are read as text, never executed. Plugins declared only in dynamic config aren't checked.
- Redaction can miss secrets in unusual formats.

## Documentation

- [Architecture](docs/architecture.md)
- [Supported checks](docs/supported-checks.md)
- [Privacy](docs/privacy.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Demo walkthrough](docs/demo.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
