#!/usr/bin/env bash
# آزمون منفی دروازهٔ فاز ۳ — «صف باز، سند ناهم‌تراز یا شاهد ناقص نباید READY بگیرد»
# اجرا: bash docs/cloud/reports/evidence/verify-phase3-gate-negative.sh
# خروجی: docs/cloud/reports/evidence/phase3-gate-negative.txt ⇒ NEGATIVE-OK (pass=N fail=0)
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-phase3-gate.sh
OUT=$D/phase3-gate-negative.txt
CONST=docs/00-PAYESH-CLOUD-CONSTITUTION.md
SNAP=$D/queue-state-snapshot.txt
REV12=docs/cloud/reports/REVIEW-12-CONDITIONS.md
DOC04=docs/cloud/04-capacity-and-availability.md
DOC04B=docs/cloud/04b-plan-caps-usage-model.md
DOC12=docs/cloud/12-multitenant-architecture.md

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt; : > "$LOG"
PASS=0; FAIL=0

pos() { PASS=$((PASS+1)); echo "PASS  $1  $2" | tee -a "$LOG"; }
neg() { FAIL=$((FAIL+1)); echo "FAIL  $1  $2" | tee -a "$LOG"; }

reject() { # id desc expected-reason env...
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env "$@" P3_OUT=/dev/null P3_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'PHASE3-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    pos "$id" "رد شد: $desc → $(printf '%s' "$err" | head -1 | cut -c1-82)"
  else
    neg "$id" "پذیرفته شد/دلیل اشتباه: $desc → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)"
  fi
}

# کنترل مثبت
if P3_OUT="$TMP/pos.txt" P3_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1 && grep -qF 'PHASE3-GATE-READY' "$TMP/pos.txt"; then
  pos P0 "شاهد سالم پذیرفته شد (کنترل مثبت)"
else
  neg P0 "شاهد سالم رد شد — دروازه معیوب است"
fi

# N1 صف باز
sed 's/^open_rows: 0$/open_rows: 1/' "$SNAP" > "$TMP/snap.open.txt"
reject N1 "صف یک ردیف باز دارد" "QUEUE-OPEN" P3_SNAPSHOT="$TMP/snap.open.txt"

# N2 عکس صف بدون ردیف Done
grep -v '^row ' "$SNAP" > "$TMP/snap.norows.txt"
reject N2 "عکس صف هیچ ردیف Done ندارد" "QUEUE-SNAPSHOT" P3_SNAPSHOT="$TMP/snap.norows.txt"

# N3 قانون اساسی کهنه (Review)
sed 's/| ۰۴‑ب سقف پلن و مصرف | \*\*Done (۹\/۹)/| ۰۴‑ب سقف پلن و مصرف | **Review (۹\/۹)/' "$CONST" > "$TMP/const.stale.md"
reject N3 "وضعیت ۰۴‑ب به Review برگشت (سند کهنه)" "CONST-STALE" P3_CONST="$TMP/const.stale.md"

# N4 D‑34 حذف
grep -v '^| \*\*D‑34\*\*' "$CONST" > "$TMP/const.nod34.md"
reject N4 "تصمیم D‑34 (هم‌ترازی) حذف شد" "CONST-D34" P3_CONST="$TMP/const.nod34.md"

# N5 AC بدون ✅ در سند ۰۴
sed 's/^| AC‑13 | اهداف ظرفیت با تصمیم مالک (O‑06\/D‑30) پذیرفته شده‌اند | §۲ سرصفحه | ✅ |/| AC‑13 | اهداف ظرفیت با تصمیم مالک پذیرفته شده‌اند | §۲ | — |/' "$DOC04" > "$TMP/doc04.notick.md"
reject N5 "یک AC سند ۰۴ تأییدیه ندارد" "PHASE0-04" P3_DOC04="$TMP/doc04.notick.md"

# N6 حذف تصمیم D‑33 از سند ۰۴‑ب (override)
grep -v 'D‑33' "$DOC04B" > "$TMP/doc04b.nod33.md"
reject N6 "تصمیم D‑33 از سند ۰۴‑ب حذف شد" "PHASE0-04B" P3_DOC04B="$TMP/doc04b.nod33.md"

# N7 CC‑12‑2 به‌دروغ CLOSED در سند ۱۲ (دروازهٔ تودرتو CC12 هم باید بگیرد)
sed 's/| \*\*CC‑12‑2\*\*.*$/| **CC‑12‑2** | اجرای RLS از مسیر محصول | **CLOSED** | ادعای بی‌شاهد |/' "$DOC12" > "$TMP/doc12.cc2.md"
reject N7 "شرط باز CC‑12‑2 به‌دروغ CLOSED شد" "PHASE2-CC12" P3_DOC12="$TMP/doc12.cc2.md"

# N8 سند بازبینی بدون PARTIAL
sed 's/PARTIAL/CLOSED/g' "$REV12" > "$TMP/rev12.nopartial.md"
reject N8 "سند بازبینی دیگر PARTIAL ندارد" "PHASE2-CC12-2" P3_REV12="$TMP/rev12.nopartial.md"

# N9 بخش «وضعیت اجرایی دروازهٔ فاز ۳» حذف
sed 's/^### دروازهٔ فاز ۳ — وضعیت اجرایی (D‑34)$/### (حذف‌شده)/' "$CONST" > "$TMP/const.nogate.md"
reject N9 "بخش وضعیت اجرایی دروازه حذف شد" "CONST-GATEBLOCK" P3_CONST="$TMP/const.nogate.md"

# N10 مانع F‑06 از سند حذف
sed 's/F‑06/F-XX/g' "$CONST" > "$TMP/const.nof06.md"
reject N10 "مانع F‑06 از سند حذف شد" "CONST-RESIDUAL" P3_CONST="$TMP/const.nof06.md"

# N11 خط وضعیت، آمادگی دروازه را اعلام نمی‌کند
sed 's/دروازهٔ فاز ۳: پیش‌نیاز کامل/دروازهٔ فاز ۳: نامعلوم/' "$CONST" > "$TMP/const.nostatus.md"
reject N11 "خط وضعیت ادعای آمادگی نمی‌کند" "CONST-STATUS" P3_CONST="$TMP/const.nostatus.md"

# N12 پایهٔ ممیزی ناموجود
reject N12 "پایهٔ ممیزی ناموجود" "BASE-MISSING" P3_BASE=0000000

{
  echo "# آزمون منفی دروازهٔ فاز ۳"
  echo "generated_by: docs/cloud/reports/evidence/verify-phase3-gate-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  cat "$LOG"
  echo
  echo "SUMMARY pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -ge 13 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"
tail -3 "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
