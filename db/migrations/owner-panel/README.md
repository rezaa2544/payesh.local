# Owner-platform data migration 001

`001_owner_panel.up.sql` creates the isolated `owner_platform` schema, separate platform identities, plan/subscription metadata, tenant limits/usage, narrowly-scoped support grants and read logs, an append-only hash-linked audit table, and a structure-only invoice table. It does not migrate or modify school records, install a payment path, or grant the platform service access to product-content tables.

## Apply / rollback

Run only against the intended PostgreSQL database using a migration administrator with permission to create roles and schemas:

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/001_owner_panel.up.sql
```

Rollback is explicit and removes the dedicated schema plus only those roles created by migration 001:

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/001_owner_panel.down.sql
```

If an application login has been granted membership in `payesh_platform_runtime`, remove that external membership before rollback. A role that pre-existed migration 001 is not dropped. Do not run rollback against production without the Owner's change approval and a verified backup.

The runtime group role is `NOLOGIN`, `NOSUPERUSER`, and `NOBYPASSRLS`. A future API migration must grant its service login membership deliberately and set `app.tenant_id` and the validated `app.platform_user_id` transaction-locally. Tenant metadata tables have forced RLS; the platform runtime policy is limited to this schema's metadata. Direct subscription updates/deletes are not granted, so runtime cannot renew or remove subscriptions through table access; PR-2 must add an owner-authorized operation if required. No privilege is granted on `public.product_records` or any other school-content table. The invoice table intentionally has no runtime grant.

## Test

`npm test` also runs the owner-platform migration suite against PGlite, an embedded PostgreSQL engine. It checks every named SQL `CHECK`, forced-RLS isolation, support-grant/access-log invariants, audit-chain behavior, content-table privilege denial, and reversible migration up/down/up. The test uses an in-memory database and creates no production resources or credentials.

PGlite exercises PostgreSQL SQL semantics inside the test runner; it is **not** a connection test against a separately deployed PostgreSQL server. Server-version, deployment, and operational validation remain `[?]` until run against the intended PostgreSQL environment.
