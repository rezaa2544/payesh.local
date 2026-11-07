#!/usr/bin/env bash
# آزمون منفی دروازهٔ F‑01 — بازگشت رمز خام، باز شدن بکاپ برای غیرمدیر،
# لاگ رازدار، حذف باطل‌سازی نشست یا شاهد ناکافی نباید CLOSED بگیرد.
# اجرا: bash docs/cloud/reports/evidence/verify-f01-negative.sh
# خروجی: docs/cloud/reports/evidence/f01-negative.txt ⇒ F01-NEGATIVE-OK
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-f01-gate.sh
OUT=$D/f01-negative.txt
TESTS=$D/mission-05-tests-run.log

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt; : > "$LOG"
PASS=0; FAIL=0
pos() { PASS=$((PASS+1)); echo "PASS  $1  $2" | tee -a "$LOG"; }
neg() { FAIL=$((FAIL+1)); echo "FAIL  $1  $2" | tee -a "$LOG"; }

reject() { # id desc expected-reason env...
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env F01_OUT="$TMP/out.txt" F01_FAILDIR="$TMP" "$@" bash "$GATE" 2>&1 >/dev/null); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'F01-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    pos "$id" "رد شد: $desc → $(printf '%s' "$err" | head -1 | cut -c1-80)"
  else
    neg "$id" "پذیرفته شد/دلیل اشتباه: $desc → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)"
  fi
}

# کنترل مثبت
if F01_OUT="$TMP/pos.txt" F01_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1 && grep -qF 'F01-CLOSED' "$TMP/pos.txt"; then
  pos P0 "شاهد سالم پذیرفته شد (کنترل مثبت)"
else
  neg P0 "شاهد سالم رد شد — دروازه خودش خراب است"
fi

# N1 — بازگشت ذخیرهٔ رمز خام
cp server/auth.js "$TMP/n1.js"
printf '\nfunction leakPlain(u, pw) { return { password_plain: pw }; }\n' >> "$TMP/n1.js"
reject N1 "ذخیرهٔ رمز خام" "PLAINTEXT" "F01_AUTH=$TMP/n1.js"

# N2 — باز شدن بکاپ برای نقش‌های دیگر
cp server/index.js "$TMP/n2.js"
sed -i "s/BACKUP_ROLES = new Set(\['manager'\])/BACKUP_ROLES = new Set(['manager', 'teacher', 'counselor', 'guard'])/" "$TMP/n2.js"
reject N2 "بکاپ برای غیرمدیر" "BACKUP-SCOPE" "F01_INDEX=$TMP/n2.js"

# N3 — حذف پاک‌سازی راز از لاگ
cp server/db.js "$TMP/n3.js"
sed -i "s/delete out\[k\];/void k;/" "$TMP/n3.js"
reject N3 "لاگ رازدار" "AUDIT-SANITIZE" "F01_DB=$TMP/n3.js"

# N4 — حذف باطل‌سازی نشست
cp server/auth.js "$TMP/n4.js"
sed -i 's/^function revokeAll(store/function revokeAllDisabled(store/' "$TMP/n4.js"
reject N4 "نبود revoke-all" "REVOKE" "F01_AUTH=$TMP/n4.js"

# N5 — شاهد آزمون ناکافی
sed -e 's/^SUMMARY pass=91 fail=0$/SUMMARY pass=90 fail=0/' "$TESTS" > "$TMP/tests.txt"
reject N5 "شاهد آزمون کمتر از ۹۱" "TESTS-COUNT" "F01_TESTS=$TMP/tests.txt"

{
  echo "# آزمون منفی دروازهٔ F‑01"
  echo "generated_by: docs/cloud/reports/evidence/verify-f01-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "passed: $PASS"
  echo "failed: $FAIL"
  echo
  cat "$LOG"
  if [ "$FAIL" = "0" ]; then echo; echo "F01-NEGATIVE-OK checks=$PASS"; else echo; echo "F01-NEGATIVE-FAILED failed=$FAIL"; fi
} > "$OUT"

if [ "$FAIL" = "0" ]; then echo "→ $OUT"; echo "F01-NEGATIVE-OK checks=$PASS"; exit 0; fi
echo "F01-NEGATIVE-FAILED failed=$FAIL (جزئیات: $OUT)" >&2
exit 1
