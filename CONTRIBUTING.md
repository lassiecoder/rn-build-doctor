# Contributing

Thanks for helping. The most valuable contributions are **real, anonymized failure logs** and **rules that diagnose them correctly**. False positives count as bugs.

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part, you agree to it.

## Setup

```sh
npm ci
npm run check      # typecheck, lint, format check, build, tests
npm run benchmark  # labeled regression cases only
```

## Adding a diagnostic rule

Every rule needs evidence that it's right. Follow these steps in order:

1. **Find the source.** Use official documentation, or an issue with a _confirmed_ resolution. A similar stack trace or one user comment isn't proof of cause.
2. **Define the exact trigger** (an error signature or a verifiable condition) and the evidence the finding will carry.
3. **Add fixtures** under `tests/fixtures/logs/` or `tests/fixtures/projects/`. Prefer real logs with paths, names, and secrets anonymized. Synthetic logs must reproduce the real format exactly.
4. **Write the regression cases first** in `tests/regression/cases.ts`: the expected rule ids, plus near-miss logs that must **not** trigger the rule.
5. **Implement the rule** in `src/rules/<platform>/`, filling in every `meta` field: `trigger`, `evidence`, `versionScope`, `references`, `lastVerified`, `fixtures`. Put version-sensitive data in `src/rules/android/compat.ts` (or a sibling) with its source and date.
6. **Register it** in `src/engine/registry.ts`, run `npm run build && npm run catalog`, and commit the regenerated `docs/supported-checks.md`.
7. Run `npm run check`.

Rule guidelines:

- Confidence: **high** only when the evidence directly satisfies the condition. Use **medium** when an important detail can't be observed, and **low** when the evidence is only suggestive.
- Explanations must separate what's confirmed from what's hypothesized.
- Next steps must be specific and safe, and include how to verify the fix.
- Never read secret values or execute project code. Don't add network access to `scan` or `analyze`.

## Commits and pull requests

Keep architecture, individual rules, report changes, and AI changes in separate commits. Describe the source for each rule and include the benchmark output in the PR.

## Reporting a wrong diagnosis

Open a "Wrong or missing diagnosis" issue with the redacted report (`rn-build-doctor report`). Review it for secrets before posting.
