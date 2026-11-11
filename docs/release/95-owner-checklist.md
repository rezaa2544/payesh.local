# Row 95: the owner's manual release checklist for the native app

Labels follow constitution rev. 1.12. **[M]** means checked on the real target: a physical phone, a real Windows PC, and the real signed file. CI cannot tick these boxes. Only the owner can, by hand.

The automated half of the gate is `tools/release-gate-95.mjs`, which runs in `.github/workflows/release-gate.yml`. See `docs/release/95-release-gate.md`. A `native-v*` tag is published only if both of these hold:

1. Every CI gate in `docs/release/95-release-gate.json` is `success`.
2. `docs/release/signoff/<tag>.md` exists, every item below is ticked, `result: PASS` is set, and `rc_sha` names the commit whose build was tested on the device.
   - Since `rc_sha`, only files under `docs/release/` may have changed. This means the build you tested is the product being tagged.

## Procedure

1. **Build the release candidate (RC).** Run *Actions → release-gate → Run workflow* on the commit you want to release.
   - Rehearsal mode runs every CI gate and uploads `native-android` (APK/AAB plus `SHA256SUMS-android`), `native-windows` and `release-gate-summary`.
   - It publishes nothing.
   - Note the commit sha. That sha is `rc_sha`.
2. **Check the summary.** `release-gate-summary.txt` must end with `RELEASE-GATE-OK`.
3. **Run the checks.** Work through M1–M6 below with the files from that run, and write down what you saw.
4. **Sign off.**
   - Copy `docs/release/signoff/TEMPLATE.md` to `docs/release/signoff/native-vX.Y.Z.md`.
   - Fill it in, tick the boxes, commit it (it must be the only change), then push the tag `native-vX.Y.Z` on that commit.
5. **Publish.** The tag run re-runs every gate, checks the signoff and only then publishes the release.
   - If any gate or any checklist item fails, the release is blocked.

## Checklist

- [ ] **M1** [M] **Install on a real Android phone.**
  - Install `payesh-native.apk` from the RC on a physical phone (not an emulator) with a clean install.
  - Check that it opens, the right-to-left (RTL) layout and Jalali dates look right, you can log in, and an offline entry syncs once the network is back.
  - Record the phone model, Android version, and the APK SHA-256 from `SHA256SUMS-android`.
- [ ] **M2** [M] **Android signing.** Run `apksigner verify --verbose --print-certs payesh-native.apk`.
  - The v2/v3 scheme must show `true`.
  - The certificate SHA-256 must equal the owner's release key fingerprint.
  - The certificate must **not** be the Android debug certificate (`CN=Android Debug`).
  - Today `apps/payesh/app/android/app/build.gradle.kts` still signs `release` builds with the debug key, so this item fails. That correctly blocks any native release until owner signing is wired up (rows 61/74).
- [ ] **M3** [M] **Install on a real Windows PC.**
  - Unzip the `native-windows` bundle on a real Windows 10/11 machine (not the CI runner), launch `payesh_app.exe`, log in, and check that the local encrypted database is created.
  - Record the Windows build number and the SHA-256 of the bundle.
- [ ] **M4** [M] **Windows signing.** Run `signtool verify /pa /v payesh_app.exe`.
  - The executable must have a valid Authenticode signature from the owner's code-signing certificate, with a timestamp.
  - An unsigned build fails this item.
- [ ] **M5** [M] **Update and version rollback, Android.**
  - Install the previously published native version, create data, then install the RC over it. Data must be kept and migrations must apply.
  - Then roll back. Android refuses an install with a lower `versionCode`, so a rollback means re-releasing the previous code with a **higher** `versionCode`.
  - Install that rollback build over the RC and check that the app opens and the data is still readable. The schema must be backward compatible, or the app must refuse with a clear message and no data loss.
  - Record both version codes.
- [ ] **M6** [M] **Update and version rollback, Windows.**
  - Do the same as M5 for the Windows bundle: previous version → RC → previous version, on the same PC with the same data directory.
  - Record what happened to the local database at each step.

## What CI already proves (no manual step needed)

| Gate | What it proves |
|---|---|
| G1 | No WebView or Node in the APK, AAB or EXE (row 63) |
| G2 | Leak matrix (row 57) |
| G3 | Conformance vectors: web, Dart and server (rows 64, 70, 71, 73, 75, 81) |
| G4 | SBOM (CycloneDX, from the lockfiles) |
| G5 | Evidence labels (row 55) |
| G6 | Device identity (row 65) |
| G7 | The gate's own negative tests |

These results are [S]: CI runners and a loopback server. They are not [M] and do not replace M1–M6.
