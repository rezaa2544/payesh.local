# payesh_owner — native owner panel (row 126)

Flutter app for **Android** (`ir.payesh.owner`, APK) and **Windows** (`payesh_owner.exe` +
`payesh-owner-setup.exe`). It replaces the retired WebView2 / Android WebView shells
(`apps/owner-panel/desktop`, `apps/owner-panel/android`): every page of the old web panel is a
Flutter screen talking to `/api/platform/v1` through `packages/payesh_owner_api`.

* No WebView, no HTML/CSS/JS UI, no Node.js, no local server — checked on the real APK and the
  installed Windows app by `tools/native-independence-gate.mjs` (CI `owner-panel.yml`).
* Server origin is asked on first start (`https://…`, or `http://` on loopback for local
  testing) and remembered in the app's private data dir (Windows: `%LOCALAPPDATA%\PayeshOwner`).
* Password + TOTP login; the token is kept in memory only (never written to disk).
* Authorization stays on the server; the role only hides buttons.
