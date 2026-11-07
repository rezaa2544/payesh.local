#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC‑11 — «ادعای بی‌شاهد، ارجاع مرده یا سند ناسازگار نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc11-negative.sh
# خروجی: docs/cloud/reports/evidence/cc11-negative.txt ⇒ NEGATIVE-OK (pass=N fail=0)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-cc11-evidence.sh
MAN=$D/cc11-required-labels.txt
DOC=docs/cloud/11-gap-report.md
OUT=$D/cc11-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

node "$D/drill-11-claims.cjs" > "$TMP/drill.real" 2>&1 || true
cp "$DOC" "$TMP/doc.bak"

reject_ok() { # $1=id $2=desc $3=expected-reason-substr, rest = env pairs
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env "$@" CC11_OUT=/dev/null CC11_RAW_DIR="$TMP" CC11_MANIFEST="$MAN" CC11_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC11-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → $(printf '%s' "$err" | head -1 | cut -c1-88)" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED/mis-reason: $desc  → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)" | tee -a "$LOG"
  fi
}

expect_ok() {
  local id="$1" desc="$2" rc
  CC11_OUT="$TMP/pos.txt" CC11_RAW_DIR="$TMP" CC11_MANIFEST="$MAN" CC11_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -qF 'CC11-OK' "$TMP/pos.txt"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate accepted clean evidence (control positive): $desc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate rejected CLEAN evidence — gate is broken: $desc → exit=$rc" | tee -a "$LOG"
  fi
}
fake() { printf 'cat %s\n' "$1"; }

reject_doc_ok() { # $1=id $2=desc $3=expected-reason $4=doc-path
  local id="$1" desc="$2" want="$3" docp="$4"
  local err rc
  err=$(CC11_OUT=/dev/null CC11_RAW_DIR="$TMP" CC11_MANIFEST="$MAN" CC11_FAILDIR="$TMP" CC11_DOC="$docp" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC11-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → $(printf '%s' "$err" | head -1 | cut -c1-88)" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED/mis-reason: $desc  → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)" | tee -a "$LOG"
  fi
}


expect_ok P0 "اجرای سالم: ۷۳ ادعا متصل + سند ۵/۵ + پین ممیزی"

# ---------- N1: حذف یک برچسب لازم ----------
LABEL=$(head -1 "$MAN")
python3 - "$TMP/drill.real" "$TMP/n1.txt" "$LABEL" <<'PYEOF'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding='utf-8').read().splitlines()
kept = [l for l in lines if not l.startswith('✓ ' + label)]
assert len(kept) < len(lines), 'label not found'
kept = [l.replace('SUMMARY pass=48 fail=0 total=48', 'SUMMARY pass=47 fail=0 total=48') for l in kept]
open(dst, 'w', encoding='utf-8').write('\n'.join(kept) + '\n')
PYEOF
reject_ok N1 "یک برچسب لازم از بدنهٔ تمرین حذف شد" "LABEL-MISSING" CC11_DRILL_CMD="$(fake "$TMP/n1.txt")"

# ---------- N2: برچسب با ✗ ----------
python3 - "$TMP/drill.real" "$TMP/n2.txt" "$LABEL" <<'PYEOF'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
out, hit = [], False
for line in open(src, encoding='utf-8').read().splitlines():
    if not hit and line.startswith('✓ ' + label + ' '):
        out.append('✗ ' + label + line[len('✓ ' + label):]); hit = True
    else:
        out.append(line)
assert hit, 'label not found'
open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PYEOF
reject_ok N2 "یک ادعا با علامت شکست (✗)" "DRILL-CROSS" CC11_DRILL_CMD="$(fake "$TMP/n2.txt")"

# ---------- N3: SUMMARY جعلی ----------
sed 's/^SUMMARY pass=48 fail=0 total=48$/SUMMARY pass=47 fail=0 total=48/' "$TMP/drill.real" > "$TMP/n3.txt"
reject_ok N3 "SUMMARY ادعایی با شمارش بدنه نمی‌خواند" "SUMMARY-MISMATCH" CC11_DRILL_CMD="$(fake "$TMP/n3.txt")"

# ---------- N4: یک ادعا بی‌اتصال ----------
sed 's/^CLAIMS rows=73 attached=73 /CLAIMS rows=73 attached=72 /' "$TMP/drill.real" > "$TMP/n4.txt"
reject_ok N4 "یک ادعا اتصال ندارد (۷۳ → ۷۲) ولی گزارش سبز می‌گوید" "CLAIMS" CC11_DRILL_CMD="$(fake "$TMP/n4.txt")"

