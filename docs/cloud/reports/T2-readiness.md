# Independent security-assessment readiness — not the T2 database tier

> **Terminology clarification:** This document is a readiness-only artifact for a possible independent security assessment. Its historical `T2` filename/title is separate from the project's operational **T2 managed-PostgreSQL tier** described in [`../T2-runbook.md`](../T2-runbook.md). The naming overlap caused the database-measurement request to be misread as a security-assessment request. This document does not define, measure, or change the database tier, and its existence does not mean an assessment has run.

`base_sha=17212f5c5e73a90578227e32fb7f81a82187f3cb`
`date_utc=2026-11-09T16:37:58Z`

## State

**PREPARED — NOT RUN.** No target URL has been supplied by the owner. No request was sent to any target, and T2 must remain unexecuted until the owner supplies an authorized target URL and written scope. Product security remains **UNKNOWN**; this document is not a security certification or a Go/No-Go decision.

## Required owner handoff

T2 may be scheduled only after all items below are provided or confirmed by the owner:

- [ ] Exact target base URL (including any path prefix) and environment identity; the owner confirms it is an authorized non-production target. Redirects to any unlisted host are out of scope and must not be followed.
- [ ] Written authorization, scope, prohibited actions, testing window, and stop conditions.
- [ ] Named independent tester or firm and confirmation that the tester did not implement the code under review.
- [ ] Securely provisioned synthetic accounts for the roles under test; do not put passwords, tokens, or real personal data in Git or this report.
- [ ] Owner contact and escalation route during the window.
- [ ] Target version/commit, test-data reset or backup plan, and post-test cleanup owner.
- [ ] Approved method and destination for transferring raw evidence and the final report.

If any prerequisite is missing, remain **PREPARED — NOT RUN**. Do not substitute a local URL, public service, or production URL for the owner-provided target.

## Prepared scope for the independent tester

Use [`57-pentest-package.md`](../57-pentest-package.md) as the detailed product-specific kit. Review the current automated evidence and regression coverage as context only:

- [`evidence/pull-leak-57.txt`](evidence/pull-leak-57.txt) — positive row-57 pull and automated check output.
- [`evidence/pull-leak-57-ci-control.txt`](evidence/pull-leak-57-ci-control.txt) — positive pull plus an isolated negative control that proves the regression check detects an injected leak.
- [`evidence/leak-matrix-57.txt`](evidence/leak-matrix-57.txt) — role × collection policy/scope matrix and user-field controls.
- [`evidence/57-pentest-automated-run.txt`](evidence/57-pentest-automated-run.txt) — historical automated assessment; its findings and limits remain applicable context, not independent human results.

The human assessment should independently examine authentication and session handling, authorization and row scope, sensitive fields and exports, synchronization boundaries, backup/restore, update flows, client-side secrets, and error/configuration disclosure. The tester must record what was actually tested, what was not tested, and any environment or access limitations.

## Evidence and report hand-back

The independent tester should return raw reproducible evidence and a report containing:

- target version and a non-secret target identifier;
- authorization/scope reference, test dates, tester identity, and independence statement;
- test coverage and explicit exclusions;
- each finding's severity, affected path, safe reproduction steps, impact, and raw evidence reference;
- remediation owner and status, plus independent retest evidence for each proposed fix;
- a final statement of residual risk and untested areas.

Do not record credentials, live tokens, or real student/person data in repository evidence. No finding is considered fixed or accepted until the corresponding retest or signed owner risk acceptance is recorded through the project's normal review process.

## Explicit non-actions in this preparation

- No URL was probed or contacted.
- No scanner, attack script, or test harness was run against a T2 target.
- No credentials or target details were requested or stored.
- No security status was changed from **UNKNOWN**.
