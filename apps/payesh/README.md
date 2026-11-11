# apps/payesh — native Payesh client (ADR‑43 / D‑43)

One Flutter/Dart codebase that produces a standalone Android APK/AAB and a Windows EXE.
No WebView, no browser wrapper, no Node.js in the client bundle. It talks only to the existing
API/Gateway (`openapi.yaml`, `docs/cloud/contracts/sync-v1.md`).

| Path | Role | Row |
|---|---|---|
| `app/` | Flutter application (Android + Windows runners) | 69 |
| `packages/payesh_core` | pure Dart: ids, clock, API constants, error codes | 69 |
| `packages/payesh_data` | local SQLite engine (encrypted) with the `client/engine-web.js` contract | 70, 72 |
| `packages/payesh_sync` | offline outbox + Sync v1 client; HTTP / Gateway / direct transports and certificate pinning (the row-75 Gateway client lives here — no separate `payesh_net` package was created) | 71, 75, 110 |
| `packages/payesh_secure` | SecureStore (Android Keystore / Windows DPAPI), database-key manager, e2e1 device-side encryption | 72, 107 |
| `packages/payesh_ui` | design system: tokens, light/dark, RTL, Jalali, Vazirmatn | 73 |
| `tool/coverage_check.dart` | coverage gate used by CI | 69 |
| `app/windows/installer/payesh-native.iss` | per-user Inno Setup installer (row 77) | 77 |

Repository map: [`docs/REPOSITORY_MAP.md`](../../docs/REPOSITORY_MAP.md) §6.

CI: `.github/workflows/native-client.yml` — pinned Flutter, `pub get`, `dart format`, `flutter analyze --fatal-infos`,
tests with coverage, release builds, and the independent native gate (`tools/native-independence-gate.mjs`, row 63)
on the real APK/AAB/EXE output plus negative controls.

Local: `flutter pub get && flutter analyze --fatal-infos && flutter test` (inside `app/`) and `dart test` (inside each package).
