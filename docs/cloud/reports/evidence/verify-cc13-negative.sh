#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC-13-1..4 — «شاهد ناقص/جعلی نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc13-negative.sh
# خروجی: docs/cloud/reports/evidence/cc13-negative.txt  ⇒  NEGATIVE-OK (pass=N fail=0)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

GATE=docs/cloud/reports/evidence/gen-cc13-evidence.sh
MAN=docs/cloud/reports/evidence/cc13-required-labels.txt
OUT=docs/cloud/reports/evidence/cc13-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

# خروجی واقعی هر دو نمونه را یک بار می‌گیریم تا از آن نسخه‌های دست‌کاری‌شده بسازیم
node prototype/slice-18/tests/run.js > "$TMP/s18.real" 2>&1 || true
node prototype/slice-20b/tests/run.js > "$TMP/s20b.real" 2>&1 || true

expect_fail() { # $1=id  $2=desc  $3=s18 runner path  $4=s20b runner path (خالی = واقعی)  $5=manifest
  local id="$1" desc="$2" r18="$3" r20b="${4:-node prototype/slice-20b/tests/run.js}" man="${5:-$MAN}" rc err
  err=$(CC13_S18_CMD="bash $r18" CC13_S20B_CMD="$r20b" CC13_OUT=/dev/null \
        CC13_RAW_DIR="$TMP" CC13_MANIFEST="$man" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && echo "$err" | grep -q 'CC13-FAIL'; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → exit=$rc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED invalid evidence: $desc  → exit=$rc" | tee -a "$LOG"
  fi
}

expect_ok() { # $1=id  $2=desc  $3=s18 runner  $4=s20b runner
  local id="$1" desc="$2" r18="$3" r20b="$4" rc
  CC13_S18_CMD="bash $r18" CC13_S20B_CMD="bash $r20b" CC13_OUT="$TMP/pos-gate.txt" \
    CC13_RAW_DIR="$TMP" CC13_MANIFEST="$MAN" bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -qF 'CC13-OK' "$TMP/pos-gate.txt"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate accepted clean evidence (control positive): $desc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate rejected CLEAN evidence — gate is broken: $desc  → exit=$rc" | tee -a "$LOG"
  fi
}

# ---------- کنترل مثبت ----------
printf 'node prototype/slice-18/tests/run.js\n' > "$TMP/real18.sh"
printf 'node prototype/slice-20b/tests/run.js\n' > "$TMP/real20b.sh"
expect_ok P0 "خروجی واقعی هر دو نمونه" "$TMP/real18.sh" "$TMP/real20b.sh"

# ---------- N1: حذف یک برچسب لازم ----------
LABEL=$(awk -F'\t' '$2=="s18"{print $3; exit}' "$MAN")
python3 - "$TMP/s18.real" "$TMP/n1.real" "$LABEL" <<'PY'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [l for l in open(src, encoding='utf-8').read().splitlines() if l != f'✓ {label}']
open(dst, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
PY
printf 'cat %s\n' "$TMP/n1.real" > "$TMP/n1.sh"
expect_fail N1 "یک برچسب لازم از خروجی حذف شد" "$TMP/n1.sh"

# ---------- N2: برچسب لازم با ✗ ----------
python3 - "$TMP/s18.real" "$TMP/n2.real" "$LABEL" <<'PY'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
out = []
for l in open(src, encoding='utf-8').read().splitlines():
    out.append(f'✗ {label}' if l == f'✓ {label}' else l)
open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
printf 'cat %s\n' "$TMP/n2.real" > "$TMP/n2.sh"
expect_fail N2 "برچسب لازم با علامت شکست" "$TMP/n2.sh"

# ---------- N3: SUMMARY دست‌کاری‌شده (گذر اعلامی ≠ بدنه) ----------
sed 's/SUMMARY pass=[0-9]* fail=[0-9]* total=[0-9]*/SUMMARY pass=48 fail=0 total=49/' "$TMP/s18.real" > "$TMP/n3.real"
printf 'cat %s\n' "$TMP/n3.real" > "$TMP/n3.sh"
expect_fail N3 "SUMMARY ادعایی با بدنه نمی‌خواند" "$TMP/n3.sh"

# ---------- N4: کد خروج غیرصفر ----------
printf 'cat %s\nexit 1\n' "$TMP/s18.real" > "$TMP/n4.sh"
expect_fail N4 "نمونه با کد خروج ۱ تمام شد" "$TMP/n4.sh"

# ---------- N5: manifest معیوب (برچسب ناموجود) ----------
cp "$MAN" "$TMP/man-bad.txt"
printf 'CC-13-9\ts18\tبرچسب ساختگی که وجود ندارد\n' >> "$TMP/man-bad.txt"
expect_fail N5 "manifest برچسب ناموجود طلب می‌کند" "$TMP/real18.sh" "" "$TMP/man-bad.txt"

# ---------- N6: manifest غایب ----------
expect_fail N6 "manifest وجود ندارد" "$TMP/real18.sh" "" "$TMP/man-missing.txt"

{
  echo "# آزمون منفی دروازهٔ CC-13-1..4"
  echo "# تولید: bash docs/cloud/reports/evidence/verify-cc13-negative.sh"
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
