#!/usr/bin/env bash
# آزمون منفی دروازهٔ ۱۲‑ب — «شاهد ناقص/مرز شکسته نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc12b-negative.sh
# خروجی: docs/cloud/reports/evidence/cc12b-negative.txt ⇒ NEGATIVE-OK
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

GATE=docs/cloud/reports/evidence/gen-cc12b-evidence.sh
MAN=docs/cloud/reports/evidence/cc12b-required-labels.txt
PROBE=docs/cloud/reports/evidence/probe-12b-boundary.cjs
OUT=docs/cloud/reports/evidence/cc12b-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

node prototype/slice-20b/tests/run.js > "$TMP/s20b.real" 2>&1 || true

expect_fail() { # $1=id $2=desc $3=s20b cmd $4=policy $5=doc
  local id="$1" desc="$2" s20b="$3" pol="${4:-}" doc="${5:-}" rc err
  err=$(CC12B_S20B_CMD="$s20b" CC12B_PROBE_POLICY="$pol" CC12B_PROBE_DOC="$doc" \
        CC12B_OUT=/dev/null CC12B_RAW_DIR="$TMP" CC12B_MANIFEST="$MAN" \
        bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && echo "$err" | grep -q 'CC12B-FAIL'; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → exit=$rc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED invalid evidence: $desc  → exit=$rc" | tee -a "$LOG"
  fi
}

# ---------- کنترل مثبت ----------
printf 'node prototype/slice-20b/tests/run.js\n' > "$TMP/real.sh"
CC12B_S20B_CMD="bash $TMP/real.sh" CC12B_OUT="$TMP/pos.txt" CC12B_RAW_DIR="$TMP" CC12B_MANIFEST="$MAN" \
  bash "$GATE" >/dev/null 2>&1
if [ $? -eq 0 ] && grep -qF 'CC12B-OK' "$TMP/pos.txt"; then
  PASS=$((PASS+1)); echo "PASS  P0  gate accepted clean evidence (control positive)" | tee -a "$LOG"
else
  FAIL=$((FAIL+1)); echo "FAIL  P0  gate rejected CLEAN evidence — gate is broken" | tee -a "$LOG"
fi

LABEL=$(awk -F'\t' '$2=="s20b"{print $3; exit}' "$MAN")

# ---------- N1: حذف برچسب لازم ----------
python3 - "$TMP/s20b.real" "$TMP/n1.real" "$LABEL" <<'PY'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [l for l in open(src, encoding='utf-8').read().splitlines() if l != f'✓ {label}']
open(dst, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
PY
printf 'cat %s\n' "$TMP/n1.real" > "$TMP/n1.sh"
expect_fail N1 "یک برچسب لازم از خروجی ۲۰‑ب حذف شد" "bash $TMP/n1.sh"

# ---------- N2: برچسب با ✗ ----------
python3 - "$TMP/s20b.real" "$TMP/n2.real" "$LABEL" <<'PY'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
out = [f'✗ {label}' if l == f'✓ {label}' else l for l in open(src, encoding='utf-8').read().splitlines()]
open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
printf 'cat %s\n' "$TMP/n2.real" > "$TMP/n2.sh"
expect_fail N2 "برچسب لازم با علامت شکست" "bash $TMP/n2.sh"

# ---------- N3: SUMMARY ناهم‌خوان ----------
sed 's/SUMMARY pass=[0-9]* fail=[0-9]* total=[0-9]*/SUMMARY pass=70 fail=0 total=71/' "$TMP/s20b.real" > "$TMP/n3.real"
printf 'cat %s\n' "$TMP/n3.real" > "$TMP/n3.sh"
expect_fail N3 "SUMMARY ادعایی با بدنه نمی‌خواند" "bash $TMP/n3.sh"

# ---------- N4: نقش پلتفرمی قاچاقی در کد محصول ----------
cp server/policy.js "$TMP/policy-bad.js"
python3 - "$TMP/policy-bad.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace("const ROLES = ['manager',", "const ROLES = ['platform_support', 'manager',", 1)
open(p, 'w', encoding='utf-8').write(s)
PY
expect_fail N4 "نقش platform_support به ROLES محصول اضافه شد (default-deny شکست)" "bash $TMP/real.sh" "$TMP/policy-bad.js"

# ---------- N5: سند ۱۲‑ب فاقد یکی از بخش‌های D-20 ----------
cp docs/cloud/12b-owner-panel-boundaries.md "$TMP/doc-bad.md"
python3 - "$TMP/doc-bad.md" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace('| ۵ — سلامت فنی |', '| ۵ — بخش حذف‌شده |', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
expect_fail N5 "بخش «سلامت فنی» از جدول D-20 حذف شد" "bash $TMP/real.sh" "" "$TMP/doc-bad.md"

# ---------- N6: پروب بدون کد محصول ----------
expect_fail N6 "فایل policy محصول غایب است" "bash $TMP/real.sh" "$TMP/no-such-policy.js"

{
  echo "# آزمون منفی دروازهٔ ۱۲‑ب"
  echo "# تولید: bash docs/cloud/reports/evidence/verify-cc12b-negative.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo
  cat "$LOG"
  echo
  echo "TOTAL $((PASS+FAIL)) · pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"

echo "→ $OUT (pass=$PASS fail=$FAIL)"
[ "$FAIL" -eq 0 ] || { echo "NEGATIVE-FAIL" >&2; exit 1; }
echo "NEGATIVE-OK"
