#!/usr/bin/env bash
# آزمون منفی دروازهٔ F‑06 — اگر هویت دوباره از کلاینت خوانده شود، اگر تیکت
# نوشتن برگردد، اگر پاکت بی‌امضا قرنطینه نشود یا شاهد آزمون کافی نباشد،
# دروازه نباید CLOSED بدهد.
# اجرا: bash docs/cloud/reports/evidence/verify-f06-negative.sh
# خروجی: docs/cloud/reports/evidence/f06-negative.txt ⇒ NEGATIVE-OK
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-f06-gate.sh
OUT=$D/f06-negative.txt
TESTS=$D/mission-05-tests-run.log

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt; : > "$LOG"
PASS=0; FAIL=0
pos() { PASS=$((PASS+1)); echo "PASS  $1  $2" | tee -a "$LOG"; }
neg() { FAIL=$((FAIL+1)); echo "FAIL  $1  $2" | tee -a "$LOG"; }

reject() { # id desc expected-reason var=file
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env F06_OUT="$TMP/out.txt" F06_FAILDIR="$TMP" "$@" bash "$GATE" 2>&1 >/dev/null); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'F06-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    pos "$id" "رد شد: $desc → $(printf '%s' "$err" | head -1 | cut -c1-80)"
  else
    neg "$id" "پذیرفته شد/دلیل اشتباه: $desc → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)"
  fi
}

# کنترل مثبت
if F06_OUT="$TMP/pos.txt" F06_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1 && grep -qF 'F06-CLOSED' "$TMP/pos.txt"; then
  pos P0 "شاهد سالم پذیرفته شد (کنترل مثبت)"
else
  neg P0 "شاهد سالم رد شد — دروازه خودش خراب است"
fi

# N1 — drain بدون بررسی امضا
cp server/outbox.js "$TMP/n1.js"
sed -i 's/const env = verifyEnvelope(store, doc);/const env = doc.items ? { user_id: doc.user_id, role: doc.role, items: doc.items } : null;/' "$TMP/n1.js"
reject N1 "drain بدون verifyEnvelope" "DRAIN-TRUST" "F06_OUTBOX=$TMP/n1.js"

# N2 — بازگشت هویت از item.user_id
cp server/outbox.js "$TMP/n2.js"
printf '\nfunction legacyIdentity(item) { return Number(item.user_id) || null; }\n' >> "$TMP/n2.js"
reject N2 "هویت از item.user_id" "IDENTITY" "F06_OUTBOX=$TMP/n2.js"

# N3 — حذف قرنطینه
cp server/outbox.js "$TMP/n3.js"
sed -i "s/client_identity_untrusted/legacy_dropped/" "$TMP/n3.js"
reject N3 "پاکت بی‌امضا قرنطینه نشود" "QUARANTINE" "F06_OUTBOX=$TMP/n3.js"

# N4 — بازگشت تیکت نوشتن
cp server/index.js "$TMP/n4.js"
printf '\nconst OUTBOX_PUT_TICKET = "outbox_put";\n' >> "$TMP/n4.js"
reject N4 "بازگشت تیکت نوشتن صندوقچه" "WRITE-TICKET" "F06_INDEX=$TMP/n4.js"

# N5 — نوشتن مستقیم کلاینت
cp client/lib/phone.js "$TMP/n5.js"
printf '\n// s3put(%s, body)\n' "'outbox_put'" >> "$TMP/n5.js"
reject N5 "نوشتن مستقیم کلاینت در صندوقچه" "CLIENT-DIRECT" "F06_CLIENT=$TMP/n5.js"

# N6 — شاهد آزمون ناکافی/شکست‌دار
sed -e 's/^SUMMARY pass=90 fail=0$/SUMMARY pass=89 fail=0/' "$TESTS" > "$TMP/tests.txt"
reject N6 "شاهد آزمون کمتر از ۹۰" "TESTS-COUNT" "F06_TESTS=$TMP/tests.txt"

{
  echo "# آزمون منفی دروازهٔ F‑06"
  echo "generated_by: docs/cloud/reports/evidence/verify-f06-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "passed: $PASS"
  echo "failed: $FAIL"
  echo
  cat "$LOG"
  if [ "$FAIL" = "0" ]; then echo; echo "F06-NEGATIVE-OK checks=$PASS"; else echo; echo "F06-NEGATIVE-FAILED failed=$FAIL"; fi
} > "$OUT"

if [ "$FAIL" = "0" ]; then
  echo "→ $OUT"
  echo "F06-NEGATIVE-OK checks=$PASS"
  exit 0
fi
echo "F06-NEGATIVE-FAILED failed=$FAIL (جزئیات: $OUT)" >&2
exit 1
