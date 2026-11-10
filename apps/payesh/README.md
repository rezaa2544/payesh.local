# apps/payesh — native Payesh client (ADR‑43 / D‑43)

One Flutter/Dart codebase that produces a standalone Android APK/AAB and a Windows EXE.
No WebView, no browser wrapper, no Node.js in the client bundle. It talks only to the existing
API/Gateway (`openapi.yaml`, `docs/cloud/contracts/sync-v1.md`).

| Path | Role | Row |
|---|---|---|
| `app/` | Flutter application (Android + Windows runners) | 69 |
| `packages/payesh_core` | pure Dart: ids, clock, API constants, error codes | 69 |

Later rows add `payesh_data` (70), `payesh_sync` (71), `payesh_secure` (72), `payesh_ui` (73) and `payesh_net` (75).

CI: `.github/workflows/native-client.yml` — pinned Flutter, `pub get`, `dart format`, `flutter analyze --fatal-infos`,
tests with coverage, release builds, and the independent native gate (`tools/native-independence-gate.mjs`, row 63)
on the real APK/AAB/EXE output plus negative controls.

Local: `flutter pub get && flutter analyze --fatal-infos && flutter test` (inside `app/`) and `dart test` (inside each package).
