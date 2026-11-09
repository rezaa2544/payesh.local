# T2 PostgreSQL database measurement runbook

## Meaning and boundary

In this runbook, **T2 means the managed-PostgreSQL deployment tier** and the capacity/size measurements used to plan it. It does **not** mean a penetration test or independent security assessment. The similarly named [`reports/T2-readiness.md`](reports/T2-readiness.md) is a separate readiness-only security document; it is not a database-tier runbook and does not establish that a security assessment has been performed.

The measurement tool is read-only. It reports database and relation sizes plus PostgreSQL's estimated row counts; it never selects application rows, changes schema/data, runs migrations, or contacts a target unless an operator explicitly runs it. No target was supplied or measured while preparing this runbook. Product security remains **UNKNOWN** and no T2 readiness or release state is changed here.

## Preconditions

Before measuring any non-local database, the owner/operator must:

1. Confirm written authorization for the exact database endpoint and environment.
2. Confirm this is the intended managed target before assigning `[M]`; a remote hostname alone is not proof that a service is managed or production.
3. Use a least-privilege database role with permission to read PostgreSQL metadata and size functions. Do not use an application superuser unless the owner has explicitly approved it.
4. Provision `DATABASE_URL` through the secret manager or the current shell environment. Never put credentials in Git, command history, issue comments, evidence, or this report.
5. Decide where the output may be stored. It includes database/schema/relation names and estimated counts, which may be sensitive operational metadata.

Do not run this against production or a third-party host without explicit owner authorization. No network probes or security tests are part of this procedure.

## Evidence tags: `[S]`, `[M]`, and `[?]`

- **Local/private endpoint → `[S]` only.** The tool requires `--allow-local` to connect to loopback, private-address, or local-name endpoints and always labels those results `[S]`. They are simulation/development measurements, never managed-target evidence.
- **`[M]` → explicit owner confirmation.** For a non-local endpoint, pass `--managed-target` only after confirming that the endpoint is the authorized managed PostgreSQL target. This is an operator assertion, not an automatic claim inferred from the hostname.
- **Unknown classification → `[?]`.** A remote endpoint without explicit managed-target confirmation is labelled `[?]`; do not promote it to `[M]` in downstream reports.

A local/private URL can never be labeled `[M]`. If the tool's classification does not match the actual environment, stop and resolve the endpoint/authorization before using the result.

## Running the measurement

Before any connection, the URL classification can be checked without contacting the database:

```sh
DATABASE_URL='postgres://placeholder:placeholder@db.example.invalid/db' node tools/t2-measure.mjs --managed-target --dry-run
```

The preflight prints the evidence tag and `database_contacted=false`; it does not validate credentials or prove that a host is managed. A local simulation can be preflighted with `--allow-local --dry-run`; it must show `[S]`. A local/private target passed with `--managed-target` is rejected.

Use a private terminal with shell tracing disabled. The connection string is read only from `DATABASE_URL`; it is not accepted as a command-line argument and is never printed by the tool.

For an owner-authorized local simulation:

```sh
set +x
read -r -s -p 'PostgreSQL URL: ' DATABASE_URL; export DATABASE_URL; printf '\n'
node tools/t2-measure.mjs --allow-local --json > t2-measure.json
unset DATABASE_URL
```

For an owner-confirmed managed PostgreSQL target:

```sh
set +x
read -r -s -p 'Managed PostgreSQL URL: ' DATABASE_URL; export DATABASE_URL; printf '\n'
node tools/t2-measure.mjs --managed-target --json > t2-measure.json
unset DATABASE_URL
```

The tool wraps queries in a `READ ONLY` transaction, applies short statement/lock timeouts, queries only database metadata and relation sizes, then rolls back. It does not read table contents. The optional `--json` output is suitable for controlled evidence storage; redact or restrict it according to the data-handling policy.

If the connection fails, the tool suppresses driver error text to avoid leaking connection details. Check the endpoint and secret through the approved secret-management channel; do not paste the URL into logs or chat.

## Interpreting results

The output's `evidence_tag` is the maximum claim supported by the invocation: `[S]` for local/private measurement, `[M]` only for an explicitly owner-confirmed managed target, and `[?]` for unconfirmed remote targets. The result is a point-in-time size inventory, not a load test, forecast, capacity guarantee, availability/SLA claim, or security finding. Estimated row counts are catalog estimates, not exact counts.

Record the UTC measurement time, target's non-secret identifier, database version, tool commit, evidence tag, operator, and authorization reference alongside any retained output. Do not record the URL, username, password, tokens, or queryable personal/student data. Do not change the product security status or T2 deployment decision based only on this measurement.

## Current state

This runbook adds procedure and tooling only. No `DATABASE_URL` was provided, so no database was contacted and no `[M]` result was produced. Product security remains **UNKNOWN**; T2 managed-PostgreSQL deployment status remains whatever the current owner-approved decision records.
