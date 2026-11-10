# `/api/platform/v1` — PR-2

Independent owner-panel API, served **behind** `server/gateway.js` but with its own authentication, role source, database principal and rate-limit table. No route uses `server/auth.js`, `server/index.js`, `tenancy.verifyToken` or the school session store.

## Independence

| Axis | School API | Platform API |
| --- | --- | --- |
| namespace | `/api/*`, `/api/gw/v1/*` | `/api/platform/v1/*` only |
| token | `v1.<body>.<hmac>` (`GW_SECRET`) | `platform.v1.<body>.<hmac>` (`PAYESH_PLATFORM_TOKEN_SECRET`) |
| role | school user roles from `store` | re-read from `owner_platform.platform_users` inside every write function |
| DB principal | `payesh_runtime` / `PGURL` | dedicated `PAYESH_PLATFORM_PGURL` (`payesh_platform_runtime`) |
| rate limit | `gateway_quota` | `owner_platform.api_rate_limit` |

A school token is rejected by `verifyPlatformToken` (wrong prefix/shape); a platform token is rejected by `tenancy.verifyToken` (wrong prefix/shape). Both directions are asserted in `npm test`. The API does **not** trust the token's `role` claim for authorization: it places only `sub` in the transaction-local `app.platform_user_id` GUC, and `owner_platform.require_actor()` reads the authoritative role/status from the table.

## Fail-closed configuration

Both values come from the Owner's secret manager and are exported into the Gateway process environment; nothing is committed:

```
PAYESH_PLATFORM_PGURL
PAYESH_PLATFORM_TOKEN_SECRET   (>=16 characters)
PAYESH_PLATFORM_RATE_MAX / PAYESH_PLATFORM_RATE_WINDOW_SEC  (optional)
```

Then start the existing Gateway (`node server/gateway.js`). If either required value is missing, every authenticated platform route returns `503 not_configured`; `/health/summary` and `/openapi.json` remain readable but reveal no data. No URL, token or secret is hard-coded in the repository, and no credential/keystore was created for this PR.

Required migrations, in order: `001_owner_panel.up.sql`, then `002_owner_panel_api.up.sql`. The platform DB login must be `payesh_platform_runtime` or hold membership in it; the school runtime role must **not** gain privileges on `owner_platform`.

## Controls (each has a negative test in `apps/owner-panel/tests/platform-api.test.js`)

- **Default-deny content.** `GET /tenants/{id}/content` (list/export) always `403 bulk_content_forbidden`. `GET /tenants/{id}/content/{collection}/{record_ref}` returns `403 grant_required` without an active `content_read` grant bound to the same tenant and actor. Expired, revoked, future, wrong-tenant and wrong-operator grants are all denied by PR-1's `support_access_log` insert guard at the data boundary. `content_write` is not an accepted scope.
- **Every content read is logged.** The single-record function first inserts one `owner_platform.support_access_log` row; that insert increments `used_reads` and enforces the action cap. RLS on `public.product_records` stays ON and `app.tenant_id` is set transaction-locally before the one-row `SELECT`.
- **Four eyes, non-renewable grants.** Only `platform_operator`/`platform_support` may file a request; only an active `platform_owner` who is not the requester may approve. Reason ≥10 characters, window ≤72h, school notified before start, `metadata|content_read` only, no extension.
- **Operator cannot renew or delete.** `POST /subscriptions/{id}/renew` and `POST /platform-users`, `POST /plans`, `POST /support-grants/{id}/approve`, `POST /support-grants/{id}/revoke` require `platform_owner` both at the API edge and inside the SQL function. `DELETE /tenants/{id}` is always `403`.
- **Output field allowlist.** Every response is built with `project(row, FIELDS.*)`; `national_id`, `password_*`, `*token*`, `*secret*`, `authorization`, `cookie` and `api_key` are never emitted even if present in a row.
- **Request id.** Each response echoes `x-request-id`; a malformed client value is replaced with a generated UUID. Also written into `platform_audit.details`.
- **Rate limit.** Database-backed bucket per actor per fixed window; `429 rate_limited` with `x-ratelimit-*` headers and `retry_after_ms`, shared across Gateway instances.
- **Audit.** Each mutation appends a hash-linked `platform_audit` row; `event_hash = sha256(previous_hash || stable(payload))`, reproducible from the stored row.
- **OpenAPI drift.** `openapi.json` is a checked-in contract; a test asserts its `paths`/methods exactly match `PLATFORM_ROUTES`.

## Explicitly out of scope / NOT-RUN

- Login/TOTP/session storage and token issuance for human operators (O-27 is still a proposal, not a decision). This PR verifies tokens; it does not implement a login page or a password store.
- Invoice/payment UI or runtime invoice grants (PR-1 kept `invoice` structure-only).
- Deployment against a separately installed PostgreSQL 16, PgBouncer, TLS/load balancer, signed APK, real-device install and the Owner's human penetration test: **NOT-RUN**. Security status remains **UNKNOWN**.
- `client/pages.js` was not touched. No direct client → PostgreSQL path exists: the SPA (PR-3) will call this API only.
