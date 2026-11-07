#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC‑01B — «شاهد ناقص/جعلی/کهنه نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc01b-negative.sh
# خروجی: docs/cloud/reports/evidence/cc01b-negative.txt ⇒ NEGATIVE-OK (pass=N fail=0)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-cc01b-evidence.sh
MAN=$D/cc01b-required-labels.txt
DOC=docs/cloud/01b-school-plan-subscription.md
OUT=$D/cc01b-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

node --experimental-sqlite --disable-warning=ExperimentalWarning "$D/drill-01b-subscription-lifecycle.cjs" > "$TMP/drill.real" 2>&1 || true
cp "$DOC" "$TMP/doc.bak"

reject_ok() { # $1=id $2=desc $3=expected-reason-substr, then env pairs
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env "$@" CC01B_OUT=/dev/null CC01B_RAW_DIR="$TMP" CC01B_MANIFEST="$MAN" CC01B_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC01B-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → $(printf '%s' "$err" | head -1 | cut -c1-88)" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED/mis-reason: $desc  → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)" | tee -a "$LOG"
  fi
  cp "$TMP/doc.bak" "$DOC"
}

expect_ok() {
  local id="$1" desc="$2" rc
  CC01B_OUT="$TMP/pos.txt" CC01B_RAW_DIR="$TMP" CC01B_MANIFEST="$MAN" CC01B_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -qF 'CC01B-OK' "$TMP/pos.txt"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate accepted clean evidence (control positive): $desc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate rejected CLEAN evidence — gate is broken: $desc → exit=$rc" | tee -a "$LOG"
  fi
}

fake() { printf 'cat %s\n' "$1"; }

expect_ok P0 "اجرای سالم: تمرین ۴۰/۴۰ + پروب قیدها + Manifest کامل + سند ۱۲/۱۲"

# ---------- N1: حذف یک برچسب لازم ----------
LABEL=$(head -1 "$MAN")
python3 - "$TMP/drill.real" "$TMP/n1.txt" "$LABEL" <<'PYEOF'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding='utf-8').read().splitlines()
kept = [l for l in lines if not l.startswith('✓ ' + label)]
kept = [l.replace('SUMMARY pass=40 fail=0 total=40', 'SUMMARY pass=39 fail=0 total=40') for l in kept]
assert len(kept) < len(lines), 'label not found'
open(dst, 'w', encoding='utf-8').write('\n'.join(kept) + '\n')
PYEOF
reject_ok N1 "یک برچسب لازم از بدنهٔ تمرین حذف شد" "LABEL-MISSING" CC01B_DRILL_CMD="$(fake "$TMP/n1.txt")"

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
reject_ok N2 "برچسب با علامت شکست (✗)" "DRILL-CROSS" CC01B_DRILL_CMD="$(fake "$TMP/n2.txt")"

# ---------- N3: SUMMARY جعلی ----------
sed 's/^SUMMARY pass=40 fail=0 total=40$/SUMMARY pass=39 fail=0 total=40/' "$TMP/drill.real" > "$TMP/n3.txt"
reject_ok N3 "SUMMARY ادعایی با شمارش بدنه نمی‌خواند" "SUMMARY-MISMATCH" CC01B_DRILL_CMD="$(fake "$TMP/n3.txt")"

# ---------- N4: گذارهای مجاز ناقص ----------
sed -E 's/(^LIFECYCLE_RUN .*transitions_allowed=)[0-9]+/\111/' "$TMP/drill.real" > "$TMP/n4.txt"
reject_ok N4 "کل جدول گذارها آزموده نشده (۱۳ ← ۱۱)" "TRANSITIONS-ALLOWED" CC01B_DRILL_CMD="$(fake "$TMP/n4.txt")"

# ---------- N5: پیام‌های فارسی ناقص ----------
sed -E 's/(^LIFECYCLE_RUN .*msgs=)[0-9]+/\19/' "$TMP/drill.real" > "$TMP/n5.txt"
reject_ok N5 "کاتالوگ پیام‌ها ناقص است (۱۲ ← ۹)" "MESSAGES" CC01B_DRILL_CMD="$(fake "$TMP/n5.txt")"

# ---------- N6: سنجهٔ مرده (زمان) ----------
sed -E 's/(^LIFECYCLE_RUN .*)duration_ms=[0-9]+/\1/' "$TMP/drill.real" > "$TMP/n6.txt"
reject_ok N6 "گزارش بدون زمان اندازه‌گیری‌شده (سنجهٔ مرده)" "DURATION" CC01B_DRILL_CMD="$(fake "$TMP/n6.txt")"

# ---------- N7: پایهٔ ممیزی ناموجود ----------
reject_ok N7 "پایهٔ ممیزی ناموجود ⇒ «۰ فایل تغییر» جعلی نباید PASS بگیرد" "BASE-MISSING" CC01B_BASE=0000000

# ---------- N8: پروب بدون ردِ مورد انتظار ----------
grep -v '^\[ERR\]  N5b' "$D/cc01b-raw-probe.txt" > "$TMP/probe.n5b.txt"
reject_ok N8 "پروب قیدها ردِ «دو اشتراک جاری» را نشان نمی‌دهد" "PROBE-EXPECTED-REJECT" CC01B_PROBE_CMD="$(fake "$TMP/probe.n5b.txt")"

# ---------- N9: حذف یک ردیف AC از سند ----------
python3 - "$DOC" <<'PYEOF'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s2 = re.sub(r'^\| AC\u201112 \| .*\n', '', s, flags=re.M)
assert s2 != s, 'AC-12 row not found'
open(p, 'w', encoding='utf-8').write(s2)
PYEOF
reject_ok N9 "یک ردیف معیار از ماتریس سند حذف شد (۱۲ ← ۱۱)" "AC-COUNT"

# ---------- N10: جملهٔ «مانع بستن نیست» حذف شود ----------
python3 - "$DOC" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s2 = s.replace('هیچ‌کدام مانع بستن ۰۱‑ب نیست', 'موانع بسته‌شدن')
assert s2 != s, 'phrase not found'
open(p, 'w', encoding='utf-8').write(s2)
PYEOF
reject_ok N10 "سند دیگر صریح نمی‌گوید تصمیم‌های §۹ مانع بستن نیستند" "OPEN-DECISIONS"

# ---------- N11: هیچ رویداد گذاری ثبت نشده ----------
sed -E 's/^SUB_STATE status=[a-z]+ events=[0-9]+$/SUB_STATE status=active events=0/' "$TMP/drill.real" > "$TMP/n11.txt"
reject_ok N11 "هیچ subscription_event در تمرین ثبت نشده" "SUB-STATE-EVENTS" CC01B_DRILL_CMD="$(fake "$TMP/n11.txt")"

# ---------- N12: سقف‌های آزموده‌شده جابه‌جا ----------
sed -E 's/quota_cap=300\/250\/2048/quota_cap=0\/0\/0/' "$TMP/drill.real" > "$TMP/n12.txt"
reject_ok N12 "سقف‌های پلن در تمرین آزموده نشده‌اند" "QUOTA-CAP" CC01B_DRILL_CMD="$(fake "$TMP/n12.txt")"

# ---------- حکم ----------
{
  echo "# آزمون منفی دروازهٔ CC‑01B — شاهد ناقص/جعلی/کهنه/بی‌زمان"
  echo "generated_by: docs/cloud/reports/evidence/verify-cc01b-negative.sh"
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
