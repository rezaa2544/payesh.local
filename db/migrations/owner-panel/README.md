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

The PostgreSQL integration test creates and drops an isolated temporary database, exercises every named SQL `CHECK`, RLS isolation, support-grant/log invariants, audit-chain behavior, content-table privilege denial, and up/down/up migration reversibility:

```sh
OWNER_PANEL_TEST_ADMIN_URL="$OWNER_PANEL_TEST_ADMIN_URL" node tests/owner-panel-schema-pg.js
```

This test requires a disposable PostgreSQL administrator connection with `CREATEDB` and role-management privileges. It does not use production credentials or a signing key. CI supplies an ephemeral PostgreSQL service. Local execution without PostgreSQL is `NOT-RUN`, not a pass.
