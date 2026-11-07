#!/usr/bin/env bash
# دروازهٔ ردیف ۲۷ — «همگام‌سازی/آفلاین: بدون از دست رفتن داده و تعارض طبق D‑28»
# fail-closed: تعارض server-wins، دور ریختن عملیات ردشده، نبود ایندمپوتنسی،
# دور زدن OCC، شاهد ناسازگار یا آزمون منفیِ ناکارآمد ⇒ شکست.
#
# اجرا: bash docs/cloud/reports/evidence/gen-sync-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-sync-gate.txt ⇒ SYNC-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${SYNC_OUT:-$D/cc-sync-gate.txt}"
FAILDIR="${SYNC_FAILDIR:-$D}"
TESTS="${SYNC_TESTS:-$D/mission-05-tests-run.log}"
RESTART="${SYNC_RESTART:-$D/sync-restart-run.log}"
NEG="${SYNC_NEG:-$D/sync-negative.txt}"
SYNCJS="${SYNC_SYNCJS:-server/sync.js}"
POLICY="${SYNC_POLICY:-server/policy.js}"
CLIENT="${SYNC_CLIENT:-client/app.js}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "SYNC-FAIL: $1" >&2
  { echo "# دروازهٔ ردیف ۲۷ — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$FAILDIR/cc-sync-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۱) شاهد آزمون runtime ──────────────────────────────────────────────────
[ -f "$TESTS" ] || fail "TESTS-MISSING: $TESTS"
grep -q 'SYNC-OK checks=24' "$TESTS" || fail "SYNC-TEST: بلوک آزمون ردیف ۲۷ در شاهد نیست"; ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: شکست آزمون ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 93 ] || fail "TESTS-COUNT: کمتر از ۹۳ ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۲) شاهد ری‌استارت/crash ────────────────────────────────────────────────
[ -f "$RESTART" ] || fail "RESTART-MISSING: $RESTART"
grep -q 'RESTART_SUMMARY pass=6 fail=0' "$RESTART" || fail "RESTART-FAIL: شاهد ری‌استارت سبز نیست"; ok
RFP=$(grep -m1 '^# product_tree_sha256:' "$RESTART" | awk '{print $3}')
[ "$RFP" = "$HEADFP" ] || fail "RESTART-TREE: شاهد ری‌استارت از درخت دیگری است"; ok

# ── ۳) D‑28 در کد: هر دو نسخه، تصمیم مجاز، ثبت تصمیم‌گیرنده ───────────────
grep -q "conflicts:.*write: \[\].*read: \['manager'\]" "$POLICY" \
  || fail "CONFLICTS-POLICY: کلاینت می‌تواند در جدول تعارض بنویسد یا مدیر نمی‌خواند"; ok
grep -q 'function openConflict' "$SYNCJS" || fail "CONFLICT-RECORD: تعارض ثبت نمی‌شود"; ok
grep -q 'local: info.local' "$SYNCJS" || fail "CONFLICT-LOCAL: نسخهٔ محلی نگه داشته نمی‌شود"; ok
grep -q 'server: info.server' "$SYNCJS" || fail "CONFLICT-SERVER: نسخهٔ سرور نگه داشته نمی‌شود"; ok
grep -q "if (!actor || actor.role !== 'manager') return { ok: false, error: 'forbidden' };" "$SYNCJS" \
  || fail "RESOLVE-ROLE: حل تعارض فقط برای مدیر نیست"; ok
grep -q 'decided_by: actor.user.id' "$SYNCJS" || fail "RESOLVE-IDENTITY: تصمیم‌گیرنده ثبت نمی‌شود"; ok
grep -q "action: 'conflict_resolve'" "$SYNCJS" || fail "RESOLVE-AUDIT: تصمیم در حسابرسی نیست"; ok
grep -q 'function noteRejected' "$SYNCJS" || fail "REJECT-RECORD: رد دسترسی دور ریخته می‌شود (F‑09)"; ok

