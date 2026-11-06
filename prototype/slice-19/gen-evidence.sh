#!/usr/bin/env bash
# شاهد خودکار نمونهٔ فنی ۱۹ — تعارض و هم‌گرایی (۱۴ §۵)
# اجرا: bash prototype/slice-19/gen-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/slice-19-conflict.txt
# قاعدهٔ fail-closed: اگر آزمون یا هر ادعا شکست بخورد، شاهد سبز نوشته نمی‌شود.
set -u
cd "$(dirname "$0")/../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/slice-19-conflict.txt"
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! node prototype/slice-19/tests/run.js >"$TMP" 2>&1; then
  BAD="docs/cloud/reports/evidence/slice-19-conflict.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-19-FAILED: جزئیات در $BAD" >&2
  grep '^✗' "$BAD" >&2 || true
  exit 1
fi

PASS=$(sed -n 's/^SUMMARY pass=\([0-9]*\).*/\1/p' "$TMP")
FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$TMP")
TOTAL=$(sed -n 's/^.* total=\([0-9]*\)$/\1/p' "$TMP")

if [ "${FAIL:-1}" != "0" ] || [ "${PASS:-0}" -lt 40 ] || [ "$PASS" != "$TOTAL" ]; then
  BAD="docs/cloud/reports/evidence/slice-19-conflict.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-19-FAILED: شمارش ناسازگار (pass=$PASS fail=$FAIL total=$TOTAL)" >&2
  exit 1
fi

PROD=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
if [ "$PROD" != "0" ]; then
  echo "SLICE-19-FAILED: کد محصول $PROD فایل تغییر کرده — نمونهٔ ۱۹ نباید محصول را دست بزند" >&2
  exit 1
fi

{
  echo "# شاهد نمونهٔ فنی ۱۹ — تعارض و هم‌گرایی («نیازمند تصمیم»)"
  echo "# تولید: bash prototype/slice-19/gen-evidence.sh"
  echo "# base_head: $(git rev-parse HEAD)"
  echo "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)"
  echo "# command: node prototype/slice-19/tests/run.js"
  echo "# product_diff_vs_f2fc472: $PROD فایل (۰ = کد محصول دست‌نخورده)"
  echo "# مرجع طراحی: ۱۴ §۲–§۵ · D‑28 · آزمون‌های الزامی §۵ (۱–۱۱)"
  echo
  echo "## نقشهٔ آزمون‌ها ↔ §۵"
  echo "۱ دو نویسندهٔ همان فیلد ⇒ conflict.open + حفظ هر دو مقدار"
  echo "۲ فیلدهای جدا ⇒ ادغام بدون تعارض کاربری"
  echo "۳ تکرار op پس از حل ⇒ بی‌اثر"
  echo "۴ حل غیرمجاز ⇒ ۴۰۳ + audit"
  echo "۵ تعارض باز + W2 ⇒ orphaned (نه حذف)"
  echo "۶ ۱۰۰ تعارض هم‌زمان ⇒ ورودی = خروجی"
  echo "۷ LWW بسته: base_version غایب/۰ ⇒ rejected"
  echo "۸ بدون لو رفتن محتوا در پاسخ ۴۰۹"
  echo "۹ مجوزدهی دوباره هنگام حل (نقش/اسکوپ)"
  echo "۱۰ پایداری شاهد: ردیف conflict با status=open + raised_by_op_id"
  echo "۱۱ parity per-entity (مثبت/منفی)"
  echo
  echo "## خلاصه"
  echo "SUMMARY pass=$PASS fail=$FAIL total=$TOTAL"
  echo "claims_passed=$(grep -c '^✓' "$TMP")"
  echo "conflict_cases=$(grep -c 'تعارض' "$TMP")"
  echo "silent_loss_guards=$(grep -c 'حفظ\|گم‌نشدن\|بی‌صدا' "$TMP")"
  echo
  echo "## خروجی خام آزمون"
  cat "$TMP"
} >"$OUT"

echo "→ $OUT"
echo "SLICE-19-OK"
echo "checks_pass=$PASS fail=$FAIL total=$TOTAL"
