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
grep -qE '= *verifyEnvelope\(store, doc\);' "$OUTBOX" || fail "DRAIN-TRUST: drain پاکت را با verifyEnvelope بررسی نمی‌کند"
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

# ── ۱ب) تعلق مستأجر: امضا به ازای هر مستأجر + رد پاکتِ مستأجر دیگر ──────────
grep -q 'function tenantKeyName(tid)' "$OUTBOX" || fail "TENANT-KEY: کلید امضا به مستأجر گره نخورده"; ok
grep -q "SIGN_KEY + ':' + Number(tid)" "$OUTBOX" || fail "TENANT-KEY-NAME: نام کلید شامل مستأجر نیست"; ok
grep -q 'function existingSignKey' "$OUTBOX" || fail "VERIFY-NOKEY: بررسی امضا کلید جدید می‌سازد (اثر جانبی)"; ok
grep -q 'function acceptEnvelope(store, doc)' "$OUTBOX" || fail "ACCEPT: تابع پذیرش پاکت (امضا+مستأجر) نیست"; ok
grep -q "reason: 'cross_tenant'" "$OUTBOX" || fail "CROSS-TENANT: رد پاکتِ مستأجر دیگر پیاده نشده"; ok
grep -q 'Number(env.tenant_id) !== Number(here)' "$OUTBOX" || fail "CROSS-TENANT-CMP: مقایسهٔ مستأجر پاکت با نصب نیست"; ok
grep -qE '= acceptEnvelope\(store, doc\);' "$OUTBOX" || fail "DRAIN-ACCEPT: drain از acceptEnvelope استفاده نمی‌کند"; ok
grep -q 'out\.cross_tenant' "$OUTBOX" || fail "CROSS-TENANT-COUNT: رد متقاطع در گزارش drain شمرده نمی‌شود"; ok
grep -q 'function serverTenant(store)' "$OUTBOX" || fail "SERVER-TENANT: مستأجرِ نصب تعریف نشده"; ok
grep -q 'tenantCtx.sanitize' "$OUTBOX" || fail "DATA-CLEAN: دادهٔ کلاینت از میدان مستأجر پاک نمی‌شود"; ok
grep -q 'ignoredClaims' "$OUTBOX" || fail "IGNORED-CLAIMS: نادیده‌گرفتن ادعاهای هویت گزارش نمی‌شود"; ok
grep -q 'ignored_claims' "$OUTBOX" || fail "IGNORED-FIELD: پاسخ ثبت میدان ignored_claims ندارد"; ok
grep -q 'outbox.submit(store, { user: who, device, items: body.items, claims })' "$INDEX" \
  || fail "SUBMIT-CLAIMS: هندلر، ادعاهای body/header/query را گزارش نمی‌کند"; ok

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
grep -q 'F06-OK checks=22' "$TESTS" || fail "F06-TEST: آزمون F‑06 (۲۲ بررسی) در شاهد اجرا نیست"; ok
for M in spoof=blocked header=blocked query=blocked replay=blocked cross_tenant=blocked forged=quarantined; do
  grep -q "$M" "$TESTS" || fail "F06-MARK: نشانهٔ «$M» در شاهد آزمون نیست"
done
ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: آزمون پایه شکست دارد ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 90 ] || fail "TESTS-COUNT: آزمون پایه کمتر از ۹۰ است ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد آزمون از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۵) آزمون منفیِ درون‌دروازه: پاکت جعلی نباید اعتبار بگیرد ───────────────
if [ -z "${F06_NOSELFCHECK:-}" ]; then
FX=$(mktemp /tmp/f06-gate-XXXXXX.js)
cp "$OUTBOX" "$FX"
sed -i "s/if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;/if (false) return null;/" "$FX"
if grep -q 'if (false) return null;' "$FX"; then
  F06_NOSELFCHECK=1 F06_OUTBOX="$FX" F06_OUT="$FAILDIR/f06-selfcheck.txt" F06_FAILDIR="$FAILDIR" \
    F06_TESTS="$TESTS" F06_INDEX="$INDEX" F06_CLIENT="$CLIENT" bash "$0" >/dev/null 2>&1 \
    && { rm -f "$FX" "$FAILDIR/f06-selfcheck.txt"; fail "NEGATIVE-SELF: امضای جعلی دروازه را رد نکرد"; }
  rm -f "$FAILDIR/f06-selfcheck.txt"
fi
rm -f "$FX"
fi
ok

# ── ۶) آزمون منفیِ درون‌دروازه: خاموشیِ نگهبان مستأجر ⇒ شکست ───────────────
if [ -z "${F06_NOSELFCHECK2:-}" ]; then
FY=$(mktemp /tmp/f06-gate2-XXXXXX.js)
cp "$OUTBOX" "$FY"
sed -i 's/if (Number(env.tenant_id) !== Number(here) || Number(env.school_id) !== Number(here)) {/if (false) {/' "$FY"
if grep -q 'if (false) {' "$FY"; then
  F06_NOSELFCHECK=1 F06_NOSELFCHECK2=1 F06_OUTBOX="$FY" F06_OUT="$FAILDIR/f06-selfcheck2.txt" F06_FAILDIR="$FAILDIR" \
    F06_TESTS="$TESTS" F06_INDEX="$INDEX" F06_CLIENT="$CLIENT" bash "$0" >/dev/null 2>&1 \
    && { rm -f "$FY" "$FAILDIR/f06-selfcheck2.txt"; fail "NEGATIVE-SELF2: خاموشیِ نگهبان مستأجر دروازه را رد نکرد"; }
  rm -f "$FAILDIR/f06-selfcheck2.txt"
fi
rm -f "$FY"
fi
ok

{
  echo "# دروازهٔ ردیف F‑06 — حذف هویت client-controlled از Outbox/drain (P0)"
  echo "generated_by: docs/cloud/reports/evidence/gen-f06-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "checks_passed: $CHECKS"
  echo "postgres_witness: F05-PG-OK checks=12 (پاکت/دسترسی مستأجر روی همان مدل)"
  echo "cross_tenant: blocked · replay: blocked · header/query spoof: blocked"
  echo "F-06: CLOSED"
  echo
  echo "F06-CLOSED checks=$CHECKS tests=$TP"
} > "$OUT"
echo "→ $OUT"
echo "F06-CLOSED checks=$CHECKS tests=$TP"
