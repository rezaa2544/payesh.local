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

## 003 — two-person tenant deletion

`003_tenant_deletion.up.sql` implements the already-decided rule in `docs/cloud/12b-owner-panel-boundaries.md` §100 (owner + second approval + 24h delay) and D-22 retention (≥ 180 days). It adds `tenant_deletion_request` (forced RLS, runtime `SELECT` only) and four `SECURITY DEFINER` functions: `request_tenant_deletion`, `approve_tenant_deletion` (active owner ≠ requester; `not_before = approved_at + 24h`), `cancel_tenant_deletion` and `execute_tenant_deletion` (only when approved and `clock_timestamp() >= not_before`). Execution cancels the tenant's live subscriptions with `subscription_event` rows and sets `retain_until = executed_at + 180 days`. It does **not** delete school rows, backups, storage prefixes or keys — DEK destruction stays the offline owner-approved step of 16b §1.3.

`CHECK` constraints repeat the invariants at the data boundary: `approved_by <> requested_by`, `not_before >= approved_at + 24h`, `executed_at >= not_before`, `retain_until >= executed_at + 180 days`, plus a partial unique index allowing one open request per tenant.

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/003_tenant_deletion.up.sql
# rollback (before 002/001):
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/003_tenant_deletion.down.sql
```

Rollback removes only 003's table and functions. Subscriptions already canceled by an executed request are not re-activated.

## Test

`npm test` also runs the owner-platform migration suite against PGlite, an embedded PostgreSQL engine. It checks every named SQL `CHECK`, forced-RLS isolation, support-grant/access-log invariants, audit-chain behavior, content-table privilege denial, and reversible migration up/down/up. The test uses an in-memory database and creates no production resources or credentials.

PGlite exercises PostgreSQL SQL semantics inside the test runner; it is **not** a connection test against a separately deployed PostgreSQL server. Server-version, deployment, and operational validation remain `[?]` until run against the intended PostgreSQL environment.

## 004 — owner login issuer (D-45)

`004_owner_login.up.sql` implements decision D-45 (O-17 = option A): password + TOTP for every owner-panel operator, no IP allowlist, at most 3 login accounts. It adds `platform_credentials` (scrypt hash + TOTP secret; forced RLS; **no** table privilege for `payesh_platform_runtime`), the append-only `login_event` table (hashed login/IP references only), a cap trigger (max 3 rows, under a table lock), `login_lookup(login_id)` (exact match, one row) and `record_login_attempt(...)` (the final authority for TOTP replay — accepted step must exceed the last one — and for lockout: 5 consecutive failures ⇒ 15 minutes).

Create the first operator on the server (password is prompted without echo; only an `otpauth://` URI is printed once):

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/004_owner_login.up.sql
PAYESH_PLATFORM_MIGRATION_URL=… node apps/owner-panel/scripts/create-operator.js --login-id <id> --role platform_owner
```

Rollback (`004_owner_login.down.sql`) removes only 004's objects; afterwards `POST /auth/login` answers `501 login_not_installed` and nobody can log in. Roll back 004 before 003.


## 005 — create a school from the owner panel (row 121)

`005_tenant_provisioning.up.sql` adds `tenant_registry` (slug → tenant_id, display name, plan, `provision_op_id`, status `provisioning|active`; forced RLS; runtime role gets `SELECT` only) and two `SECURITY DEFINER` functions, both gated by `require_actor(ARRAY['platform_owner'])`:

- `provision_tenant(op_id, slug, name, plan_code)` creates the registry row with a fresh `gen_random_uuid()` tenant id, the subscription in `provisioning` (with its `subscription_event`), and `tenant_limits` copied from the plan. It is idempotent by `provision_op_id` (`UNIQUE`, 16b §1.4). The same op used for another slug gives `23505`. A slug belongs to one tenant forever (`UNIQUE`).
- `activate_tenant(tenant_id)` moves `provisioning → active`, also idempotently. The API calls it only **after** the school side succeeded, so a half-provisioned school is never shown as active.

The school side (slug mapping, `users#1` = initial manager, one-time activation code) is **not** written by this migration or by the platform role. The Gateway writes it with the school runtime role under the new tenant's forced RLS (`server/school-access.js`, tables `gw_school` / `gw_credential` in `server/tenancy.js`). Migration numbering: row 121 took `005`, so the provider-agnostic infrastructure layer of row 122 becomes `006`.

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/005_tenant_provisioning.up.sql
```

Rollback (`005_tenant_provisioning.down.sql`) removes only the registry and the two functions. Subscriptions, limits and audit rows created through it stay, and so do the school-side rows. Roll back 005 before 004.

## 006 — provider-agnostic infrastructure layer (row 122)

`006_infra_registry.up.sql` adds the Control Plane's infrastructure metadata. It records only what the owner registers **by hand** and the result of a limited health check. It provisions nothing and calls no provider API.

- **Tables** (all have forced RLS; the runtime role gets `SELECT` only):
  - `infra_provider`: `kind` is one of host/vps/vpc/db/storage/other. `api_mode` is `manual`; `api` is declared but refused.
  - `infra_service`.
  - `infra_endpoint`: `http(s)` or `tcp`. A CHECK forbids `user:password@`.
  - `infra_health_check`: append-only. It stores short error codes only, never bodies or headers.
  - `infra_metric`: append-only. A value is either a number labelled `M`/`E` or `NULL` labelled `?`, enforced by a CHECK.
  - `infra_alert`: at most one open alert per endpoint.
  - `infra_change_request`.
- **Credentials:** a provider stores only `credential_ref = 'secret:NAME'`, enforced by a CHECK. The value lives in the operator host's environment and never in the database, repository, API responses, logs or audit.
- **Write functions:** there are seven `SECURITY DEFINER` functions, each gated by `require_actor`:
  - `infra_register_provider`, `infra_register_service`, `infra_register_endpoint`;
  - `infra_record_check`: 3 consecutive failures open an alert and the next success closes it;
  - `infra_record_metric`: refuses `source = 'provider_api'` until a real adapter exists (row 124);
  - `infra_request_change`;
  - `infra_approve_change`: `platform_owner` only, single use. It is the only way a provider is disabled or enabled, its credential reference changed, or an endpoint disabled.

```sh
psql "$PAYESH_PLATFORM_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/owner-panel/006_infra_registry.up.sql
```

Rollback (`006_infra_registry.down.sql`) removes only 006's tables and functions. Because the layer is metadata only, no provider resource depends on it. Audit rows written through it stay. Roll back 006 before 005.
