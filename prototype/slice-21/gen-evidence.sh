#!/usr/bin/env bash
# شاهد خودکار نمونهٔ فنی ۲۱ — پایلوت، مهاجرت کنترل‌شده، بازیابی و rollback
# اجرا: bash prototype/slice-21/gen-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/slice-21-pilot-migration.txt
# قاعدهٔ fail-closed: آزمون ناموفق، شمارش ناسازگار یا تغییر کد محصول ⇒ شاهد سبز نوشته نمی‌شود.
set -u
cd "$(dirname "$0")/../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/slice-21-pilot-migration.txt"
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! node prototype/slice-21/tests/run.js >"$TMP" 2>&1; then
  BAD="docs/cloud/reports/evidence/slice-21-pilot-migration.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-21-FAILED: جزئیات در $BAD" >&2
  grep '^✗' "$BAD" >&2 || true
  exit 1
fi

PASS=$(sed -n 's/^SUMMARY pass=\([0-9]*\).*/\1/p' "$TMP")
FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$TMP")
TOTAL=$(sed -n 's/^.* total=\([0-9]*\)$/\1/p' "$TMP")

if [ "${FAIL:-1}" != "0" ] || [ "${PASS:-0}" -lt 50 ] || [ "$PASS" != "$TOTAL" ]; then
  BAD="docs/cloud/reports/evidence/slice-21-pilot-migration.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-21-FAILED: شمارش ناسازگار (pass=$PASS fail=$FAIL total=$TOTAL)" >&2
  exit 1
fi

PROD=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
if [ "$PROD" != "0" ]; then
  echo "SLICE-21-FAILED: کد محصول $PROD فایل تغییر کرده — نمونهٔ ۲۱ نباید محصول را دست بزند" >&2
  exit 1
fi

{
  echo "# شاهد نمونهٔ فنی ۲۱ — پایلوت، مهاجرت کنترل‌شده، بازیابی و rollback"
  echo "# تولید: bash prototype/slice-21/gen-evidence.sh"
  echo "# base_head: $(git rev-parse HEAD)"
  echo "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# started_utc: $START"
  echo "# node: $(node -v)"
  echo "# os: $(uname -srm)"
  echo "# command: node prototype/slice-21/tests/run.js"
  echo "# product_diff_vs_f2fc472: $PROD فایل (۰ = کد محصول دست‌نخورده)"
  echo "# مرجع طراحی: ۱۶‑ب §۳.۱ (۹ گام) و §۳.۳ (گزارش) · ۱۵ §۲.۱/§۳/§۳.۲/§۴ · ۱۶ §۶"
  echo
  echo "## نقشهٔ آزمون‌ها ↔ معیار پذیرش ۲۱"
  echo "M مهاجرت (۲۰ ادعا): پیش‌بررسی بکاپ+SHA · افزودن tenant_id · کپی سایه/نوشتن مضاعف ·"
  echo "  تطبیق شمارش+هش · RLS قرنطینه (نشت صفر) · بازرمزنگاری کلید مستأجر (AAD) · سوئیچ خواندن ·"
  echo "  حذف مسیر قدیم فقط پس از ۷ روز · گزارش کامل §۳.۳ · ترتیب گام‌ها · توقف در عدم‌تطبیق · rollback بدون حذف داده"
  echo "P پایلوت/go‑no‑go (۱۹ ادعا): شروع مالک‌محور · گسترش فقط با عکس لحظه‌ای سنجه‌ها · پله‌به‌پله (۱→۱۰→۵۰→۲۰۰) ·"
  echo "  آستانه‌های ۱۶ §۶ (P0/P1/P2) · توقف در P1 · freeze در P0 · override فقط مالک+دلیل · توقف idempotent · rollback موج"
  echo "R بازیابی/آشتی/rollback (۱۵ ادعا): فقط مالک+دلیل · امضای مانیفست · SHA پاکت · قرنطینه پیش از swap ·"
  echo "  بررسی محتوا با مانیفست · swap اتمی + ابطال نشست · آشتی outbox (applied/conflicted/lost) ·"
  echo "  ممنوعیت نوشتن users/sessions/audit از بکاپ کلاینت (F‑02) · گزارش RTO/RPO · idempotency"
  echo "G صداقت و پیوند (۴ ادعا): مقدار+آستانه در گزارش · بدون ادعای «آمادهٔ تولید» · زنجیرهٔ audit · rollback با snapshot"
  echo
  echo "## خلاصه"
  echo "SUMMARY pass=$PASS fail=$FAIL total=$TOTAL"
  echo "claims_passed=$(grep -c '^✓' "$TMP")"
  echo "migration_claims=$(grep -c '^✓ M' "$TMP")"
  echo "pilot_claims=$(grep -c '^✓ P' "$TMP")"
  echo "restore_claims=$(grep -c '^✓ R' "$TMP")"
  echo "honesty_claims=$(grep -c '^✓ G' "$TMP")"
  echo
  echo "## خروجی خام آزمون"
  cat "$TMP"
  echo
  echo "# ===== FOOTER ====="
  echo "EXIT=0"
} >"$OUT"

echo "→ $OUT"
echo "SLICE-21-OK"
echo "checks_pass=$PASS fail=$FAIL total=$TOTAL"
echo "migration=$(grep -c '^✓ M' "$TMP") pilot=$(grep -c '^✓ P' "$TMP") restore=$(grep -c '^✓ R' "$TMP") honesty=$(grep -c '^✓ G' "$TMP")"
