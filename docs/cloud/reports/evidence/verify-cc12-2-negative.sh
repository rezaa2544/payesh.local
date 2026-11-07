#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC‑12‑2 — «شاهد ناقص، عدد ناسازگار، هش ناهمخوان یا
# تغییر محصول بیرون از فهرست مجاز نباید CLOSED بگیرد»
# اجرا: bash docs/cloud/reports/evidence/verify-cc12-2-negative.sh
# خروجی: docs/cloud/reports/evidence/cc12-2-negative.txt ⇒ NEGATIVE-OK
set -u
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-cc12-2-gate.sh
OUT=$D/cc12-2-negative.txt
RAW=$D/cc12-2-product-rls.txt
TESTS=$D/mission-05-tests-run.log
DOC12=docs/cloud/12-multitenant-architecture.md
REV12=docs/cloud/reports/REVIEW-12-CONDITIONS.md
CONST=docs/00-PAYESH-CLOUD-CONSTITUTION.md

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt; : > "$LOG"
PASS=0; FAIL=0

pos() { PASS=$((PASS+1)); echo "PASS  $1  $2" | tee -a "$LOG"; }
neg() { FAIL=$((FAIL+1)); echo "FAIL  $1  $2" | tee -a "$LOG"; }

reject() { # id desc expected-reason env...
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env "$@" CC122_OUT=/dev/null CC122_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC12-2-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    pos "$id" "رد شد: $desc → $(printf '%s' "$err" | head -1 | cut -c1-78)"
  else
    neg "$id" "پذیرفته شد/دلیل اشتباه: $desc → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)"
  fi
}

# کنترل مثبت — شاهد سالم باید قبول شود
if CC122_OUT="$TMP/pos.txt" CC122_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1 && grep -qF 'CC12-2-CLOSED' "$TMP/pos.txt"; then
  pos P0 "شاهد سالم پذیرفته شد (کنترل مثبت)"
else
  neg P0 "شاهد سالم رد شد — دروازه معیوب است"
fi

# N1 حذف یک ادعا
grep -v '^PASS  P13  ' "$RAW" > "$TMP/raw.missing.txt"
reject N1 "ادعای P13 از شاهد حذف شد" "TOTAL-MISMATCH" CC122_RAW="$TMP/raw.missing.txt"

# N2 تبدیل یک PASS به FAIL
sed 's/^PASS  P12  /FAIL  P12  /' "$RAW" > "$TMP/raw.flip.txt"
reject N2 "ادعای P12 به FAIL تبدیل شد" "FAIL-LINE" CC122_RAW="$TMP/raw.flip.txt"

# N3 ادعای FAIL غیرصفر
sed 's/^TOTAL 20 · FAIL 0$/TOTAL 20 · FAIL 1/' "$RAW" > "$TMP/raw.total.txt"
reject N3 "خط TOTAL عدد FAIL را ۱ می‌گوید" "TOTAL-FAIL" CC122_RAW="$TMP/raw.total.txt"

# N4 خروجی غیرصفر
grep -vE '^EXIT=0( |$)' "$RAW" > "$TMP/raw.exit.txt"
reject N4 "خط EXIT=0 حذف شد" "EXIT" CC122_RAW="$TMP/raw.exit.txt"

# N5 اثر انگشت درخت جعلی
sed 's/^# product_tree_sha256: .*/# product_tree_sha256: 0000000000000000000000000000000000000000000000000000000000000000/' "$RAW" > "$TMP/raw.tree.txt"
reject N5 "اثر انگشت محصول جعل شد" "RAW-TREE-MISMATCH" CC122_RAW="$TMP/raw.tree.txt"

# N6 شاهد بدون نسخهٔ PostgreSQL
grep -v '^# postgres version:' "$RAW" > "$TMP/raw.nopg.txt"
reject N6 "خط نسخهٔ PostgreSQL حذف شد" "PG-VERSION" CC122_RAW="$TMP/raw.nopg.txt"

# N7 هش هارنس دست‌کاری‌شده
sed 's/^# sha256(product-rls-path.cjs): .*/# sha256(product-rls-path.cjs): deadbeef/' "$RAW" > "$TMP/raw.hash.txt"
reject N7 "هش هارنس دست‌کاری شد" "HARNESS-HASH" CC122_RAW="$TMP/raw.hash.txt"

# N8 حذف شناسهٔ یک ادعای الزامی (بدون تغییر تعداد)
sed 's/^PASS  N0b  /PASS  X0b  /' "$RAW" > "$TMP/raw.id.txt"
reject N8 "شناسهٔ ادعای الزامی N0b تغییر کرد" "REQ-ASSERT" CC122_RAW="$TMP/raw.id.txt"

# N9 سند ۱۲ که شرط را CLOSED اعلام نمی‌کند
sed 's/CLOSED (۲۰\/۲۰)/PARTIAL/' "$DOC12" > "$TMP/doc12.partial.md"
reject N9 "سند ۱۲ هنوز PARTIAL است" "DOC12-CLOSED" CC122_DOC12="$TMP/doc12.partial.md"

# N10 سند بازبینی بدون به‌روزرسانی بسته شدن
grep -vE 'CC.12.2.*CLOSED' "$REV12" > "$TMP/rev12.old.md"
reject N10 "به‌روزرسانی CC‑12‑2 در سند بازبینی نیست" "REVIEW12" CC122_REV12="$TMP/rev12.old.md"

# N11 قانون اساسی بدون D‑35
grep -vE '^\| \*\*D.35\*\*' "$CONST" > "$TMP/const.nod35.md"
reject N11 "تصمیم D‑35 از قانون اساسی حذف شد" "CONST-D35" CC122_CONST="$TMP/const.nod35.md"

# N12 آزمون پایه با یک شکست
# عدد آزمون‌ها با هر ردیف بالا می‌رود؛ همان عددِ واقعی را «یک شکست» می‌کنیم
sed -E 's/^SUMMARY pass=([0-9]+) fail=0$/SUMMARY pass=\1 fail=1/' "$TESTS" > "$TMP/tests.fail.log"
reject N12 "آزمون پایه ۸۷/۱ شده" "BASE-TESTS" CC122_TESTS="$TMP/tests.fail.log"

# N13 فهرست مجاز تنگ‌تر از تغییر واقعی
reject N13 "فهرست مجاز D‑35 فقط server/tenancy.js است" "PRODUCT-SCOPE" CC122_ALLOW="server/tenancy.js"

# N14 پایهٔ ممیزی ناموجود
reject N14 "پایهٔ ممیزی در مخزن نیست" "BASE-MISSING" CC122_BASE="deadbeefdeadbeef"

echo "" | tee -a "$LOG"
echo "SUMMARY pass=$PASS fail=$FAIL" | tee -a "$LOG"
if [ "$FAIL" -eq 0 ]; then
  echo "NEGATIVE-OK" | tee -a "$LOG"
else
  echo "NEGATIVE-FAIL" | tee -a "$LOG"
fi
cp "$LOG" "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
