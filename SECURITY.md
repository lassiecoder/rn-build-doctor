# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's "Report a vulnerability" (Security advisories) on this repository. Don't open a public issue. Include a minimal reproduction, using synthetic secrets only.

We aim to acknowledge reports within 3 working days and to publish a fix or mitigation as quickly as the severity requires.

## In scope

- Secrets that survive redaction into terminal output, saved reports, Markdown/JSON exports, or AI requests
- Network access from offline commands (`scan`, `analyze`, `report`, `doctor`)
- Reading files outside the documented set, following symlinks, or executing project code
- Crashes or excessive resource use caused by crafted logs or project files
- The AI layer executing commands or modifying files

## Design commitments

See [docs/privacy.md](docs/privacy.md). Redaction is best-effort by design, so reports must remain reviewable. A missed secret _pattern_ is still worth reporting, so that we can add it.
