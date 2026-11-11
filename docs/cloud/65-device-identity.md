# Row 65 — device identity (school server)

Status: implemented on branch `arena/native-64-66`. Code: `server/identity.js`, `server/auth.js`, `server/index.js`, `server/db.js`, `client/app.js`. Test: `tests/identity-65.js` (20 checks plus 10 mutation negative controls). Contract: `docs/cloud/contracts/native-api-v1.md` §7.

## 1. Model

| Piece | Before row 65 | After row 65 |
|---|---|---|
| Access token (`sessions`) | 24 h, sliding: every request pushed the expiry | `PAYESH_ACCESS_TTL_MIN` (default **15 min**), fixed expiry, no sliding |
| Refresh token (`device_token`) | 365 days, same value forever, stored in `meta` as `device:<sha256>` | **Rotates on every refresh**; one `device_tokens` row per generation (hash only); 365-day life per token (`PAYESH_DEVICE_DAYS`) |
| Reuse of an old refresh token | Not detectable (the token never changed) | Within `PAYESH_REFRESH_GRACE_SEC` (default 30 s): the same successor is returned. After that: **reuse ⇒ the whole chain is revoked** (device, all its sessions, and stored successors), audited as `refresh_reuse_detected`, and the caller gets `device_revoked` + `wipe:true` |
| Device identity | Random device id only | Device id plus an **optional public key** (P‑256 or Ed25519, SPKI DER base64) bound at login, pairing or transfer. A bound device must sign every refresh (§3) |
| Device count | Unlimited (a reusable pair code could mint any number of devices) | `PAYESH_DEVICE_CAP` (default **10**) active devices per user. Devices not seen for `PAYESH_DEVICE_STALE_DAYS` (default 30) are retired first, then the request is refused with `409 device_limit` |
| "Close all sessions" (`/api/auth/revoke-all`) | Revoked sessions only. The lost phone's device token minted a new session straight away, so the action had no effect | Revokes every device of the user (except the current one with `keep_current`), and with them all sessions |
| Manager revoke | Device was revoked, but its next request only got `401 unauthorized`, so the web client locked and did **not** wipe | The session request gets `401 {error:"device_revoked", reason, wipe:true}`, and so does refresh. The web client wipes (row 44 W2/W3) |
| `/api/setup/state` (no auth) | Returned `data_dir` and `db_file` to anyone on the network | Paths are returned only to loopback (the school PC's own browser) |
| `POST /api/admin/users/{id}/password` | Echoed the raw password in the response | Returns `{ok:true}` only; the manager already has the value they typed |

## 2. Why each choice

- **Reject at the cap, do not evict.** If the oldest device were evicted, anyone who knew a password could push real devices out, and each pushed-out device would be remotely wiped. Refusing stops that. The stale-device rule (30 days) keeps forgotten browsers from filling the slots.
- **Grace window.** Two browser tabs share one `localStorage` token. Without a grace window, two tabs refreshing at the same moment would look like token theft and wipe the device. Within the window the same successor comes back, so a race or a lost response costs nothing. Detection still works, because after the window the chain splits and the next refresh on the stale branch is reuse.
- **Proof before reuse.** For a key-bound device, the signature is checked *before* the reuse logic. Someone holding only a stolen spent token therefore cannot even trigger the revocation, so they cannot use it to lock out the real device.
- **Replay guard.** `proof.ts` must be strictly greater than the last accepted `ts` for the device, and within `PAYESH_PROOF_SKEW_SEC` (default 300 s). A captured `{token, proof}` pair cannot be replayed, not even inside the grace window.
- **No permanent secret on the client.** The refresh token changes on every use, and the access token lives 15 minutes. A key-bound native client is expected to keep its private key in the platform keystore (see the row 72 device threat model); adopting key binding in the Flutter client is part of the row 74 waves. The token alone is useless without that key.
- **Compatibility.** Pair codes keep their behaviour: reusable until the manager makes a new one. Each device paired with a code has its own independent chain. Tokens issued before row 65 (`meta` `device:<hash>`) are adopted as generation 0 on first use, then rotated and deleted from `meta`, so nobody has to pair again.
- **Phone mode** (`/api/phone/login`, the serverless phone whose identity is the signed 200-day ticket) never received a device token. It now gets a device-less short session, instead of creating an orphan device that would use up the cap. The local-only manager rescue (`/api/auth/claim`, loopback only) is exempt from the cap, so recovery is never locked out.

## 3. Proof of possession (native clients)

```
message = "payesh-refresh-v1\n" + device_id + "\n" + ts + "\n" + hex(sha256(device_token))
P-256 : ECDSA-SHA256, signature in IEEE-P1363 (r||s) form, base64
Ed25519: raw signature, base64
POST /api/auth/refresh { device_token, proof: { ts, sig } }
```

Errors (all `401`): `proof_required`, `bad_proof`, `proof_expired`, `proof_replayed`. Each failure is audited as `refresh_bad_proof`.

## 4. Audit events

`device_login` (platform, via, key_bound) · `session_login` · `refresh_rotate` (generation) · `refresh_grace` · `refresh_reuse_detected` · `refresh_bad_proof` · `device_limit` · `device_stale_revoked` · `device_revoke` (manager, wipe) · `revoke_all_sessions` (devices count).

No raw token, key or password is written to the audit table. `ID65-19` asserts this by scanning `audit`, `device_tokens` and `sessions` for every token the test saw.

## 5. Web impact

| Area | Change | Risk handled |
|---|---|---|
| `silentRefresh()` (`client/app.js`) | Saves the rotated `device_token` | Without this, the next refresh would present a spent token and trigger reuse revocation |
| Multi-tab | `currentDeviceToken()` reads the token fresh from `localStorage` before every refresh and unlock | Prevents a tab holding a stale in-memory token from causing a false reuse detection |
| Refresh answering `device_revoked` | `handleDeviceRevoked()` runs, giving key destruction and local wipe | Manager revoke, revoke-all and reuse now actually wipe the browser |
| 15-minute access token | Existing behaviour: `api()` retries once after `silentRefresh()` on `401` | Users are never asked for a password again while the device token is valid |
| `device_limit` | Persian message in `friendlyError` | — |
| Settings page "data location" | Shown only on the school PC itself (loopback) | Other LAN browsers now show "—" |
| Key binding | **Not used by the web client.** WebCrypto P‑256 is available, but a non-extractable key in IndexedDB is still readable by any script running on the origin, so it adds little against XSS | The web stays protected by rotation plus reuse detection. Native clients (rows 72/74) bind keys |

## 6. Tests and negative controls

`tests/identity-65.js` runs the real server over HTTP, with a real SQLite file and no mocks:

- **Positive:** ID65‑01/04/05/11/17/18
- **Negative:** ID65‑07/11/12/15/16
- **Forgery:** ID65‑07/08
- **Replay:** ID65‑06/09/10
- **Expiry:** ID65‑02/03/20
- **Revoke / remote wipe:** ID65‑13/14
- **Audit:** ID65‑19

**Mutation negative controls.** For each fix, a throw-away copy of `server/` is made with that fix reverted, and the suite is re-run. Every mutant must turn its target check red:

- `MUT-reuse`, `MUT-proof`, `MUT-proof-replay`, `MUT-cap`, `MUT-ttl`
- `MUT-rotation`, `MUT-revoke-all`, `MUT-wipe`, `MUT-setup-leak`, `MUT-echo`

The leak matrix (`tests/leak-matrix-57.js`), pentest‑57 (`tests/pentest-57-sync-leak.js`), pull-leak‑57 with its negative control, revocation‑44 and native-contract‑64 stay green.

## 7. Configuration

| Variable | Default | Range |
|---|---|---|
| `PAYESH_ACCESS_TTL_MIN` | 15 | 1–1440 |
| `PAYESH_REFRESH_GRACE_SEC` | 30 | 0–300 |
| `PAYESH_DEVICE_DAYS` | 365 | 1–3650 |
| `PAYESH_DEVICE_CAP` | 10 | 1–1000 |
| `PAYESH_DEVICE_STALE_DAYS` | 30 | 1–3650 |
| `PAYESH_REFRESH_RETAIN_DAYS` | 30 | 1–3650 (how long spent tokens are kept for reuse detection) |
| `PAYESH_PROOF_SKEW_SEC` | 300 | 10–3600 |
