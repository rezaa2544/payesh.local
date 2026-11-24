#!/bin/bash
# LAB-176: Flutter suites rerun ALONE, sequential, --concurrency=1 (sandbox 2 GB; attempt1 OOM-killed). Same tests as CI native-client "tests + coverage".
T=$HOME/lab176/scripts/run-t.sh
$T FL-04-test-app "flutter test --coverage app (CI; --concurrency=1 for 2 GB sandbox)" -- "cd apps/payesh/app && flutter test --coverage --concurrency=1"
$T FL-05-test-owner "flutter test --coverage owner (CI; --concurrency=1 for 2 GB sandbox)" -- "cd apps/payesh/owner && flutter test --coverage --concurrency=1"
for p in payesh_core payesh_data payesh_owner_api payesh_secure payesh_sync payesh_ui payesh_update; do
  $T FL-06-test-$p "package tests (CI rule: flutter test for flutter pkgs, coverage:test_with_coverage otherwise)" -- "cd apps/payesh/packages/$p && if grep -q 'sdk: flutter' pubspec.yaml; then flutter test --concurrency=1 --coverage; else dart run coverage:test_with_coverage; fi"
done
$T FL-07-coverage-check "coverage gate COVERAGE_MIN=80 (CI)" -- "cd apps/payesh && dart tool/coverage_check.dart 80 app/coverage/lcov.info owner/coverage/lcov.info packages/*/coverage/lcov.info"
echo FL-SEQ-DONE >> $HOME/lab176/raw/SUMMARY.txt
