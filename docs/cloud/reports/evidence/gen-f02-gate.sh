#!/usr/bin/env bash
# دروازهٔ ردیف F‑02 (P0) — «Restore/import نمی‌تواند role/tenant/ownership را ارتقا دهد»
# fail-closed: پشتیبان بی‌امضا/دست‌کاری‌شده، بازیابی از نصب دیگر، ارتقای نقش از
# مسیر همگام‌سازی یا شاهد ناسازگار ⇒ شکست.
#
# اجرا: bash docs/cloud/reports/evidence/gen-f02-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-f02-gate.txt ⇒ F02-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${F02_OUT:-$D/cc-f02-gate.txt}"
FAILDIR="${F02_FAILDIR:-$D}"
TESTS="${F02_TESTS:-$D/mission-05-tests-run.log}"
MIRROR="${F02_MIRROR:-server/mirror.js}"
INDEX="${F02_INDEX:-server/index.js}"
SYNC="${F02_SYNC:-server/sync.js}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "F02-FAIL: $1" >&2
  { echo "# دروازهٔ F‑02 — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$FAILDIR/cc-f02-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۱) امضای پشتیبان ────────────────────────────────────────────────────────
grep -q 'FORMAT_VERSION = 2' "$MIRROR" || fail "FORMAT: پشتیبان نسخهٔ امضاشده نیست"; ok
grep -q 'createHmac' "$MIRROR" || fail "SIGN: امضای HMAC وجود ندارد"; ok
grep -q 'verifySnapshot(store, data)' "$MIRROR" || fail "RESTORE-VERIFY: restore امضا را بررسی نمی‌کند"; ok
grep -q "error: 'unsigned_backup'" "$MIRROR" || fail "UNSIGNED: پشتیبان بی‌امضا رد نمی‌شود"; ok
grep -q "error: 'bad_signature'" "$MIRROR" || fail "FORGED: امضای نادرست رد نمی‌شود"; ok
grep -q 'timingSafeEqual' "$MIRROR" || fail "SIGN-CMP: مقایسهٔ امضا زمان‌ثابت نیست"; ok

# ── ۲) مرز مستأجر و نقش ────────────────────────────────────────────────────
grep -q "error: 'cross_tenant'" "$MIRROR" || fail "TENANT: بازیابی از مستأجر دیگر رد نمی‌شود"; ok
grep -q 'ROLES' "$MIRROR" || fail "ROLE-WHITELIST: نقش‌های مجاز تعریف نشده‌اند"; ok
grep -q "role_change_denied" "$SYNC" || fail "SYNC-ROLE: تغییر نقش از همگام‌سازی بسته نیست"; ok
grep -q "actor.role !== 'manager'" "$INDEX" || fail "RESTORE-ACTOR: بازیابی فقط برای مدیر نیست"; ok
grep -q 'mirror.restore(store, body && body.data, { replace: !!(body && body.replace), actor })' "$INDEX" \
  || fail "RESTORE-ACTOR-PASS: هویت بازیاب به لایهٔ داده نمی‌رسد"; ok

# ── ۳) شاهد آزمون runtime ───────────────────────────────────────────────────
[ -f "$TESTS" ] || fail "TESTS-MISSING: $TESTS"
grep -q 'F02-OK checks=12' "$TESTS" || fail "F02-TEST: آزمون F‑02 در شاهد اجرا نیست"; ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: آزمون پایه شکست دارد ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 92 ] || fail "TESTS-COUNT: آزمون پایه کمتر از ۹۲ است ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد آزمون از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۴) آزمون منفیِ درون‌دروازه: پشتیبان بی‌امضا نباید بپذیرد ───────────────
if [ -z "${F02_NOSELFCHECK:-}" ]; then
FX=$(mktemp /tmp/f02-gate-XXXXXX.js)
cp "$MIRROR" "$FX"
sed -i 's/const verdict = verifySnapshot(store, data);/const verdict = { ok: true };/' "$FX"
if grep -q 'const verdict = { ok: true };' "$FX"; then
  F02_MIRROR="$FX" F02_NOSELFCHECK=1 F02_OUT="$FAILDIR/f02-selfcheck.txt" F02_FAILDIR="$FAILDIR" F02_TESTS="$TESTS" \
    F02_INDEX="$INDEX" F02_SYNC="$SYNC" bash "$0" >/dev/null 2>&1 \
    && { rm -f "$FX" "$FAILDIR/f02-selfcheck.txt"; fail "NEGATIVE-SELF: بی‌امضا دروازه را رد نکرد"; }
  rm -f "$FAILDIR/f02-selfcheck.txt"
fi
rm -f "$FX"
fi
ok

{
  echo "# دروازهٔ ردیف F‑02 — بازیابی امن و بدون ارتقای نقش/مستأجر (P0)"
  echo "generated_by: docs/cloud/reports/evidence/gen-f02-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "checks_passed: $CHECKS"
  echo "F-02: CLOSED"
  echo
  echo "F02-CLOSED checks=$CHECKS tests=$TP"
} > "$OUT"
echo "→ $OUT"
echo "F02-CLOSED checks=$CHECKS tests=$TP"
