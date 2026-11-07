#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC‑15 — «شاهد ناقص/جعلی/کهنه نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc15-negative.sh
# خروجی: docs/cloud/reports/evidence/cc15-negative.txt ⇒ NEGATIVE-OK (pass=N fail=0)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-cc15-evidence.sh
MAN=$D/cc15-required-labels.txt
DOC=docs/cloud/15-backup-recovery.md
EV=$D/mission-15-backup-probe.txt
OUT=$D/cc15-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

node --experimental-sqlite --disable-warning=ExperimentalWarning "$D/drill-15-recovery.cjs" > "$TMP/drill.real" 2>&1 || true
cp "$DOC" "$TMP/doc.bak"
cp "$EV" "$TMP/ev.bak"

reject_ok() { # $1=id $2=desc $3=expected-reason-substr, then env pairs
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env "$@" CC15_OUT=/dev/null CC15_RAW_DIR="$TMP" CC15_MANIFEST="$MAN" CC15_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC15-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → $(printf '%s' "$err" | head -1 | cut -c1-88)" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED/mis-reason: $desc  → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)" | tee -a "$LOG"
  fi
  cp "$TMP/doc.bak" "$DOC"; cp "$TMP/ev.bak" "$EV"
}

expect_ok() {
  local id="$1" desc="$2" rc
  CC15_OUT="$TMP/pos.txt" CC15_RAW_DIR="$TMP" CC15_MANIFEST="$MAN" CC15_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -qF 'CC15-OK' "$TMP/pos.txt"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate accepted clean evidence (control positive): $desc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate rejected CLEAN evidence — gate is broken: $desc → exit=$rc" | tee -a "$LOG"
  fi
}

fake() { printf 'cat %s\n' "$1"; }

expect_ok P0 "اجرای سالم: تمرین ۳۳/۳۳ + شاهد رفتار امروز تازه + Manifest کامل"

# ---------- N1: حذف یک برچسب لازم ----------
LABEL=$(head -1 "$MAN")
python3 - "$TMP/drill.real" "$TMP/n1.txt" "$LABEL" <<'PYEOF'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding='utf-8').read().splitlines()
kept = [l for l in lines if not l.startswith('✓ ' + label)]
kept = [l.replace('SUMMARY pass=33 fail=0 total=33', 'SUMMARY pass=32 fail=0 total=33') for l in kept]
assert len(kept) < len(lines), 'label not found'
open(dst, 'w', encoding='utf-8').write('\n'.join(kept) + '\n')
PYEOF
reject_ok N1 "یک برچسب لازم از بدنهٔ تمرین حذف شد" "LABEL-MISSING" CC15_DRILL_CMD="$(fake "$TMP/n1.txt")"

# ---------- N2: برچسب با ✗ ----------
sed "s/^✓ $LABEL /✗ $LABEL /" "$TMP/drill.real" > "$TMP/n2.txt"
reject_ok N2 "برچسب با علامت شکست (✗)" "DRILL-CROSS" CC15_DRILL_CMD="$(fake "$TMP/n2.txt")"

# ---------- N3: SUMMARY جعلی ----------
sed 's/^SUMMARY pass=33 fail=0 total=33$/SUMMARY pass=32 fail=0 total=33/' "$TMP/drill.real" > "$TMP/n3.txt"
reject_ok N3 "SUMMARY ادعایی با شمارش بدنه نمی‌خواند" "SUMMARY-MISMATCH" CC15_DRILL_CMD="$(fake "$TMP/n3.txt")"

# ---------- N4: بکاپ با صفر رکورد ----------
sed -E 's/(^BACKUP_RUN .*records=)[0-9]+/\10/' "$TMP/drill.real" > "$TMP/n4.txt"
reject_ok N4 "گزارش بکاپ با تعداد رکورد صفر" "BACKUP-RECORDS" CC15_DRILL_CMD="$(fake "$TMP/n4.txt")"