# ── ۴) ایندمپوتنسی و OCC ───────────────────────────────────────────────────
grep -q 'if (store.syncSeen(uid))' "$SYNCJS" || fail "IDEMPOTENCY: تکرار uid تشخیص داده نمی‌شود"; ok
grep -q 'verifierOnly' "$SYNCJS" || fail "OCC-BYPASS: base=0 می‌تواند OCC را دور بزند"; ok
grep -q "const verifierOnly = Object.keys(incoming).length > 0" "$SYNCJS" || fail "OCC-BYPASS-2: استثنای base=0 محدود به اثر انگشت رمز نیست"; ok

# ── ۵) کلاینت: تعارض/رد ⇒ «نیازمند بررسی»، نه دور ریختن ────────────────────
grep -q "payesh.review" "$CLIENT" || fail "CLIENT-REVIEW: فهرست بررسی در کلاینت نیست"; ok
grep -q "status: 'needs_review'" "$CLIENT" || fail "CLIENT-STATUS: تعارض «حل‌شده» فرض می‌شود"; ok
grep -q 'هر دو نسخه نگه داشته شد' "$CLIENT" || fail "CLIENT-MSG: پیام server-wins باقی مانده (F‑08)"; ok
grep -q 'نیازمند بررسی مدیر' "$CLIENT" || fail "CLIENT-REJECT: رد دسترسی فقط با toast کنار گذاشته می‌شود (F‑09)"; ok

# ── ۶) آزمون منفی ──────────────────────────────────────────────────────────
[ -f "$NEG" ] || fail "NEG-MISSING: $NEG"
grep -q 'SYNC-NEGATIVE-OK checks=5' "$NEG" || fail "NEG-FAIL: آزمون منفی سبز نیست"; ok

# ── ۷) آزمون منفیِ درون‌دروازه ─────────────────────────────────────────────
if [ -z "${SYNC_NOSELFCHECK:-}" ]; then
  FX=$(mktemp /tmp/sync-gate-XXXXXX.js)
  cp "$SYNCJS" "$FX"
  sed -i "s/if (!actor || actor.role !== 'manager') return { ok: false, error: 'forbidden' };/if (false) return { ok: false, error: 'forbidden' };/" "$FX"
  if grep -q 'if (false) return { ok: false' "$FX"; then
    SYNC_SYNCJS="$FX" SYNC_NOSELFCHECK=1 SYNC_OUT="$FAILDIR/sync-selfcheck.txt" SYNC_FAILDIR="$FAILDIR" \
      SYNC_TESTS="$TESTS" SYNC_RESTART="$RESTART" SYNC_NEG="$NEG" bash "$0" >/dev/null 2>&1 \
      && { rm -f "$FX" "$FAILDIR/sync-selfcheck.txt"; fail "NEGATIVE-SELF: نقش غیرمجاز دروازه را رد نکرد"; }
    rm -f "$FAILDIR/sync-selfcheck.txt"
  fi
  rm -f "$FX"
fi
ok

# ── ۸) دروازه‌های پیشین نباید تضعیف شوند ───────────────────────────────────
for G in f01 f02 f04 f06; do
  case $G in
    f01) MARK='F01-CLOSED' ;;
    f02) MARK='F02-CLOSED' ;;
    f04) MARK='F04-CLOSED' ;;
    f06) MARK='F06-CLOSED' ;;
  esac
  bash "$D/gen-$G-gate.sh" >/dev/null 2>&1 || fail "REGRESSION: دروازهٔ $G دیگر سبز نیست"
  grep -q "$MARK" "$D/cc-$G-gate.txt" || fail "REGRESSION-MARK: $MARK نیست"
  ok
done

{
  echo "# دروازهٔ ردیف ۲۷ — همگام‌سازی/آفلاین (D‑28، بدون از دست رفتن داده)"
  echo "generated_by: docs/cloud/reports/evidence/gen-sync-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "restart_witness: pass=6 fail=0"
  echo "checks_passed: $CHECKS"
  echo "row-27: CLOSED"
  echo
  echo "SYNC-CLOSED checks=$CHECKS tests=$TP restart=6/0 negatives=5"
} > "$OUT"
echo "→ $OUT"
echo "SYNC-CLOSED checks=$CHECKS tests=$TP restart=6/0 negatives=5"
