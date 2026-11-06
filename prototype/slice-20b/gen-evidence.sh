#!/usr/bin/env bash
# شاهد خودکار نمونهٔ ۲۰‑ب — چندمستأجری: نشت بین‌مدرسه‌ای، سقف پلن، حالت‌های اشتراک، مجوز اضطراری
# اجرا: bash prototype/slice-20b/gen-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/slice-20b-tenant-isolation.txt
# قاعدهٔ fail-closed: آزمون ناموفق، شمارش ناسازگار، کنترل منفی بی‌اثر، یا تغییر کد محصول ⇒ شاهد سبز نوشته نمی‌شود.
set -u
cd "$(dirname "$0")/../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/slice-20b-tenant-isolation.txt"
BASE="f2fc472c643a52d393b3160405e1581bda64da25"
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp)
MUT=$(mktemp)
trap 'rm -f "$TMP" "$MUT"; rm -rf "$MUTDIR"' EXIT
MUTDIR=$(mktemp -d)

START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fail_evidence() {
  local why="$1"
  local bad="docs/cloud/reports/evidence/slice-20b-tenant-isolation.FAILED-$TS.txt"
  { echo "# FAILED: $why"; echo "# at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo; cat "$TMP"; } >"$bad"
  echo "SLICE-20B-FAILED: $why (جزئیات: $bad)" >&2
  exit 1
}

# ۱) اجرای آزمون‌ها
if ! node prototype/slice-20b/tests/run.js >"$TMP" 2>&1; then
  fail_evidence "آزمون‌ها ناموفق‌اند"
fi
PASS=$(sed -n 's/^SUMMARY pass=\([0-9]*\).*/\1/p' "$TMP")
FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$TMP")
TOTAL=$(sed -n 's/^.* total=\([0-9]*\)$/\1/p' "$TMP")
[ "${FAIL:-1}" = "0" ] || fail_evidence "fail=$FAIL"
[ "${PASS:-0}" = "${TOTAL:-0}" ] || fail_evidence "pass=$PASS ≠ total=$TOTAL"
[ "${PASS:-0}" -ge 60 ] || fail_evidence "تعداد ادعا کمتر از حد انتظار ($PASS)"

# ۲) کنترل منفی: با برداشتن گاردها، آزمون باید شکست بخورد (اثبات غیر‌توخالی بودن)
cp -r prototype/slice-20b "$MUTDIR/s" && cp -r prototype/slice-19 "$MUTDIR/slice-19" && cp -r prototype/slice-20 "$MUTDIR/slice-20"
python3 - "$MUTDIR/s/platform.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace("""if (op && op.tenant_id !== undefined && op.tenant_id !== session.tenant_id) {
        throw new RequestError('tenant_mismatch', 403);
      }""", "/* MUTATION: tenant guard removed */")
s = s.replace("if (!String(key).startsWith(`${tenant.storage_prefix}/`)) throw new RequestError('tenant_mismatch', 403);",
              "/* MUTATION: storage prefix guard removed */")
open(p, 'w', encoding='utf-8').write(s)
PY
node "$MUTDIR/s/tests/run.js" >"$MUT" 2>&1 || true
MUT_FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$MUT")
[ "${MUT_FAIL:-0}" -ge 1 ] || fail_evidence "کنترل منفی بی‌اثر بود (تلاش نشت شناسایی نشد)"

# ۳) گارد کد محصول: هیچ تغییری در مسیرهای محصول، نسبت به SHA پایهٔ ممیزی و در درخت کاری
PROD_BASE=$(git diff --name-only "$BASE" HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy 2>/dev/null | wc -l | tr -d ' ')
PROD_WORK=$(git status --porcelain -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
[ "$PROD_BASE" = "0" ] || fail_evidence "کد محصول نسبت به $BASE تغییر کرده ($PROD_BASE فایل)"
[ "$PROD_WORK" = "0" ] || fail_evidence "درخت کاری در مسیر محصول تغییر دارد ($PROD_WORK فایل)"

{
  echo "# شاهد نمونهٔ فنی ۲۰‑ب — آزمون چندمستأجری (نشت، سقف پلن، اشتراک، مجوز اضطراری)"
  echo "# تولید: bash prototype/slice-20b/gen-evidence.sh"
  echo "# base_head: $(git rev-parse HEAD)"
  echo "# audit_base: $BASE"
  echo "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# started_utc: $START"
  echo "# node: $(node -v)"
  echo "# os: $(uname -srm)"
  echo "# command: node prototype/slice-20b/tests/run.js"
  echo "# product_diff_vs_base: $PROD_BASE فایل (۰ = کد محصول دست‌نخورده)"
  echo "# working_tree_product_changes: $PROD_WORK"
  echo "# مرجع: ۱۶‑ب §۱.۱ · ۱۵ §۲/§۴ · ۱۲‑ب §۳.۳ · ۰۱‑ب §۲.۶ · D‑07/D‑21/D‑22/D‑23/D‑27"
  echo
  echo "## نقشهٔ ادعاها ↔ معیار پذیرش ۲۰‑ب"
  echo "I (۱۵ ادعا) جداسازی مستأجر: خواندن/نوشتن/حذف بین‌مدرسه‌ای · نشت صف · نشت کش · تفکیک بکاپ ·"
  echo "   وارد‌کردن بکاپ مستأجر دیگر · پیشوند مستأجر در کلید شیء · بلیت مقید · نبود اعتبارنامهٔ پخته (F‑04) · پنل بی‌محتوا (D‑21)"
  echo "C (۹ ادعا) سقف پلن در API: کاربر · دانش‌آموز · فضا · قابلیت — با پیام فارسی و شمارش سروری (نادیده‌گرفتن ادعای کلاینت)"
  echo "S (۲۰ ادعا) حالت‌های اشتراک D‑22: active/grace/suspended/expired/canceled · ورود/خواندن/نوشتن ·"
  echo "   نگهداری ۱۸۰ روز · گذارهای مجاز و ممنوع · حذف فقط با سیاست · idempotency · بدون وضعیت trialing (A‑03)"
  echo "E (۱۶ ادعا) مجوز اضطراری D‑21: تأیید مالک + اطلاع مدرسه · چهارچشمی · انقضا · ابطال فوری دو‌طرفه ·"
  echo "   ثبت هر خواندن · سقف اقدام · ممنوعیت دانلود انبوه · رد content_write در لایهٔ داده"
  echo "X (۶ ادعا) استفادهٔ متقابل توکن سطح A و B: رد دو‌طرفه · جعل بدنه · انقضا · حل tenant از توکن"
  echo "G (۴ ادعا) صداقت: نمای فراداده بدون محتوا · زنجیرهٔ هش سالم · فهرست اثبات‌شده/نشده · ثابت‌های مصوب"
  echo
  echo "## کنترل منفی (اثبات غیر‌توخالی بودن آزمون)"
  echo "با برداشتن گارد tenant در نوشتن و گارد پیشوند در فضای ذخیره‌سازی: fail=$MUT_FAIL"
  grep '^✗' "$MUT" || true
  echo
  echo "## خلاصه"
  echo "SUMMARY pass=$PASS fail=$FAIL total=$TOTAL"
  echo "claims_passed=$(grep -c '^✓' "$TMP")"
  echo "isolation_claims=$(grep -c '^✓ I' "$TMP")"
  echo "cap_claims=$(grep -c '^✓ C' "$TMP")"
  echo "subscription_claims=$(grep -c '^✓ S' "$TMP")"
  echo "emergency_claims=$(grep -c '^✓ E' "$TMP")"
  echo "token_claims=$(grep -c '^✓ X' "$TMP")"
  echo "honesty_claims=$(grep -c '^✓ G' "$TMP")"
  echo
  echo "## خروجی خام آزمون"
  cat "$TMP"
  echo
  echo "## آنچه این شاهد اثبات نمی‌کند"
  echo "- کد محصول هنوز تک‌مستأجری است (F‑05)؛ این آزمون روی نمونهٔ لایهٔ داده اجرا شده، نه روی API محصول."
  echo "- RLS واقعی PostgreSQL در آزمون A‑02 جدا اثبات شده (۱۴/۱۴)؛ تکرار آن بخشی از این شاهد نیست."
  echo "- ظرفیت/کارایی/دسترس‌پذیری و Security Gate همچنان ادعانشده نیستند."
  echo
  echo "# ===== FOOTER ====="
  echo "EXIT=0"
} >"$OUT"

echo "→ $OUT"
echo "SLICE-20B-OK"
echo "checks_pass=$PASS fail=$FAIL total=$TOTAL"
echo "isolation=$(grep -c '^✓ I' "$TMP") caps=$(grep -c '^✓ C' "$TMP") subscription=$(grep -c '^✓ S' "$TMP") emergency=$(grep -c '^✓ E' "$TMP") tokens=$(grep -c '^✓ X' "$TMP") honesty=$(grep -c '^✓ G' "$TMP")"
echo "negative_control_fail=$MUT_FAIL"