# ---------- N5: شمارش قبل/بعد نمی‌خواند ----------
python3 - "$TMP/drill.real" "$TMP/n5.txt" <<'PYEOF'
import sys, json, re
src, dst = sys.argv[1], sys.argv[2]
out = []
for l in open(src, encoding='utf-8'):
    if l.startswith('COUNTS_AFTER='):
        d = json.loads(l.split('=', 1)[1].strip())
        d['grades'] = d.get('grades', 0) - 1
        out.append('COUNTS_AFTER=' + json.dumps(d, separators=(',', ':')) + '\n')
    else:
        out.append(l)
open(dst, 'w', encoding='utf-8').write(''.join(out))
PYEOF
reject_ok N5 "شمارش پس از بازیابی با قبل نمی‌خواند (اختلاف داده)" "COUNTS-DIFF" CC15_DRILL_CMD="$(fake "$TMP/n5.txt")"

# ---------- N6: زمان ثبت‌نشده (سنجهٔ مرده) ----------
sed -E 's/(^BACKUP_RUN .*)total_ms=[0-9]+/\1/' "$TMP/drill.real" > "$TMP/n6.txt"
reject_ok N6 "گزارش بدون زمان اندازه‌گیری‌شده (سنجهٔ مرده)" "BACKUP-DURATION" CC15_DRILL_CMD="$(fake "$TMP/n6.txt")"

# ---------- N7: پایهٔ ممیزی ناموجود ----------
reject_ok N7 "پایهٔ ممیزی ناموجود ⇒ «۰ فایل تغییر» جعلی نباید PASS بگیرد" "BASE-MISSING" CC15_BASE=0000000

# ---------- N8: شاهد رفتار امروز کهنه ----------
mkdir -p "$TMP/rt"
REPO=$(pwd)
{
  echo '#!/usr/bin/env bash'
  echo "cat > \"$REPO/$EV\" <<'EOF'"
  echo "head: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  echo "EXPECTATIONS=ALL-MET"
  echo "exit=0"
  echo "PRODUCT-DIFF=0"
  echo "EOF"
} > "$TMP/rt/gen-stale.sh"
reject_ok N8 "شاهد رفتار امروز کهنه (head=deadbeef)" "RUNTIME-STALE" CC15_RUNTIME_CMD="bash $TMP/rt/gen-stale.sh"

# ---------- N9: حذف یک ردیف AC از سند ----------
python3 - "$DOC" <<'PYEOF'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s2 = re.sub(r'^\| \*\*AC\u201112\*\* .*\n', '', s, flags=re.M)
assert s2 != s, 'AC-12 row not found'
open(p, 'w', encoding='utf-8').write(s2)
PYEOF
reject_ok N9 "یک ردیف معیار از ماتریس سند حذف شد (۱۲ ← ۱۱)" "AC-COUNT"

# ---------- N10: مصرف‌کنندهٔ ورود جعلی ----------
sed -E 's/"login":200/"login":500/' "$TMP/drill.real" > "$TMP/n10.txt"
reject_ok N10 "مصرف‌کنندهٔ ورود پس از بازیابی موفق نبوده (login≠200)" "CONSUMER-LOGIN" CC15_DRILL_CMD="$(fake "$TMP/n10.txt")"

# ---------- N11: امضای مانیفست ناقص ----------
sed -E 's/^MANIFEST_SIG_BYTES=[0-9]+$/MANIFEST_SIG_BYTES=32/' "$TMP/drill.real" > "$TMP/n11.txt"
reject_ok N11 "امضای مانیفست کامل نیست (۳۲ بایت به‌جای ۶۴)" "MANIFEST-SIG" CC15_DRILL_CMD="$(fake "$TMP/n11.txt")"

# ---------- حکم ----------
{
  echo "# آزمون منفی دروازهٔ CC‑15 — شاهد ناقص/جعلی/کهنه/بی‌زمان"
  echo "generated_by: docs/cloud/reports/evidence/verify-cc15-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  cat "$LOG"
  echo
  echo "SUMMARY pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -ge 12 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"
tail -3 "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
