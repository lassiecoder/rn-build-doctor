# Instructions for AI coding agents

This repository is a diagnostic tool, so wrong answers delivered confidently are the main failure mode. Follow these rules:

- Use strict TypeScript (`npm run typecheck` must pass). No `any` without a comment that justifies it.
- Don't add a diagnosis without explicit evidence requirements. Error and warning findings must carry evidence, and the Zod schema enforces this.
- Every rule needs complete `meta` (trigger, evidence, version scope, references, lastVerified, fixtures), regression cases in `tests/regression/cases.ts` including near misses, and an entry in the generated `docs/supported-checks.md` (`npm run catalog`).
- No automatic source-code changes to user projects. The tool only reads files and recommends changes.
- No network requests in `scan`, `analyze`, `report`, or `doctor`. The integration tests enforce this.
- Never log, store, or send secret values. `.env` files are parsed for names only, and every output passes through `Redactor`.
- Keep platform-specific logic inside `src/rules/<platform>/` and `src/parsers/`.
- Put version-sensitive facts in `src/rules/android/compat.ts` (or a sibling) with a source URL and verification date. Don't add rows from memory.
- Before you call a task done, run `npm run check`. Never claim tests passed unless they ran and passed. Report failures verbatim.
