# Privacy and data handling

## What runs locally

`scan`, `analyze`, `report`, and `doctor` make **no network requests**. The integration tests preload a guard that fails the test if these commands open a socket, resolve DNS, or call `fetch`. There's no telemetry.

The one optional exception is `scan --expo-doctor`, which runs `npx expo-doctor`. That downloads the package and lets Expo's tool fetch its compatibility data. It's off by default.

## What is read

| Input                                                                                       | What's read                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `app.json`, `eas.json`, Gradle and Podfile files, `.gitignore`/`.easignore` | Parsed for configuration and versions (up to 2 MB per file)                                                                                                                                     |
| `app.config.js` / `app.config.ts`                                                           | Read as **text** to find `process.env` references. Never executed                                                                                                                               |
| `.env`, `.env.*`                                                                            | Only variable **names** are kept. Values are discarded while parsing                                                                                                                            |
| App source (`*.js/ts/jsx/tsx`)                                                              | Scanned for `process.env.EXPO_PUBLIC_*` references, with limits: 5,000 files, 512 KB each, depth 12. Skips `node_modules`, `android`, `ios`, build folders, hidden folders, tests, and symlinks |
| `node_modules/<pkg>/package.json`                                                           | Installed versions, and `expo/bundledNativeModules.json`                                                                                                                                        |
| Environment                                                                                 | Variable **names**, `JAVA_HOME`/`java -version` (only when an `android/` folder exists; disable with `--no-java-probe`), whether `ANDROID_HOME` exists                                          |
| Logs                                                                                        | Only the files you pass (or stdin). Logs larger than `--max-log-mb` (default 32) keep their beginning and end                                                                                   |

The tool never reads your home directory, walks the whole repository, or follows symlinks.

## Redaction

Before anything is printed, saved, or sent, every string in the report passes through the redactor (`src/reports/redact.ts`). It replaces:

- Private key blocks, `Authorization`/`Proxy-Authorization` header values, `Cookie`/`Set-Cookie` values
- Credentials in URLs (`https://user:password@host`) and sensitive query parameters (`token`, `key`, `signature`, `X-Amz-*`, …)
- JWTs and well-known token formats: AWS access keys, GitHub, npm, Slack, Google API, Stripe, Anthropic and OpenAI style keys
- `KEY=value`, `"key": "value"`, and YAML `key: value` assignments whose key looks sensitive (password, secret, token, api key, credential, signature, keystore/store password, DSN, …), plus Gradle `storePassword '…'`
- The literal values of environment variables with sensitive-looking names in the current shell (for example `GITHUB_TOKEN`, `SENTRY_AUTH_TOKEN`)
- Any literal you pass with `--redact <value>`
- Your home directory path, replaced with `~`

**Redaction is best-effort.** Secrets in unusual formats can slip through. Review a report before you post it or send it to an AI provider. The report records how many replacements were made.

## Saved reports

`scan` and `analyze` write `.rn-build-doctor/scan.json` / `analyze.json` in the project, together with a `.gitignore` containing `*`, so they aren't committed. Use `--no-save` to skip writing. Delete the folder at any time. Nothing else is stored.

## AI (`explain`)

- Off unless you run `explain`.
- Sends only the redacted findings and project summary, not raw logs, to the Anthropic API (or `ANTHROPIC_BASE_URL`). Credentials come from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `ant auth login`.
- Shows the destination, model, and payload size, and asks for confirmation. `--dry-run` prints the exact content without sending. Non-interactive use requires `--yes`.
- The response can't modify findings, files, or confidence levels. Suggested commands are displayed, never executed.
- Anthropic's handling of API data is governed by your agreement with Anthropic.
