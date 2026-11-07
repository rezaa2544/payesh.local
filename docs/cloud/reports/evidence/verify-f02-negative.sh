#!/usr/bin/env bash
# آزمون منفی دروازهٔ F‑02 — بازیابی بی‌امضا، پشتیبان دست‌کاری‌شده، ارتقای نقش
# از همگام‌سازی یا شاهد ناکافی نباید CLOSED بگیرد.
# اجرا: bash docs/cloud/reports/evidence/verify-f02-negative.sh
# خروجی: docs/cloud/reports/evidence/f02-negative.txt ⇒ F02-NEGATIVE-OK
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-f02-gate.sh
OUT=$D/f02-negative.txt
TESTS=$D/mission-05-tests-run.log

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt; : > "$LOG"
PASS=0; FAIL=0
pos() { PASS=$((PASS+1)); echo "PASS  $1  $2" | tee -a "$LOG"; }
neg() { FAIL=$((FAIL+1)); echo "FAIL  $1  $2" | tee -a "$LOG"; }

reject() { # id desc expected-reason env...
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env F02_OUT="$TMP/out.txt" F02_FAILDIR="$TMP" F02_NOSELFCHECK=1 "$@" bash "$GATE" 2>&1 >/dev/null); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'F02-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    pos "$id" "رد شد: $desc → $(printf '%s' "$err" | head -1 | cut -c1-80)"
  else
    neg "$id" "پذیرفته شد/دلیل اشتباه: $desc → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)"
  fi
}

if F02_OUT="$TMP/pos.txt" F02_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1 && grep -qF 'F02-CLOSED' "$TMP/pos.txt"; then
  pos P0 "شاهد سالم پذیرفته شد (کنترل مثبت)"
else
  neg P0 "شاهد سالم رد شد — دروازه خودش خراب است"
fi

# N1 — حذف بررسی امضا
cp server/mirror.js "$TMP/n1.js"
sed -i 's/const verdict = verifySnapshot(store, data);/const verdict = { ok: true };/' "$TMP/n1.js"
reject N1 "restore بدون بررسی امضا" "RESTORE-VERIFY" "F02_MIRROR=$TMP/n1.js"

# N2 — پذیرفتن پشتیبان بی‌امضا
cp server/mirror.js "$TMP/n2.js"
sed -i "s/error: 'unsigned_backup'/error: 'legacy_ok'/" "$TMP/n2.js"
reject N2 "پذیرش پشتیبان بی‌امضا" "UNSIGNED" "F02_MIRROR=$TMP/n2.js"

# N3 — باز شدن مستأجر
cp server/mirror.js "$TMP/n3.js"
sed -i "s/error: 'cross_tenant'/error: 'ok_tenant'/" "$TMP/n3.js"
reject N3 "بازیابی از مستأجر دیگر" "TENANT" "F02_MIRROR=$TMP/n3.js"

# N4 — ارتقای نقش از همگام‌سازی
cp server/sync.js "$TMP/n4.js"
sed -i "s/role_change_denied/role_change_allowed/" "$TMP/n4.js"
reject N4 "ارتقای نقش از sync" "SYNC-ROLE" "F02_SYNC=$TMP/n4.js"

# N5 — شاهد آزمون ناکافی
sed -e 's/^SUMMARY pass=92 fail=0$/SUMMARY pass=91 fail=0/' "$TESTS" > "$TMP/tests.txt"
reject N5 "شاهد آزمون کمتر از ۹۲" "TESTS-COUNT" "F02_TESTS=$TMP/tests.txt"

{
  echo "# آزمون منفی دروازهٔ F‑02"
  echo "generated_by: docs/cloud/reports/evidence/verify-f02-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "passed: $PASS"
  echo "failed: $FAIL"
  echo
  cat "$LOG"
  if [ "$FAIL" = "0" ]; then echo; echo "F02-NEGATIVE-OK checks=$PASS"; else echo; echo "F02-NEGATIVE-FAILED failed=$FAIL"; fi
} > "$OUT"
if [ "$FAIL" = "0" ]; then echo "→ $OUT"; echo "F02-NEGATIVE-OK checks=$PASS"; exit 0; fi
echo "F02-NEGATIVE-FAILED failed=$FAIL (جزئیات: $OUT)" >&2
exit 1
