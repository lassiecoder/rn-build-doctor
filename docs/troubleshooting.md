# Troubleshooting

## "No supported diagnosis for this failure"

The log has errors, but none match a rule. This is intentional: the tool shows the first error lines rather than guessing. Next steps:

- Make sure the log contains the **first** error, not only the summary. For Gradle, re-run with `--stacktrace` or `--info`. For EAS, download the full build log from the build page.
- Run `rn-build-doctor explain` for AI suggestions, labeled unverified.
- Open an issue with the (reviewed, redacted) report so a rule can be added.

## "No failure detected in the log"

No error markers were found. The log may be cut off before the failure, or it may come from a successful build while the real problem happens at runtime. For startup crashes, capture `adb logcat` (Android) or the device console or crash report (iOS) and analyze that.

## The project isn't detected

`scan` needs a `package.json` that depends on `react-native` or `expo`. In a monorepo, run it from the app package or pass `--cwd apps/mobile`. Log analysis works without a project.

## Windows: garbled or empty log analysis

PowerShell's `>` writes UTF-16. The tool detects UTF-16 with or without a byte-order mark. If detection still fails, write logs with `| Out-File -Encoding utf8 build.log`.

## Huge logs

Logs above 32 MB are read from the beginning and the end, and the middle is omitted. Line numbers still refer to the original file. Raise the limit with `--max-log-mb 128` if the failure is in the middle.

## Java version shows the wrong JDK

`scan` reports the JDK from `JAVA_HOME`, falling back to `java` on `PATH`. Gradle may use `org.gradle.java.home` or Android Studio's Gradle JDK instead. `cd android && ./gradlew --version` shows what Gradle actually uses.

## `explain` fails

- _"Refusing to send without confirmation"_: you're in a non-interactive shell. Add `--yes`, or use `--dry-run` to inspect the payload first.
- _Credentials rejected_: set `ANTHROPIC_API_KEY` or run `ant auth login`.
- _Timed out_: use `--timeout 300`.

AI failures exit with code 4 and don't affect saved findings.

## A finding looks wrong

Please open an issue with the report. Every rule has fixtures, and false positives are treated as bugs: a regression test is added before the fix.
