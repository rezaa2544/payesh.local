# Row 95: release gate for the native app

**What it is:** one workflow, `.github/workflows/release-gate.yml`, runs every gate that a native release depends on, all on the exact commit being released. It then prints one raw summary, `release-gate-summary.txt`.

**How it decides:** the gate is fail-closed. A release is blocked when:
- any single gate is not `success` (this includes `failure`, `cancelled`, `skipped`, or a missing result), or
- the owner's manual [M] checklist is not signed off.

## Gates

The source of truth is `docs/release/95-release-gate.json`.

| Gate | Job(s) in release-gate.yml | What it proves |
|---|---|---|
| G1-native-63 | `native` → `gate-controls`, `android`, `windows` | No WebView and no Node.js in the real APK, AAB and Windows bundle. Gate self-test plus negative controls (row 63, D-43). |
| G2-leak-matrix-57 | `leak-matrix` | Role × collection × field leak matrix, pull-leak, and the pull-leak negative control (row 57). |
| G3-conformance | `native` → `engine-web-conformance`, `sync-real-server`, `gateway-real`, `dart`; plus `api-contract` | Shared vectors on the web client, the Dart client against the real server and Gateway, the Native API v1 schema (37 checks), the vectors (61), the directory re-route and OpenAPI drift (rows 64, 66, 67, 70, 71, 73, 75, 81). |
| G4-sbom | `sbom` | A CycloneDX 1.5 SBOM built from `package-lock.json` and `apps/payesh/pubspec.lock`, with the checks listed below. |
| G5-labels-55 | `labels` | The evidence-label gate from the constitution (row 55). |
| G6-identity-65 | `identity` | Device identity: 20 checks plus 10 mutation controls (row 65). |
| G7-gate-selftest | `selftest` | `tests/release-gate-95.js`: this gate's own negative tests and mutation controls. |

The SBOM job (G4) requires all of the following:
- every npm package is pinned to the npm registry with a sha512 hash;
- every hosted pub package has a sha256;
- git dependencies are pinned to a commit;
- no path dependency points outside the repository;
- no forbidden WebView, JS-engine or Node-embedding package is present (the same list as the row 63 pubspec check).

The SBOM file is uploaded and attached to the release.

### How `native` and `api-contract` are run

`native` and `api-contract` are the existing `native-client.yml` and `api-contract.yml` workflows, called through `workflow_call`:
- **Path filters don't apply** to a called workflow. A tag therefore always rebuilds and re-checks the native app and the contract suite, even when the last commit only touched docs.
- **Inner job results are exported.** `native-client.yml` exports each inner job's result (`outputs.results`), so the gate checks every sub-gate separately. A green aggregate with a skipped `windows` job is still blocked.
- **Concurrency groups are separate.** `native-client.yml`'s concurrency group now includes `github.workflow`, so a release-gate run and the ordinary push/PR run of the same ref never cancel each other.

## Modes

| Trigger | Mode | Manual [M] checklist | Publishes |
|---|---|---|---|
| `workflow_dispatch` | rehearsal | Reported `PENDING` | No. The run builds the release candidate (RC) the owner tests on a device. |
| `pull_request` (only when the gate files change) | rehearsal | `PENDING` | No |
| tag `native-v*` | release | Required: `docs/release/signoff/<tag>.md` | Yes. `publish` runs only when `needs.verdict.result == 'success'`. |

In release mode, the signoff must meet all of these conditions:
- `tag` matches the tag being released;
- `owner` is non-empty, and `date` is in YYYY-MM-DD form;
- `result: PASS`;
- items M1–M6 are all ticked, and no box is left unticked;
- `rc_sha` is a full sha and an ancestor of the tag;
- every file changed between `rc_sha` and the tag is under `docs/release/`.

The last condition proves that the build the owner tested on the phone and the PC is the same product that gets published. The checklist itself is `docs/release/95-owner-checklist.md`, with M1–M6, all [M]: a real Android install, Android signing, a real Windows install, Windows signing, and Android and Windows update → rollback.

## Raw summary format

```
# release gate (row 95) — raw summary
sha=<commit>
mode=rehearsal|release [tag=native-vX.Y.Z]
date_utc=…
config=docs/release/95-release-gate.json gates=7

GATE G1-native-63       PASS   native=success native/gate-controls=success native/android=success native/windows=success  — …
…
MANUAL [M] owner          PENDING docs/release/95-owner-checklist.md items=M1,M2,M3,M4,M5,M6 (…)

RELEASE-GATE-OK gates_pass=7/7 manual=PENDING (rehearsal — publish disabled)
```

A blocked run ends with `RELEASE-GATE-BLOCKED gates_pass=a/b reasons=n`, followed by one `✗` line per reason.

## Negative tests

`tests/release-gate-95.js` runs in the `selftest` job and in `build.yml` on every push. It has 24 checks:

| Check | What it covers |
|---|---|
| RG-02 | Each of the 8 job slots is set to `failure`, `cancelled`, `skipped` or missing in turn: 32 single-failure cases, and every one is blocked with the gate named. |
| RG-03 | Each of the 7 native sub-jobs is set to failure, skipped or absent, and the case with no outputs at all is added: 22 cases, all blocked. |
| RG-04 / RG-05 | Garbage or empty input and empty configs are blocked. |
| RG-06 | Workflow wiring: the verdict's `needs` equals the configured jobs, it runs `if: always()`, publishing waits for a green verdict, nothing publishes before the verdict, and `native-client.yml` exports every configured sub-result. |
| RG-07 | CLI exit codes. |
| RG-08 | Release mode. Ten broken signoff or verdict cases are blocked (missing signoff, an unticked M3, `result: FAIL`, empty owner, bad date, short `rc_sha`, `rc_sha` not an ancestor, product changed after the RC, a non-`native-v` tag, a red gate despite a signoff). One complete signoff is allowed. |
| RG-09 | The checklist content. |
| SB-01…SB-10 | The real-tree SBOM, which must be byte-identical across runs, plus one fixture per violation class. |
| MUT-* | Five mutation controls. Each reverts one check in `tools/release-gate-95.mjs`, and the targeted test must go red: job result, sub-result, "missing counts as success", signoff ticks, product diff. |

## Limits

- **Today the native APK is signed with the Android debug key.** `apps/payesh/app/android/app/build.gradle.kts` sets `release { signingConfig = debug }`, so M2 cannot pass. A native release is therefore correctly blocked until owner signing is wired up (rows 61/74). The CI gates themselves pass.
- **Windows Authenticode signing of the native bundle is not wired up yet,** so M4 cannot pass either.
- **This gate covers native releases only (`native-v*`).** The existing web/local channel (`build.yml` → `continuous`, and `v*` tags) is unchanged.
- **CI results are [S]** (runners and loopback). They do not replace the owner's [M] checks.