# ---------- N5: ارجاع مرده ----------
sed 's/^CLAIMS \(.*\) broken=0$/CLAIMS \1 broken=1/' "$TMP/drill.real" > "$TMP/n5.txt"
reject_ok N5 "یک ارجاع file:line مرده است" "CLAIMS" CC11_DRILL_CMD="$(fake "$TMP/n5.txt")"

# ---------- N6: درصد تطابق جابه‌جا ----------
sed 's/conformance=35\.6%/conformance=40.0%/' "$TMP/drill.real" > "$TMP/n6.txt"
reject_ok N6 "درصد تطابق با فرمول PASS÷۷۳ نمی‌خواند" "VERDICTS" CC11_DRILL_CMD="$(fake "$TMP/n6.txt")"

# ---------- N7: رانش ارجاع کم‌شماری‌شده ----------
sed 's/^DRIFT rows=11 corrections=9 accepted=2/DRIFT rows=10 corrections=9 accepted=1/' "$TMP/drill.real" > "$TMP/n7.txt"
reject_ok N7 "رانش ارجاع ناقص گزارش شده (۱۱ → ۱۰)" "DRIFT" CC11_DRILL_CMD="$(fake "$TMP/n7.txt")"

# ---------- N8: نقض ادعای «نبود» ----------
sed 's/^ABSENCE cipher=0 /ABSENCE cipher=1 /' "$TMP/drill.real" > "$TMP/n8.txt"
reject_ok N8 "رمزنگاری سکون پیدا شد ولی ادعای صفر مانده" "ABSENCE" CC11_DRILL_CMD="$(fake "$TMP/n8.txt")"

# ---------- N9: پایهٔ ممیزی ناموجود ----------
reject_ok N9 "پایهٔ ممیزی ناموجود ⇒ تعمیم نتیجه به HEAD بی‌اعتبار" "BASE-MISSING" CC11_BASE=0000000

# ---------- N10: حذف یک ردیف AC ----------
python3 - "$TMP/doc.ac.md" <<'PYEOF'
import re, sys, shutil
shutil.copy('docs/cloud/11-gap-report.md', sys.argv[1])
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s2 = re.sub(r'^\| AC\u20115 \| .*\n', '', s, flags=re.M)
assert s2 != s, 'AC-5 row not found'
open(p, 'w', encoding='utf-8').write(s2)
PYEOF
reject_doc_ok N10 "یک ردیف معیار از ماتریس سند حذف شد (۵ ← ۴)" "AC-COUNT" "$TMP/doc.ac.md" 

# ---------- N11: حذف بند دور بستن ----------
python3 - "$TMP/doc.sec6.md" <<'PYEOF'
import sys, shutil
shutil.copy('docs/cloud/11-gap-report.md', sys.argv[1])
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s2 = s.replace('## ۶. دور بستن', '## ۶-حذف‌شده. دور بستن')
assert s2 != s
open(p, 'w', encoding='utf-8').write(s2)
PYEOF
reject_doc_ok N11 "بند §۶ سند ۱۱ حذف/بی‌عنوان شد" "DOC-CLOSURE" "$TMP/doc.sec6.md"

# ---------- N12: حذف ثبت تصحیح D‑10 ----------
sed 's/C‑11‑۱/C-REMOVED/g' "$TMP/doc.bak" > "$TMP/doc.c11.md"
reject_doc_ok N12 "ثبت تصحیح ادعای نادرست (C‑11‑۱) از سند حذف شد" "CORRECTION-D10" "$TMP/doc.c11.md"

# ---------- N13: درصد سند جابه‌جا ----------
sed 's/۳۵٫۶/۳۵٫۰/g' "$TMP/doc.bak" > "$TMP/doc.pct.md"
reject_doc_ok N13 "درصد اعلامی سند با فرمول نمی‌خواند" "CONFORMANCE" "$TMP/doc.pct.md"

# ---------- حکم ----------
{
  echo "# آزمون منفی دروازهٔ CC‑11 — ادعای بی‌شاهد/ارجاع مرده/سند ناسازگار"
  echo "generated_by: docs/cloud/reports/evidence/verify-cc11-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  cat "$LOG"
  echo
  echo "SUMMARY pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -ge 14 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"
tail -3 "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
