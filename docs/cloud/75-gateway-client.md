# Row 75 — Native Gateway client (`payesh_sync`: `GatewayTransport`, `GatewaySync`, pinning)

Status: implemented under ADR‑43 / D‑43 and constitution clause 25 (D‑36: the only cloud data
path is the stateless Gateway). Evidence: CI `native-client` job `gateway-real` and
`docs/cloud/reports/evidence/native-73-75-ci.txt`.

## Contract

* `GET /api/gw/v1/pull?since_seq&limit[&collection]` → `GatewayPage`; `GatewaySync` applies
  rows to the local SQLite engine and keeps cursor `gw.since_seq` in `meta`
  (guards: `schema_version == 1`, cursor never moves back, `more` must make progress, page cap).
* `POST /api/gw/v1/push {ops}` → `PushVerdicts`: `applied` + `duplicates` (as
  `duplicate: true`) + `conflicts`; plugs into `SqliteOutbox.drain` unchanged.
* Every request: `X-Payesh-Client: payesh-native/0.1.0` (version header), a fresh UUIDv4
  `X-Request-Id`, `X-Device-Id`, `Authorization: Bearer`.
* Errors map onto `SyncFailure` codes (401 → unauthorized, 429/5xx → retryable, …).

## Certificate pinning (owner decision: ON, with a backup pin)

* `GatewayConfig` requires `https` and **at least two distinct** SPKI pins
  (`base64(sha256(SubjectPublicKeyInfo))`, the same value as
  `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`).
  Configured via `--dart-define=PAYESH_GATEWAY_URL=… PAYESH_GATEWAY_PINS=pinA,pinB`; unset →
  no remote data path at all.
* `createPinnedHttpClient`: normal chain validation **plus** the pin check on the peer
  certificate right after the TLS handshake, before any HTTP byte (token, body) is written;
  mismatch → socket destroyed, `SyncFailure('certificate_pin_mismatch: host')`. Plain http and
  proxies are refused. Rotation: deploy the backup key, then ship a build with a new backup pin.
* Pin values / keys for production are **not** part of this row (row 61 instruction: keys
  later); the mechanism is complete and tested with throwaway keys generated at test time.

## Tests

| Test | What it proves |
|---|---|
| `pinning_test.dart` (mock TLS Gateway) | pin = openssl pin; primary pin OK; backup‑only OK; trusted‑CA but unpinned key → refused and the server saw **0 requests**; untrusted chain still refused; http/proxy refused; bad configs rejected; outbox keeps ops on pin failure; pull/push mapping and protocol guards |
| `gateway_it_test.dart` (REAL `server/gateway.js` + PostgreSQL with RLS, TLS front) | push applied once + duplicate; version/request‑id/device headers observed on the wire; paged pull into SQLite; tenant B cannot see tenant A rows; real conflict verdict; MITM front → **0 bytes** reached the Gateway; forged token → 401 |
| `data_path_test.dart` | no DB driver / object‑storage SDK / DB URL in any native `lib/`, cloud endpoints are only `/api/gw/v1/*`, no DB/cloud package in `pubspec.lock` |
