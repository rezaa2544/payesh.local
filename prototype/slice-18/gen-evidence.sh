#!/usr/bin/env bash
# شاهد خودکار نمونهٔ فنی ۱۸ — صف آفلاین، کش امن، ابطال دستگاه
# اجرا: bash prototype/slice-18/gen-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/slice-18-queue-cache.txt
# قاعدهٔ fail-closed: اگر آزمون یا هر ادعا شکست بخورد، شاهد سبز نوشته نمی‌شود.
set -u
cd "$(dirname "$0")/../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/slice-18-queue-cache.txt"
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! node prototype/slice-18/tests/run.js >"$TMP" 2>&1; then
  BAD="docs/cloud/reports/evidence/slice-18-queue-cache.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-18-FAILED: جزئیات در $BAD" >&2
  grep '^✗' "$BAD" >&2 || true
  exit 1
fi

PASS=$(sed -n 's/^SUMMARY pass=\([0-9]*\).*/\1/p' "$TMP")
FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$TMP")
TOTAL=$(sed -n 's/^.* total=\([0-9]*\)$/\1/p' "$TMP")

if [ "${FAIL:-1}" != "0" ] || [ "${PASS:-0}" -lt 35 ] || [ "$PASS" != "$TOTAL" ]; then
  BAD="docs/cloud/reports/evidence/slice-18-queue-cache.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-18-FAILED: شمارش ناسازگار (pass=$PASS fail=$FAIL total=$TOTAL)" >&2
  exit 1
fi

# گارد مکمل: کد محصول در این مرحله نباید تغییر کند
PROD=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
if [ "$PROD" != "0" ]; then
  echo "SLICE-18-FAILED: کد محصول $PROD فایل تغییر کرده — نمونهٔ ۱۸ نباید محصول را دست بزند" >&2
  exit 1
fi

{
  echo "# شاهد نمونهٔ فنی ۱۸ — صف آفلاین، کش امن و ابطال دستگاه"
  echo "# تولید: bash prototype/slice-18/gen-evidence.sh"
  echo "# base_head: $(git rev-parse HEAD)"
  echo "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)"
  echo "# command: node prototype/slice-18/tests/run.js"
  echo "# product_diff_vs_f2fc472: $PROD فایل (۰ = کد محصول دست‌نخورده)"
  echo "# مرجع طراحی: ۱۳ §۳.۱–§۳.۳ و §۴ (قرارداد صف، قاعدهٔ ۳۰ روز، ابطال دستگاه، امنیت کش) · D‑27 · CC‑13‑۱/۲/۳"
  echo
  echo "## خلاصه"
  echo "SUMMARY pass=$PASS fail=$FAIL total=$TOTAL"
  echo "claims_passed=$(grep -c '^✓' "$TMP")"
  echo "queue_and_cap_cases=$(grep -c '۲۰۰۰\|queue_full\|هشدار' "$TMP")"
  echo "tenant_or_identity_cases=$(grep -c 'نشست\|tenant' "$TMP")"
  echo "orphan_and_revoke_cases=$(grep -c 'orphaned\|ابطال\|W2' "$TMP")"
  echo
  echo "## قیدهای آزمون‌شده"
  echo "MAX_OPS=2000  WARN=90%  REVIEW_DAYS=30  CACHE_TTL=7d  CACHE=AES-256-GCM  CLOCK=monotonic-after-sync"
  echo
  echo "## خروجی خام آزمون"
  cat "$TMP"
} >"$OUT"

echo "→ $OUT"
echo "SLICE-18-OK"
echo "checks_pass=$PASS fail=$FAIL total=$TOTAL"
