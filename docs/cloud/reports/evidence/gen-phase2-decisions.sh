#!/usr/bin/env bash
# شاهد اجرایی ردیف‌های ۳۱–۳۴ (فاز ۲ — تصمیم‌های معماری مقصد)
# اجرا:  bash docs/cloud/reports/evidence/gen-phase2-decisions.sh
# خروجی: docs/cloud/reports/evidence/phase2-decisions.txt  (بازنویسی می‌شود؛ شاهد تاریخی نیست)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found"; exit 2; }

EVID="docs/cloud/reports/evidence/phase2-decisions.txt"
SHA=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NODE=$(node -v)
OS=$(uname -srm)

{
  echo "# شاهد اجرایی فاز ۲ — ردیف ۳۱ (ADR)، ۳۲ (مرز مخزن)، ۳۳ (مدل بار/هزینه)، ۳۴ (انتخاب ارائه‌دهنده)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $SHA"
  echo "# generated_at: $TS"
  echo "# node: $NODE"
  echo "# os: $OS"
  echo "# command: bash docs/cloud/reports/evidence/gen-phase2-decisions.sh"
  echo
  echo "════════ ۱) ردیف ۳۳ — مدل اجرایی بار و هزینه (اجرای واقعی) ════════"
  echo "\$ node tools/cost-model.cjs"
  node tools/cost-model.cjs
  echo
  echo "\$ node tools/cost-model.cjs --schools 500 --peak 6 --json | head -30"
  node tools/cost-model.cjs --schools 500 --peak 6 --json | head -30
  echo
  echo "\$ npm run test:model"
  node tests/cost-model.js
  MODEL_CODE=$?
  echo
  echo "════════ ۲) ردیف ۳۲ — مرز مخزن (کنترل fail-closed) ════════"
  echo "\$ npm run test:boundary"
  node tests/repo-boundary.js
  BOUND_CODE=$?
  echo
  echo "════════ ۳) ردیف ۳۱ / ۳۴ — اسناد تصمیم ════════"
  for f in docs/cloud/31-adr-local-engine.md docs/cloud/32-repo-boundary.md docs/cloud/33-load-cost-model.md docs/cloud/34-provider-selection.md; do
    if [ -f "$f" ]; then
      echo "OK   $f  ($(wc -l < "$f") خط · sha256=$(sha256sum "$f" | cut -d' ' -f1))"
    else
      echo "MISS $f"; MISSING=1
    fi
  done
  echo
  echo "════════ ۴) عدم رگرسیون — کل آزمون‌های مخزن ════════"
  echo "\$ npm test"
  npm test 2>&1 | tail -4
  TEST_CODE=${PIPESTATUS[0]}
  echo
  echo "نتیجه: model_exit=$MODEL_CODE boundary_exit=$BOUND_CODE tests_exit=$TEST_CODE"
  if [ "${MISSING:-0}" = "1" ]; then echo "PHASE2-FAIL (سند غایب)"; exit 1; fi
  if [ "$MODEL_CODE" != "0" ] || [ "$BOUND_CODE" != "0" ] || [ "$TEST_CODE" != "0" ]; then
    echo "PHASE2-FAIL"; exit 1
  fi
  echo "PHASE2-OK"
} > "$EVID" 2>&1

tail -3 "$EVID"
grep -q "PHASE2-OK" "$EVID" || exit 1
echo "→ $EVID"
