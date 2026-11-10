# Native API contract v1 (rows 64 and 66)

| | |
|---|---|
| Status | Normative for every native (Flutter) client under D‑43 |
| Machine-readable | [`native-api-v1.schema.json`](native-api-v1.schema.json) (JSON Schema 2020‑12) · sync semantics: [`sync-v1.md`](sync-v1.md) + [`sync-v1.schema.json`](sync-v1.schema.json) · routes: [`/openapi.yaml`](../../../openapi.yaml) |
| Shared vectors | [`vectors/`](vectors/) (conflict, scope, idempotency, pagination, version) |
| Server conformance | `tests/native-contract-64.js` (real HTTP, real SQLite + PostgreSQL) · `tests/contract-vectors-64.js` · `tests/directory-66.js` |
| CI | workflow `api-contract`, job `native-contract` |

The JSON Schema is the single source of truth for message shapes. `openapi.yaml` lists every route (drift-gated by row 81) and points here for native semantics. A client implementation is conformant when it produces the requests in the schema and accepts the responses in the schema, and when it reaches the expected results for every vector in `vectors/`.

## 1. Identity headers (every native request)

| Header | Value | Notes |
|---|---|---|
| `X-Payesh-Client` | `payesh-native/<major>.<minor>.<patch>` (optional `-pre` suffix) | Its presence marks a native client. Web clients never send it. |
| `X-Payesh-Api` | contract major (integer, default `1`) | See §5. |
| `X-Request-Id` | random id | Echoed in logs (row 67). |
| `X-Device-Id` | device id | Gateway routing, quota and read-your-writes. |
| `Authorization` | `Bearer <token>` | School-server session token, or a signed gateway token. |

