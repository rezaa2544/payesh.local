#!/bin/bash
# LAB-176 rerun of all sandbox suites after the sandbox reset (raw -> ~/lab176/raw)
T=$HOME/lab176/scripts/run-t.sh
cd /work/repo
$T REG-01-npm-test "full repo test suite (tests/run.js) after D-01/D-02" -- npm test
$T SEC-01-security-gate "security gate: 40 attacks + negative controls" -- "bash docs/cloud/reports/evidence/gen-security-gate.sh; rc=\$?; cat docs/cloud/reports/evidence/cc-security-gate.txt 2>/dev/null | tail -40; git checkout -- docs/cloud/reports/evidence/; exit \$rc"
$T SEC-02-pentest57 "multi-school sync leak pentest (IDOR/tenant tampering)" -- npm run test:pentest57
$T SEC-03-security48 "SAST semgrep + secrets + deps gate with negative controls" -- npm run test:security48
$T SEC-04-secure-web "device secure store (after D-02)" -- npm run test:secure
$T SEC-05-npm-audit "dependency vulnerability scan" -- npm audit
$T SEC-06-fuzz83 "convergence fuzz (12 seeds)" -- npm run test:fuzz83
$T SEC-07-revocation44 "token/session revocation" -- npm run test:revocation
$T SEC-08-pull57 "pull leak across schools" -- npm run test:pull57
$T CH-01-chaos47 "chaos: crash/restart/partial failures" -- npm run test:chaos47
$T CH-02-conflict41 "conflict convergence" -- npm run test:conflict41
$T CH-03-restart "server restart recovery" -- npm run test:restart
$T CH-04-contract "sync contract (server)" -- npm run test:contract
$T CH-05-contract-client "sync contract (client)" -- npm run test:contract:client
python3 $HOME/lab176/scripts/ci-pg-suite.py >> $HOME/lab176/raw/SUMMARY.txt 2>&1
cd /work/repo/apps/payesh
$T FL-00-pub-get "flutter pub get --enforce-lockfile (CI)" -- "cd apps/payesh && flutter pub get --enforce-lockfile"
$T FL-01-native-deps "no WebView/JS package in pubspec.lock (CI native-deps)" -- "cd apps/payesh && if grep -nEi '^  (webview[a-z_]*|[a-z_]*_webview[a-z_]*|flutter_inappwebview[a-z_]*|flutter_js|flutter_qjs|nodejs[a-z_]*|capacitor[a-z_]*|cordova[a-z_]*):' pubspec.lock; then echo NATIVE-DEPS-FAIL; exit 1; fi; echo NATIVE-DEPS-OK"
$T FL-02-dart-format "dart format --set-exit-if-changed (CI)" -- "cd apps/payesh && dart format --output=none --set-exit-if-changed app/lib app/test owner/lib owner/test packages tool"
$T FL-03-analyze "flutter/dart analyze --fatal-infos --fatal-warnings, all packages (CI)" -- "cd apps/payesh && set -euo pipefail && (cd app && flutter analyze --fatal-infos --fatal-warnings) && (cd owner && flutter analyze --fatal-infos --fatal-warnings) && for p in packages/*/; do if grep -q 'sdk: flutter' \$p/pubspec.yaml; then (cd \$p && flutter analyze --fatal-infos --fatal-warnings); else (cd \$p && dart analyze --fatal-infos --fatal-warnings); fi; done && dart analyze --fatal-infos tool"
$T FL-04-test-app "flutter test --coverage app (CI)" -- "cd apps/payesh/app && flutter test --coverage"
$T FL-05-test-owner "flutter test --coverage owner (CI)" -- "cd apps/payesh/owner && flutter test --coverage"
for p in payesh_core payesh_data payesh_owner_api payesh_secure payesh_sync payesh_ui payesh_update; do
  $T FL-06-test-$p "package tests (CI rule: flutter test for flutter pkgs, coverage:test_with_coverage otherwise)" -- "cd apps/payesh/packages/$p && if grep -q 'sdk: flutter' pubspec.yaml; then flutter test --concurrency=1 --coverage; else dart run coverage:test_with_coverage; fi"
done
$T FL-07-coverage-check "coverage gate COVERAGE_MIN=80 (CI)" -- "cd apps/payesh && dart tool/coverage_check.dart 80 app/coverage/lcov.info owner/coverage/lcov.info packages/*/coverage/lcov.info"
echo MASTER-DONE >> $HOME/lab176/raw/SUMMARY.txt
