#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC-12-1 — «شاهد دست‌کاری‌شده نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc12-1-negative.sh
# خروجی: docs/cloud/reports/evidence/cc12-1-negative.txt  ⇒  NEGATIVE pass=N fail=0
#
# هر مورد، یک نسخهٔ دست‌کاری‌شده از شاهد خام می‌سازد و دروازه را روی آن اجرا می‌کند؛
# دروازه باید **رد** کند (exit ≠ 0 و پیام CC12-1-FAIL). همچنین شاهد سالم باید PASS بگیرد (کنترل مثبت).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

EV=docs/cloud/reports/evidence/mission-12-cc1-rls-repro.txt
GATE=docs/cloud/reports/evidence/gen-cc12-1-evidence.sh
OUT=docs/cloud/reports/evidence/cc12-1-negative.txt

[ -f "$EV" ] || { echo "BLOCKED: evidence missing: $EV" >&2; exit 3; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
LOG=$TMP/result.txt
: > "$LOG"

expect_fail() { # $1=id  $2=desc  $3=mutated file
  local id="$1" desc="$2" file="$3" rc err
  err=$(CC12_EVIDENCE="$file" CC12_GATE_OUT=/dev/null bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && echo "$err" | grep -q 'CC12-1-FAIL'; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → exit=$rc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED tampered evidence: $desc  → exit=$rc" | tee -a "$LOG"
  fi
}

# ---------- کنترل مثبت: شاهد سالم باید قبول شود ----------
POSRC=0
POSOUT=$(CC12_EVIDENCE="$EV" CC12_GATE_OUT="$TMP/pos-gate.txt" bash "$GATE" 2>&1) || POSRC=$?
if [ "$POSRC" -eq 0 ] && grep -qF 'CC12-1-OK' "$TMP/pos-gate.txt"; then
  PASS=$((PASS+1)); echo "PASS  P0  pristine evidence is accepted (control positive)" | tee -a "$LOG"
else
  FAIL=$((FAIL+1)); echo "FAIL  P0  pristine evidence rejected — gate is broken  → exit=$POSRC" | tee -a "$LOG"
  echo "$POSOUT" | tee -a "$LOG"
fi

# ---------- N1: کد خروج ادعایی ۱ ----------
sed 's/^EXIT=0$/EXIT=1/' "$EV" > "$TMP/n1.txt"
expect_fail N1 "declared EXIT=1" "$TMP/n1.txt"

# ---------- N2: شمارش FAIL ادعایی ----------
sed 's/TOTAL 14 · FAIL 0/TOTAL 14 · FAIL 1/' "$EV" > "$TMP/n2.txt"
expect_fail N2 "declared FAIL 1 while body has none" "$TMP/n2.txt"

# ---------- N3: حذف یک خط PASS از بدنه ----------
grep -v '^PASS  N7 ' "$EV" > "$TMP/n3.txt"
expect_fail N3 "one PASS line removed from body (13 ≠ 14)" "$TMP/n3.txt"

# ---------- N4: هش ابزار آزمون جعلی ----------
sed 's/^# sha256(rls-execution-test.cjs): .*/# sha256(rls-execution-test.cjs): 0000000000000000000000000000000000000000000000000000000000000000/' "$EV" > "$TMP/n4.txt"
expect_fail N4 "harness .cjs hash replaced with zeros" "$TMP/n4.txt"

# ---------- N5: اثر انگشت کد محصول جعلی ----------
sed 's/^# product_tree_sha256: .*/# product_tree_sha256: 1111111111111111111111111111111111111111111111111111111111111111/' "$EV" > "$TMP/n5.txt"
expect_fail N5 "product tree fingerprint replaced" "$TMP/n5.txt"

# ---------- N6: نسخهٔ PostgreSQL ناسازگار با سرور واقعی ----------
sed 's/^# postgres version: .*/# postgres version: 9.6.0/' "$EV" > "$TMP/n6.txt"
expect_fail N6 "header postgres version contradicts the live server" "$TMP/n6.txt"

# ---------- N7: خطوط PASS جعلی (بدنهٔ تکراری بدون تغییر TOTAL) ----------
{ cat "$EV"; echo 'PASS  N99  fake assertion injected'; } > "$TMP/n7.txt"
expect_fail N7 "extra PASS line injected (15 ≠ 14)" "$TMP/n7.txt"

{
  echo "# آزمون منفی دروازهٔ CC-12-1"
  echo "# تولید: bash docs/cloud/reports/evidence/verify-cc12-1-negative.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# شاهد خام: $EV"
  echo
  cat "$LOG"
  echo
  echo "TOTAL $((PASS+FAIL)) · pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"

echo "→ $OUT (pass=$PASS fail=$FAIL)"
[ "$FAIL" -eq 0 ] || { echo "NEGATIVE-FAIL: gate accepted tampered evidence" >&2; exit 1; }
echo "NEGATIVE-OK"