Every response to a native client carries `X-Payesh-Api` (the server's current major) and `X-Payesh-Api-Supported` (for example `1` or `2,3,4`).

## 2. Endpoints and schemas

| Area | Endpoint | Request `$defs` | Response `$defs` (2xx) | Errors |
|---|---|---|---|---|
| Health | `GET /api/health` | — | `healthResponse` (never `data_dir`/`db_file`) | — |
| Health | `GET /api/version` | — | `versionResponse` | — |
| Health | `GET /healthz`, `GET /readyz` (gateway) | — | `gwHealthzResponse`, `gwReadyzResponse` | readyz 503 |
| Login | `POST /api/auth/login` | `loginRequest` | `authSessionResponse` | 401 `errorResponse` (`bad_credentials`, `bad_phone`, …), 429 |
| Pairing | `POST /api/auth/pair` | `pairRequest` | `authSessionResponse` | 400 `errorResponse` (`bad_code`, `code_expired`, `code_revoked`) |
| Session | `POST /api/auth/refresh` | `refreshRequest` | `authSessionResponse` | 401 `errorResponse` (`bad_device`, `device_revoked`) |
| Session | `GET /api/me` | — | `meResponse` | 401 |
| Session | `POST /api/auth/logout` | — | `okResponse` | 401 |
| Device registry | `GET /api/admin/devices` (manager) | — | `deviceListResponse` | 401, 403 |
| Device registry | `DELETE /api/admin/devices/{id}` (manager) | — | `okResponse` | 401, 403 |
| Directory | `GET /api/dir/v1/resolve?school_code=` (public) | — | `directoryResolveResponse` | 404 `not_found`, 429, 503 |
| Sync (school server) | `GET /api/v1/pull`, `POST /api/sync` | `syncPushRequest` | `syncPullResponse`, `syncPushResponse` | `sync-v1.schema.json#/$defs/errorResponse` |
| Sync (gateway) | `GET /api/gw/v1/pull`, `POST /api/gw/v1/push` | `gwPushRequest` | `gwPullResponse`, `gwPushResponse` | 400/401/403/409/413/429 `errorResponse` |
| Update | `GET /api/update/check?current=` | — | `updateCheckResponse` (both branches) | — |
| Any | version policy | — | — | 426 `upgradeRequired`, 400 `apiVersionUnsupported` |

Rules that hold for every response:

- Every error is `{ ok: false, error: "<snake_case>" , … }` (`errorResponse`).
- A `user` object never contains `password_hash`, `phone_hash` or `password_enc`. The schema forbids these fields.
- Role values are exactly `server/policy.js` `ROLES`. The test asserts this equality.

## 3. Directory bootstrap (row 66)

`GET /api/dir/v1/resolve?school_code=<code>` is public. It takes no token, is stateless, and is served by every Gateway instance from the central database (`PAYESH_DIRECTORY_PGURL`).

```json
{ "ok": true, "schema_version": 1, "school_code": "school-64",
  "cell_id": "6464aaaa-0000-4000-8000-000000000064", "cell_url": "https://cell64.a.b",
  "version": 3, "ttl": 300, "migration_state": "stable", "stale": false }
```

- **One school per call.** There is no list endpoint, and the response has exactly these fields (`additionalProperties: false`). It never includes data from another school.
- **No enumeration oracle.** Unknown, malformed, empty and injection-shaped codes all receive the same `404 {"ok":false,"error":"not_found"}`.
- **Rate limit per client address** (`PAYESH_DIR_RATE_MAX` per `PAYESH_DIR_RATE_WINDOW_SEC`, default 30/60 s). Over the limit the response is `429` with `Retry-After` and `retry_after_ms`. Unknown-code attempts are throttled the same way. Behind a proxy, set `PAYESH_TRUST_PROXY=1` so the first `X-Forwarded-For` hop is used.
- **`version`** increases whenever the school's cell or migration state changes.
- **`ttl`** depends on the migration state. It is 300 s when `stable`, 15 s when `migrating`, and 30 s when `moved` (`PAYESH_DIR_*_TTL_SEC`).
- **Disabled cell, or a cell without a URL:** `503 cell_unavailable`.
- **Directory database down:** a cached route keeps being served with `stale: true` for up to `DIR_STALE_MAX_SEC`, then the answer is `503 directory_unavailable` (row 43 rule).

Client rules (the reference implementation is `tools/directory-client-66.mjs`, and Dart must behave the same):

1. Cache each answer for exactly `ttl` seconds. Make no network call inside the TTL.
2. When `migration_state = migrating`, hold writes (keep the outbox) and ask again after `ttl`.
3. When `migration_state = moved`, or `version` is newer than the cached one, drop the cached route, token and data-plane URL, and re-authenticate for the new cell.
4. On a data-plane `409 write_frozen` or `403 wrong_cell`/`missing_cell`, or a network error, invalidate the cached route at once. Keep the outbox; the next flush re-resolves.
5. Ops keep their `uid` across cells. Re-sending after a move can only produce `duplicates`.

`tests/directory-66.js` moves a school from cell A to cell B with the real transfer tool (row 54) while the client keeps writing. It proves:

- writes are held while A is frozen;
- the client re-routes on `moved`;
- an A token is refused by B (`wrong_cell`);
- all 30 records exist exactly once in B;
- A receives nothing after the freeze.

This test exposed a defect in row 54: target sequences were not advanced after the copy, so the first new write in B failed with `23505`. It is fixed in `tools/cell-transfer-54.mjs` (`advanceSequences`).

## 4. Shared conformance vectors

| File | What it pins | Server runner |
|---|---|---|
| `vectors/conflict-v1.json` | `server/convergence.js` verdicts: merge / conflict / noop / delete-vs-edit, plus the fail-closed default for unknown collections | `tests/contract-vectors-64.js` |
| `vectors/scope-v1.json` | role scope for reads (`rowInScope`) and writes (`canWriteRow`), including `bad_score` / `bad_kind` / `bad_status` | `tests/contract-vectors-64.js` |
| `vectors/version-v1.json` | the version window and `upgrade_required` reasons | `tests/contract-vectors-64.js` |
| `vectors/idempotency-v1.json` | push retries, changed-body retries, same-uid-in-batch, and conflict finality | `tests/native-contract-64.js` (real Gateway + PG) |
| `vectors/pagination-v1.json` | cursor walk with no skip or repeat, empty-page cursor, and limit clamping | `tests/native-contract-64.js` (real Gateway + PG) |

The vectors are written as expectations, not generated from the code. The runner includes negative controls that show a wrong expectation is detected. The Dart client runs the same files in its conformance tests (row 74 waves). Scope vectors are informative only for a client: the server stays the security authority.

## 5. Version policy

- The server serves contract majors **N, N‑1 and N‑2** (`BACK_VERSIONS = 2`; `PAYESH_NATIVE_API_CURRENT`, default 1).
- `X-Payesh-Api` greater than N gets `400 api_version_unsupported`.
- Below N‑2 gets **`426 upgrade_required`** with `reason: api_too_old`.
- A client below `PAYESH_MIN_NATIVE_CLIENT` (default `0.1.0`) gets `426`, `reason: client_too_old`.
- A build listed in `PAYESH_CLIENT_KILL` (comma-separated semvers, the row 67 kill-switch) gets `426`, `reason: client_disabled`.
- A malformed `X-Payesh-Client` gets `400 bad_client_header`.
- The `426` body always has `min_client`, `supported_api`, `current_api` and an explicit Persian `message`, which the client shows as-is.
- `/api/health`, `/api/version`, `/api/readyz`, `/healthz`, `/readyz` and `/metrics` are exempt, so an outdated client can still discover that it must upgrade.
- **Web clients do not send `X-Payesh-Client`, so this policy never affects them.** `tests/native-contract-64.js` NC‑A16 asserts this.
- Implementation: `server/api-version.js`, applied before authentication and before any database access in `server/index.js` (every `/api/*`) and `server/gateway.js` (gateway and directory).

Changing the contract: additive response fields are allowed within a major. Removing or renaming a field, tightening a request, or changing semantics needs a new major N+1. Majors N‑1 and N‑2 must keep working until N+3 ships.

## 6. Gateway operational behaviour (row 67)

These rules apply to `server/gateway.js` (cloud Gateway and Directory). They are additive within major 1: no request changed, no response field was removed.

| Concern | Behaviour | Client rule |
|---|---|---|
| Request id | Every response carries `X-Request-Id`. A caller-supplied `X-Request-Id` matching `^[A-Za-z0-9._:-]{8,64}$` is echoed; anything else is replaced with a fresh UUID v4. One JSON access-log line per request (`event:"http"`, `request_id`, `method`, path without query string, `status`, `ms`). `GW_ACCESS_LOG=0` turns the log off. | Send a UUID per logical attempt and show the returned id in error/support screens. |
| Rate limit | Per (tenant, device) bucket `GW_QUOTA_MAX`/`GW_QUOTA_WINDOW_SEC`, plus an optional tenant-wide ceiling `GW_TENANT_QUOTA_MAX` (0 = off). Over the limit: `429 {error:"rate_limited", scope:"device"\|"tenant", retry_after_ms, limit}` with a `Retry-After` header in whole seconds (≥ 1). The tenant bucket key cannot be claimed through `X-Device-Id`. | Wait at least `Retry-After` seconds; do not retry sooner. |
| Feature kill-switch | `PAYESH_FEATURE_KILL` = comma list of `feature`, `feature@<semver>` or `feature@<<semver>`; features: `pull`, `push`, `directory`, `platform`. A hit answers `503 {error:"feature_disabled", feature, retry_after_s}` + `Retry-After` (`PAYESH_FEATURE_KILL_RETRY_SEC`, default 300), before authentication and database access. Version-scoped entries bind native clients only. Invalid entries match nothing and are listed in `/healthz` → `kill_switch.invalid`. | Keep the work queued (outbox), back off for `Retry-After`, do not log the user out. |
| Version kill-switch | `PAYESH_CLIENT_KILL` → `426 upgrade_required`, `reason: client_disabled` (§5). | Show the upgrade message. |
| Graceful drain | On `SIGTERM`/`SIGINT` the instance stops accepting connections, `/readyz` answers `503 draining`, in-flight requests finish (responses carry `Connection: close`), pools close, exit code 0. After `GW_DRAIN_TIMEOUT_MS` (default 25000) the remaining sockets are cut and the exit code is 2. Requests arriving on a kept-alive socket during drain get `503 draining` + `Retry-After: 1`. | Treat a connection reset or `503 draining` as retryable; pushes are idempotent by `uid` (§4). |

Tests: `tests/gateway-67.js` (real Gateway processes + PostgreSQL): GW67‑RID‑01..04, RL‑01..04, VER‑01..02, KS‑01..04, DR‑01..03 and a short load test LOAD‑01 (baseline vs hardened instance: zero errors on both, one unique request id and one access-log line per response, p95 budget).
