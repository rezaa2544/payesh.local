#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC-14-1..5 — «شاهد ناقص/جعلی نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc14-negative.sh
# خروجی: docs/cloud/reports/evidence/cc14-negative.txt  ⇒  NEGATIVE-OK (pass=N fail=0)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

GATE=docs/cloud/reports/evidence/gen-cc14-evidence.sh
MAN=docs/cloud/reports/evidence/cc14-required-labels.txt
OUT=docs/cloud/reports/evidence/cc14-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

node prototype/slice-19/tests/run.js > "$TMP/s19.real" 2>&1 || true

expect_fail() { # $1=id  $2=desc  $3=runner script  $4=manifest (اختیاری)
  local id="$1" desc="$2" run="$3" man="${4:-$MAN}" rc err
  err=$(CC14_S19_CMD="bash $run" CC14_OUT=/dev/null CC14_RAW_DIR="$TMP" CC14_MANIFEST="$man" \
        bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && echo "$err" | grep -q 'CC14-FAIL'; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → exit=$rc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED invalid evidence: $desc  → exit=$rc" | tee -a "$LOG"
  fi
}

# ---------- کنترل مثبت ----------
printf 'node prototype/slice-19/tests/run.js\n' > "$TMP/real.sh"
CC14_S19_CMD="bash $TMP/real.sh" CC14_OUT="$TMP/pos-gate.txt" CC14_RAW_DIR="$TMP" CC14_MANIFEST="$MAN" \
  bash "$GATE" >/dev/null 2>&1
if [ $? -eq 0 ] && grep -qF 'CC14-OK' "$TMP/pos-gate.txt"; then
  PASS=$((PASS+1)); echo "PASS  P0  gate accepted clean evidence (control positive)" | tee -a "$LOG"
else
  FAIL=$((FAIL+1)); echo "FAIL  P0  gate rejected CLEAN evidence — gate is broken" | tee -a "$LOG"
fi

LABEL=$(awk -F'\t' '$2=="s19"{print $3; exit}' "$MAN")

# ---------- N1: حذف یک برچسب لازم ----------
python3 - "$TMP/s19.real" "$TMP/n1.real" "$LABEL" <<'PY'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [l for l in open(src, encoding='utf-8').read().splitlines() if l != f'✓ {label}']
open(dst, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
PY
printf 'cat %s\n' "$TMP/n1.real" > "$TMP/n1.sh"
expect_fail N1 "یک برچسب لازم از خروجی حذف شد" "$TMP/n1.sh"

# ---------- N2: برچسب لازم با ✗ ----------
python3 - "$TMP/s19.real" "$TMP/n2.real" "$LABEL" <<'PY'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
out = [f'✗ {label}' if l == f'✓ {label}' else l for l in open(src, encoding='utf-8').read().splitlines()]
open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
printf 'cat %s\n' "$TMP/n2.real" > "$TMP/n2.sh"
expect_fail N2 "برچسب لازم با علامت شکست" "$TMP/n2.sh"

# ---------- N3: SUMMARY دست‌کاری‌شده ----------
sed 's/SUMMARY pass=[0-9]* fail=[0-9]* total=[0-9]*/SUMMARY pass=47 fail=0 total=48/' "$TMP/s19.real" > "$TMP/n3.real"
printf 'cat %s\n' "$TMP/n3.real" > "$TMP/n3.sh"
expect_fail N3 "SUMMARY ادعایی با بدنه نمی‌خواند" "$TMP/n3.sh"

# ---------- N4: کد خروج غیرصفر ----------
printf 'cat %s\nexit 1\n' "$TMP/s19.real" > "$TMP/n4.sh"
expect_fail N4 "نمونه با کد خروج ۱ تمام شد" "$TMP/n4.sh"

# ---------- N5: manifest با برچسب ناموجود ----------
cp "$MAN" "$TMP/man-bad.txt"
printf 'CC-14-9\ts19\tبرچسب ساختگی که وجود ندارد\n' >> "$TMP/man-bad.txt"
expect_fail N5 "manifest برچسب ناموجود طلب می‌کند" "$TMP/real.sh" "$TMP/man-bad.txt"

# ---------- N6: manifest غایب ----------
expect_fail N6 "manifest وجود ندارد" "$TMP/real.sh" "$TMP/man-missing.txt"

{
  echo "# آزمون منفی دروازهٔ CC-14-1..5"
  echo "# تولید: bash docs/cloud/reports/evidence/verify-cc14-negative.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# manifest: $MAN"
  echo
  cat "$LOG"
  echo
  echo "TOTAL $((PASS+FAIL)) · pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"

echo "→ $OUT (pass=$PASS fail=$FAIL)"
[ "$FAIL" -eq 0 ] || { echo "NEGATIVE-FAIL" >&2; exit 1; }
echo "NEGATIVE-OK"
