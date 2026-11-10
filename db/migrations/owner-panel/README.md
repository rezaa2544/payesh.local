# Owner-platform migrations

## 001 — data model

`001_owner_panel.up.sql` creates the isolated `owner_platform` schema, separate platform identities, plan/subscription metadata, tenant limits/usage, narrowly-scoped support grants and read logs, an append-only hash-linked audit table, and a structure-only invoice table. It does not migrate or modify school records, install a payment path, or grant the platform service access to product-content tables.

## Apply / rollback

Run only against the intended PostgreSQL database using a migration administrator with permission to create roles and schemas:

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/001_owner_panel.up.sql
```

Rollback is explicit and removes the dedicated schema plus only those roles created by migration 001:

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/002_owner_panel_api.up.sql
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/002_owner_panel_api.down.sql
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/001_owner_panel.down.sql
```

`002_owner_panel_api.up.sql` is the PR-2 API data boundary. It is additive: it adds a `plans_owner` RLS policy, a database-backed rate-limit table, a pending `support_grant_request` table, and nine `SECURITY DEFINER` functions. It does **not** grant the runtime role insert/update/delete on `subscriptions`, does **not** grant `payesh_platform_runtime` any privilege on `public.product_records`, and does **not** change any of 001's CHECK constraints or table grants. Each function re-reads the actor's real role/status from `owner_platform.platform_users` using the transaction-local `app.platform_user_id` GUC; a role claim inside the token is never trusted. Roll back 002 before 001.

The only content privilege added in 002 is `SELECT ON public.product_records` for `payesh_platform_owner` (the owner of the `read_school_record` function), and only if the school tenancy migration has already created that table. `read_school_record` reads exactly one row, sets `app.tenant_id` transaction-locally so the school table's forced RLS still isolates tenants, and first inserts one `support_access_log` row so PR-1's guard enforces grant presence, window, tenant binding, actor binding and action cap at the data boundary. There is no list/export endpoint.

`request_support_grant` accepts only `metadata|content_read`, a reason of at least 10 characters, a window of at most 72 hours and a school notification before the window opens. `approve_support_grant` requires an active `platform_owner` who is not the requester. `apply_subscription_transition` allows an operator to suspend with a reason but reserves activation/renewal/cancellation for the owner; no delete operation exists.

If an application login has been granted membership in `payesh_platform_runtime`, remove that external membership before rollback. A role that pre-existed migration 001 is not dropped. Do not run rollback against production without the Owner's change approval and a verified backup.

The runtime group role is `NOLOGIN`, `NOSUPERUSER`, and `NOBYPASSRLS`. A future API migration must grant its service login membership deliberately and set `app.tenant_id` and the validated `app.platform_user_id` transaction-locally. Tenant metadata tables have forced RLS; the platform runtime policy is limited to this schema's metadata. Direct subscription updates/deletes are not granted, so runtime cannot renew or remove subscriptions through table access; PR-2 must add an owner-authorized operation if required. No privilege is granted on `public.product_records` or any other school-content table. The invoice table intentionally has no runtime grant.

## Test

`npm test` also runs the owner-platform migration suite against PGlite, an embedded PostgreSQL engine. It checks every named SQL `CHECK`, forced-RLS isolation, support-grant/access-log invariants, audit-chain behavior, content-table privilege denial, and reversible migration up/down/up. The test uses an in-memory database and creates no production resources or credentials.

PGlite exercises PostgreSQL SQL semantics inside the test runner; it is **not** a connection test against a separately deployed PostgreSQL server. Server-version, deployment, and operational validation remain `[?]` until run against the intended PostgreSQL environment.
