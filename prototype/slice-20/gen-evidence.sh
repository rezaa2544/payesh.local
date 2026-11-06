#!/usr/bin/env bash
# شاهد خودکار نمونهٔ فنی ۲۰ — امنیت، بار و قطعی سراسری (۰۴ §۳/§۵ · ۱۶ §۷)
# اجرا: bash prototype/slice-20/gen-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/slice-20-load-chaos.txt
# قاعدهٔ fail-closed: آزمون ناموفق، شمارش ناسازگار یا تغییر کد محصول ⇒ شاهد سبز نوشته نمی‌شود.
set -u
cd "$(dirname "$0")/../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/slice-20-load-chaos.txt"
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! node prototype/slice-20/tests/run.js >"$TMP" 2>&1; then
  BAD="docs/cloud/reports/evidence/slice-20-load-chaos.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-20-FAILED: جزئیات در $BAD" >&2
  grep '^✗' "$BAD" >&2 || true
  exit 1
fi

PASS=$(sed -n 's/^SUMMARY pass=\([0-9]*\).*/\1/p' "$TMP")
FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$TMP")
TOTAL=$(sed -n 's/^.* total=\([0-9]*\)$/\1/p' "$TMP")

if [ "${FAIL:-1}" != "0" ] || [ "${PASS:-0}" -lt 55 ] || [ "$PASS" != "$TOTAL" ]; then
  BAD="docs/cloud/reports/evidence/slice-20-load-chaos.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-20-FAILED: شمارش ناسازگار (pass=$PASS fail=$FAIL total=$TOTAL)" >&2
  exit 1
fi

# گارد: نمونه نباید کد محصول را دست بزند (D‑09 / همان قاعدهٔ نمونه‌های ۱۷–۱۹)
PROD=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
if [ "$PROD" != "0" ]; then
  echo "SLICE-20-FAILED: کد محصول $PROD فایل تغییر کرده — نمونهٔ ۲۰ نباید محصول را دست بزند" >&2
  exit 1
fi

# شاهد عددی پله‌های بار — از خروجی خام، بدون بازنویسی
STAGE_ROWS=$(grep -c '^| c[0-9]' "$TMP" || true)

{
  echo "# شاهد نمونهٔ فنی ۲۰ — آزمون امنیت، بار و قطعی سراسری"
  echo "# تولید: bash prototype/slice-20/gen-evidence.sh"
  echo "# base_head: $(git rev-parse HEAD)"
  echo "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# started_utc: $START"
  echo "# node: $(node -v)"
  echo "# os: $(uname -srm)"
  echo "# command: node prototype/slice-20/tests/run.js"
  echo "# product_diff_vs_f2fc472: $PROD فایل (۰ = کد محصول دست‌نخورده)"
  echo "# مرجع طراحی: ۰۴ §۳ (C‑1..C‑5) · ۰۴ §۵ (F‑C1/F‑C2/F‑C4/F‑C6) · ۱۶ §۷ (هزینه/گلوگاه) · D‑11"
  echo
  echo "## نقشهٔ آزمون‌ها ↔ اهداف"
  echo "A امنیت مرز (۱۹ ادعا): بدون توکن، امضای جعلی، انقضا، alg=none، قاچاق tenant در بدنه،"
  echo "  خواندن/نوشتن بین‌مدرسه‌ای، ارتقای نقش، دست‌کاری بدنه، سقف دسته، حملهٔ حدس توکن + قفل،"
  echo "  تزریق/آلودگی prototype، ابطال دستگاه، مستأجر تعلیق‌شده"
  echo "B جداسازی مستأجر زیر بار (۷ ادعا): ۸ مستأجر هم‌زمان، صفر نشت، تعارض محدود به مستأجر،"
  echo "  یکتایی op_id مستأجر‑محور، زنجیرهٔ audit سالم"
  echo "C بار افزایشی (۹ ادعا): ۵ پله تا ۶۴ کارگر — C‑1 (p95 خواندن ≤ ۳۰۰ms)، C‑2 (p95 نوشتن ≤ ۸۰۰ms)،"
  echo "  C‑3 (نرخ خطای سخت < ۰٫۱٪)، C‑4 (افت p95 در تکرار اوج ≤ ۲۰٪)، بازتولیدپذیری با بذر ثابت"
  echo "D قطعی دیتاسنتر (۹ ادعا): هیچ موفقیت جعلی، صف حفظ، سقف ۲۰۰۰/دستگاه، تخلیهٔ کامل، دقیقاً‑یک‌بار،"
  echo "  idempotent، حالت degraded با پیام صریح، ثبت شروع/پایان در audit"
  echo "E از دست رفتن شبکه (۷ ادعا): صف حفظ، عقب‌نشینی سقف‌دار، ack_unknown هرگز «موفق»، بازیابی، بدون تکرار/گم‌شدن"
  echo "F منابع/ظرفیت/هزینه/گلوگاه (۱۰ ادعا): نرخ خطا، latency، CPU/heap، ظرفیت اندازه‌گیری‌شده،"
  echo "  هزینهٔ جزئی با قیمت واحد نامعلوم (total=null)، گلوگاه‌های مستند، صداقت گزارش"
  echo
  echo "## خلاصه"
  echo "SUMMARY pass=$PASS fail=$FAIL total=$TOTAL"
  echo "claims_passed=$(grep -c '^✓' "$TMP")"
  echo "security_claims=$(grep -c '^✓ A' "$TMP")"
  echo "isolation_claims=$(grep -c '^✓ B' "$TMP")"
  echo "load_claims=$(grep -c '^✓ C' "$TMP")"
  echo "outage_claims=$(grep -c '^✓ D' "$TMP")"
  echo "network_claims=$(grep -c '^✓ E' "$TMP")"
  echo "metrics_claims=$(grep -c '^✓ F' "$TMP")"
  echo "measured_stage_rows=$STAGE_ROWS"
  echo
  echo "## خروجی خام آزمون (شامل جدول پله‌ها و گزارش سنجه‌ها)"
  cat "$TMP"
  echo
  echo "# ===== FOOTER ====="
  echo "EXIT=0"
} >"$OUT"

echo "→ $OUT"
echo "SLICE-20-OK"
echo "checks_pass=$PASS fail=$FAIL total=$TOTAL"
echo "security=$(grep -c '^✓ A' "$TMP") isolation=$(grep -c '^✓ B' "$TMP") load=$(grep -c '^✓ C' "$TMP") outage=$(grep -c '^✓ D' "$TMP") network=$(grep -c '^✓ E' "$TMP") metrics=$(grep -c '^✓ F' "$TMP")"
