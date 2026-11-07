#!/usr/bin/env bash
# دروازهٔ ردیف F‑06 (P0) — «هویت client-controlled از Outbox/drain حذف شود»
# fail-closed: هر مسیر که هویت را از بدنه/فایل کلاینت بخواند، هر تیکت نوشتن،
# هر پاکت بی‌امضا یا هر شاهد ناسازگار ⇒ شکست.
#
# اجرا: bash docs/cloud/reports/evidence/gen-f06-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-f06-gate.txt ⇒ F06-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${F06_OUT:-$D/cc-f06-gate.txt}"
FAILDIR="${F06_FAILDIR:-$D}"
TESTS="${F06_TESTS:-$D/mission-05-tests-run.log}"
OUTBOX="${F06_OUTBOX:-server/outbox.js}"
INDEX="${F06_INDEX:-server/index.js}"
CLIENT="${F06_CLIENT:-client/lib/phone.js}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "F06-FAIL: $1" >&2
  { echo "# دروازهٔ F‑06 — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$FAILDIR/cc-f06-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۱) drain: هویت فقط از پاکتِ امضاشدهٔ سرور ──────────────────────────────
grep -q 'verifyEnvelope(store, doc)' "$OUTBOX" || fail "DRAIN-TRUST: drain پاکت را با verifyEnvelope بررسی نمی‌کند"
ok
if grep -qE 'item\.user_id|entries\s*=\s*Array\.isArray\(doc' "$OUTBOX"; then
  fail "IDENTITY: هنوز هویت از item.user_id / فایل کلاینت خوانده می‌شود"
fi; ok
grep -qE 'const actor = \{ user, role: user\.role' "$OUTBOX" || fail "IDENTITY-SOURCE: نقش از کاربرِ پایگاه داده خوانده نمی‌شود"; ok
grep -q 'createHmac' "$OUTBOX" || fail "SIGN: پاکت امضای HMAC ندارد"; ok
grep -q 'timingSafeEqual' "$OUTBOX" || fail "SIGN-CMP: مقایسهٔ امضا زمان‌ثابت نیست"; ok
grep -q 'client_identity_untrusted' "$OUTBOX" || fail "QUARANTINE: پاکت بی‌امضا قرنطینه نمی‌شود"; ok
grep -q 'outbox/quarantine/' "$OUTBOX" || fail "QUARANTINE-KEEP: فایل مشکوک برای بازرسی نگه داشته نمی‌شود"; ok
grep -qE 'Number\(env\.user_id\)|env\.device_id' "$OUTBOX" || fail "ENVELOPE-IDENTITY: هویت از پاکت استفاده نمی‌شود"; ok

# ── ۲) API: پذیرش ثبت فقط با نشست/تیکت؛ هیچ تیکت نوشتن ────────────────────
grep -q "'/api/outbox/submit'" "$INDEX" || fail "SUBMIT-ROUTE: مسیر امن ثبت وجود ندارد"; ok
if grep -q 'outbox_put' "$INDEX"; then
  fail "WRITE-TICKET: سرور هنوز تیکت نوشتن در صندوقچه صادر می‌کند"
fi; ok
grep -q 'verifyDeviceTicket(store, headerTicket || body.device_ticket)' "$INDEX" \
  || fail "SUBMIT-AUTH: ثبت با تیکت دستگاه بررسی نمی‌شود"; ok

# ── ۳) کلاینت: هیچ ادعای هویتی و هیچ نوشتن مستقیم ─────────────────────────
grep -q 'api(.\(/api/outbox/submit\)' "$CLIENT" || fail "CLIENT-WRITE: کلاینت از مسیر امن ثبت استفاده نمی‌کند"; ok
if grep -q "s3put('outbox_put'" "$CLIENT"; then
  fail "CLIENT-DIRECT: کلاینت مستقیم در صندوقچه می‌نویسد"
fi; ok
if grep -qE "entry\s*=\s*\{[^}]*user_id" "$CLIENT"; then
  fail "CLIENT-CLAIM: کلاینت user_id/role در ثبت می‌گذارد"
fi; ok

# ── ۴) شاهد آزمون ──────────────────────────────────────────────────────────
[ -f "$TESTS" ] || fail "TESTS-MISSING: $TESTS"
grep -q 'F06-OK checks=12' "$TESTS" || fail "F06-TEST: آزمون F‑06 در شاهد اجرا نیست"; ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: آزمون پایه شکست دارد ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 90 ] || fail "TESTS-COUNT: آزمون پایه کمتر از ۹۰ است ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد آزمون از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۵) آزمون منفیِ درون‌دروازه: پاکت جعلی نباید اعتبار بگیرد ───────────────
FX=$(mktemp /tmp/f06-gate-XXXXXX.js)
cp "$OUTBOX" "$FX"
sed -i "s/if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;/if (false) return null;/" "$FX"
if grep -q 'if (false) return null;' "$FX"; then
  F06_OUTBOX="$FX" F06_OUT="$FAILDIR/f06-selfcheck.txt" F06_FAILDIR="$FAILDIR" \
    F06_TESTS="$TESTS" F06_INDEX="$INDEX" F06_CLIENT="$CLIENT" bash "$0" >/dev/null 2>&1 \
    && { rm -f "$FX" "$FAILDIR/f06-selfcheck.txt"; fail "NEGATIVE-SELF: امضای جعلی دروازه را رد نکرد"; }
  rm -f "$FAILDIR/f06-selfcheck.txt"
fi
rm -f "$FX"; ok

{
  echo "# دروازهٔ ردیف F‑06 — حذف هویت client-controlled از Outbox/drain (P0)"
  echo "generated_by: docs/cloud/reports/evidence/gen-f06-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "checks_passed: $CHECKS"
  echo "F-06: CLOSED"
  echo
  echo "F06-CLOSED checks=$CHECKS tests=$TP"
} > "$OUT"
echo "→ $OUT"
echo "F06-CLOSED checks=$CHECKS tests=$TP"
