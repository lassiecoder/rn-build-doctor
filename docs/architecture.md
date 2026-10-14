# Architecture

RN Build Doctor is a single TypeScript CLI package with no backend. Everything runs locally except the optional `explain` command.

```
            ┌──────────────┐     ┌──────────────┐
 project ──▶│  detection   │     │  collectors  │◀── log files / stdin
  files     │ project-type │     │ build-logs   │    (encoding, ANSI, CI
            └──────┬───────┘     └──────┬───────┘     timestamps, size limit)
                   │                    ▼
                   │             ┌──────────────┐
                   │             │   parsers    │ gradle · metro · xcode/cocoapods · runtime
                   │             └──────┬───────┘
                   ▼                    ▼
            ┌─────────────────────────────────────┐
            │ engine: runner + registry            │
            │  project rules ─┐                    │
            │  log rules ─────┼─▶ drafts ─▶ post   │  fallbacks: "no supported diagnosis",
            │                 │      rules         │  "no failure detected"
            │  dedupe · sort · assign ids · Zod    │
            └──────────────────┬──────────────────┘
                               ▼
            ┌─────────────────────────────────────┐
            │ reports: buildReport → Redactor      │──▶ terminal · JSON · Markdown
            │ (every string redacted, then Zod)    │──▶ .rn-build-doctor/{scan,analyze}.json
            └──────────────────┬──────────────────┘
                               ▼ (opt-in)
            ┌─────────────────────────────────────┐
            │ ai: buildAiRequest (re-redacted) →   │──▶ "AI suggestions — unverified"
            │ provider → schema check → reference  │
            │ check against report finding ids     │
            └─────────────────────────────────────┘
```

## Source layout

| Path                            | Responsibility                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/`                      | `commander` program, option parsing, exit codes, terminal formatting                                                                                                                                                              |
| `src/detection/project-type.ts` | Detects Expo / React Native CLI / monorepo root, native folders, lockfiles, versions (RN, Expo, Gradle wrapper, AGP, SDK levels, Podfile target). Never executes project code.                                                    |
| `src/collectors/`               | Safe reading of config files (size limits, no symlink following), bounded source scanning for `process.env` references, `.env` name parsing, ignore-file matching, environment snapshot (variable **names**, JDK, Android SDK)    |
| `src/collectors/build-logs.ts`  | Log reader: UTF-8/UTF-16 detection, binary rejection, ANSI/timestamp/`\r` normalization, head+tail reading for huge logs with original line numbers                                                                               |
| `src/parsers/`                  | Format-specific extraction: Gradle "What went wrong" sections, Metro resolver and syntax errors, Xcode/xcpretty errors and failed commands, CocoaPods `[!]` errors, logcat JS/fatal exceptions, iOS text and `.ips` crash reports |
| `src/rules/`                    | Typed rules grouped by platform; version-sensitive data in `rules/android/compat.ts` with source and verification date                                                                                                            |
| `src/engine/`                   | Rule interface, registry, deterministic runner                                                                                                                                                                                    |
| `src/reports/`                  | Zod schemas, redaction, report building, Markdown export, merge                                                                                                                                                                   |
| `src/ai/`                       | Provider-neutral interface, Anthropic implementation, prompt building, response checks                                                                                                                                            |

## Finding schema

Defined with Zod in `src/reports/schema.ts`. Every finding has:

| Field                  | Notes                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| `id`                   | `F1`, `F2`, … assigned after sorting; AI suggestions reference these    |
| `ruleId`               | Stable, e.g. `android.dependency-resolution`                            |
| `title`, `explanation` | Explanation separates confirmed facts from hypotheses                   |
| `severity`             | `error` · `warning` · `info`                                            |
| `confidence`           | `high` · `medium` · `low` (see [supported checks](supported-checks.md)) |
| `platforms`            | `android`, `ios`, `expo`, `javascript`, `common`                        |
| `evidence[]`           | `{ source: log                                                          | project | environment, file?, line? (original, 1-based), excerpt?, detail? }`; each item needs an excerpt or a detail |
| `nextSteps[]`          | At least one                                                            |
| `references[]`         | Authoritative URLs                                                      |
| `verification?`        | How to confirm the fix                                                  |
| `limitations[]`        | What this finding cannot establish                                      |

**Validation rule:** `error` and `warning` findings must have at least one evidence item. A rule that produces an invalid finding doesn't crash the run. The runner replaces the finding with an `internal.rule-error` info finding, so unvalidated output never reaches a report.

**Missing evidence** is represented explicitly. An info finding may have an empty `evidence` array, and findings carry `limitations` for what couldn't be observed. A finding never invents evidence.

## Report format

`schemaVersion: "1.0"`. A report contains the tool version, command (`scan`, `analyze`, `merged`), timestamp, project summary, inputs (path, detected formats, line count, truncation, encoding), findings, summary counts, and redaction metadata. Reports are validated on write and on read. `report --input` rejects corrupt or foreign files with a path-level error message.

Saved reports live in `<project>/.rn-build-doctor/scan.json` and `analyze.json`. `report` and `explain` merge them and renumber the finding ids.

## Rule engine

```ts
interface Rule {
  meta: RuleMeta; // id, title, platforms, scope, trigger, evidence, versionScope, references, lastVerified, fixtures
  run(ctx: { project?; env?; logs: ParsedLog[] }): DraftFinding[];
}
```

The runner:

1. Runs project rules (`scan`) or log rules (`analyze`). Each rule is isolated by try/catch.
2. Runs **post rules** with all drafts. These are the honest fallbacks: a log with failure markers but no error or warning finding gets `common.no-supported-diagnosis` with the first error excerpts, and a log without failures gets `common.no-failure-detected`.
3. Deduplicates by rule, title, and first evidence location.
4. Sorts by severity, confidence, file, line, and rule id. No timestamps or randomness are involved, so the same input produces the same findings.
5. Assigns ids and validates each finding.

There is no plugin system. Rules are plain objects registered in `src/engine/registry.ts`. A test fails if a rule lacks metadata, fixtures, sources, or documentation in `docs/supported-checks.md` (generated with `npm run catalog`).

## Version-sensitive knowledge

Version-dependent facts aren't hardcoded across rules. They live in `src/rules/android/compat.ts` with their source URL and `lastVerified` date. Examples are the Java-to-Gradle table and the AGP 8 / React Native 0.73 JDK 17 requirement. Rules prefer versions the tool reports itself, such as "Minimum supported Gradle version is X". Expo package compatibility comes from the `bundledNativeModules.json` of the project's installed `expo` package, the same data `npx expo install --check` uses, rather than from a copied table.

## AI layer

`explain` is the only command that sends data anywhere:

1. Saved reports are merged and **redacted again**. Only findings and the project summary are sent, not raw logs.
2. The user sees the destination, model, and size, and must confirm (`--yes` in scripts). `--dry-run` prints the exact payload.
3. The Anthropic provider uses the official SDK with structured output (Zod schema). By default it requests `claude-opus-5-5`, and the API's default refusal fallback is enabled.
4. The response is validated again locally. Causes that cite no existing finding id are labeled **"not supported by any report finding"**, and invented ids are dropped and reported.
5. Output is shown under "AI suggestions — unverified". It can't change finding confidence, and proposed commands are only displayed, never executed.

New providers implement `AiProvider` in `src/ai/provider.ts`.

## Dependencies

Runtime: `commander`, `picocolors`, `zod`, `json5`, `semver`, `@anthropic-ai/sdk` (loaded only by `explain`'s code path). There's no database, server, or telemetry.
