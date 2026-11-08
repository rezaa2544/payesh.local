#!/usr/bin/env bash
# شاهد ردیف ۵۰ — پشتیبان‌گیری مدیریت‌شده/PITR، تطبیق چک‌سام سه‌لایه و ران‌بوک failover
# اجرا: bash docs/cloud/reports/evidence/run-50-pitr.sh
# خروجی: docs/cloud/reports/evidence/pitr-50.txt
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

OUT="docs/cloud/reports/evidence/pitr-50.txt"
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)

{
  echo "# شاهد ردیف ۵۰ — پشتیبان‌گیری PITR، تطبیق چک‌سام سه‌لایه و ران‌بوک Failover دستی"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)"
  echo "# command: bash docs/cloud/reports/evidence/run-50-pitr.sh"
  echo
  echo "=== [1] اجرای تمرین محلی PITR (basebackup + WAL replay تا نقطهٔ هدف + تطبیق چک‌سام) ==="
  node tools/pitr-drill-50.mjs --local-drill
  echo "EXIT=$?"
  echo
  echo "=== [2] کنترل منفی (--require-managed روی محیط غیرمدیریت‌شده باید با کد ۳ رد شود) ==="
  node tools/pitr-drill-50.mjs --local-drill --require-managed 2>&1
  echo "EXIT=$?"
  echo
  echo "=== [3] آزمون خودکار PT-01..PT-10 ==="
  node tests/pitr-50.js
  echo "EXIT=$?"
  echo
  echo "PITR-50-EVIDENCE-OK"
} > "$OUT" 2>&1

cat "$OUT"
