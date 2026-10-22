## What this changes

<!-- One or two sentences. Link the issue it fixes, if there is one. -->

## Type of change

- [ ] New rule
- [ ] Fix to an existing rule (wrong diagnosis, explanation, or next step)
- [ ] Parser, report, or CLI change
- [ ] Docs only

## For rule changes

<!-- Skip this section if no rule changed. See CONTRIBUTING.md, "Adding a diagnostic rule". -->

- **Source:** <!-- official docs, or an issue with a confirmed resolution -->
- **Log:** <!-- real (how it was captured: tool versions) or synthetic (which documented format it reproduces) -->

- [ ] The rule's `meta` is complete: trigger, evidence, version scope, references, lastVerified, fixtures.
- [ ] Regression cases in `tests/regression/cases.ts`, including near misses that must not trigger the rule.
- [ ] Version-sensitive facts are in `compat.ts` (or a sibling) with a source URL and date.
- [ ] `docs/supported-checks.md` is regenerated (`npm run build && npm run catalog`).
- [ ] Error and warning findings carry evidence. Confidence matches what the evidence shows.

## Checks

- [ ] `npm run check` passes (typecheck, lint, format, build, tests).
- [ ] No network access added to `scan`, `analyze`, `report`, or `doctor`.
- [ ] No secret values read, logged, or stored. Fixtures are anonymized (paths, names, tokens).
- [ ] The tool still only reads project files and recommends changes; it doesn't modify them.

<details>
<summary>Benchmark output (<code>npm run benchmark</code>)</summary>

```text
<!-- paste the "benchmark: N cases, TP …, precision …, recall …" line -->
```

</details>
