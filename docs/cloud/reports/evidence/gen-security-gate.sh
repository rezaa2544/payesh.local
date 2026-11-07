#!/usr/bin/env bash
# دروازهٔ امنیت — ردیف ۲۸ (Security Gate مستقل) · FAIL-CLOSED
#
# این دروازه «محصول امن است» نمی‌گوید؛ اثبات می‌کند که:
#   ۱) آزمون نفوذ خودکار روی محصولِ واقعی اجرا شده و همهٔ ۴۰ حمله دفع شده‌اند،
#   ۲) مدل تهدید با بخش‌های لازم در مخزن هست،
#   ۳) مسیرهای حساس (auth/tenant/outbox/storage) هنوز شاهد سبز دارند،
#   ۴) خاموش‌کردن یک کنترل امنیتی دروازه را می‌شکند (آزمون منفی).
#
# اجرا: bash docs/cloud/reports/evidence/gen-security-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-security-gate.txt ⇒ SECURITY-GATE-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${SEC_OUT:-$D/cc-security-gate.txt}"
FAILDIR="${SEC_FAILDIR:-$D}"
PEN_OUT="${SEC_PEN:-$D/security-penetration.txt}"
PEN_SH="${SEC_PEN_SH:-$D/security/pen-test.cjs}"
TM="${SEC_TM:-docs/cloud/12-security-threat-model.md}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "SEC-FAIL: $1" >&2
  { echo "# دروازهٔ امنیت — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$FAILDIR/cc-security-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۰) پیش‌نیازها: مسیرهای حساس باید شاهد سبز داشته باشند ──────────────────
[ -f "$PEN_SH" ] || fail "PEN-MISSING: هارنس آزمون نفوذ نیست"
[ -f "$TM" ] || fail "THREAT-MODEL-MISSING: $TM"

for pair in "f01:F01-CLOSED" "f02:F02-CLOSED" "f04:F04-CLOSED" "f06:F06-CLOSED" "sync:SYNC-CLOSED"; do
  G=${pair%%:*}; MARK=${pair#*:}
  [ -f "$D/cc-$G-gate.txt" ] || fail "PREREQ-MISSING: شاهد cc-$G-gate.txt نیست"
  grep -q "$MARK" "$D/cc-$G-gate.txt" || fail "PREREQ: $MARK در شاهد نیست"
done
ok
[ -f "$D/f05-product-tenancy.txt" ] || fail "PREREQ: شاهد PostgreSQL مستأجر نیست"
grep -q 'F05-PG-OK checks=12' "$D/f05-product-tenancy.txt" || fail "PREREQ: RLS مستأجر سبز نیست"
ok

# ── ۱) اجرای آزمون نفوذ روی همین درخت ────────────────────────────────────
node --experimental-sqlite --disable-warning=ExperimentalWarning "$PEN_SH" --out "$PEN_OUT" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] || fail "PEN-FAIL: آزمون نفوذ شکست دارد (exit=$RC) — جزئیات: $PEN_OUT"
ok

# ── ۲) شاهد خام: ۴۰ بررسی، صفر شکست، صفر ردشده ───────────────────────────
[ -f "$PEN_OUT" ] || fail "PEN-WITNESS-MISSING: $PEN_OUT"
grep -qE '^SECURITY-PEN pass=40 fail=0 skip=0' "$PEN_OUT" || fail "PEN-COUNTS: شمارش ۴۰/۰/۰ نیست"
ok
grep -q '^EXIT=0' "$PEN_OUT" || fail "PEN-EXIT: خروجی هارنس صفر نیست"; ok
PASSN=$(grep -c '^PASS  S-' "$PEN_OUT" || true)
[ "${PASSN:-0}" -ge 40 ] || fail "PEN-LINES: تعداد خطوط PASS کمتر از ۴۰ است ($PASSN)"; ok
grep -q '^FAIL  S-' "$PEN_OUT" && fail "PEN-FAILLINE: خط FAIL در شاهد هست"
ok

# هر حوزهٔ AC باید حداقل یک بررسی سبز داشته باشد
for pair in "auth:S-0" "authorization:S-1" "idor:S-16" "storage:S-2" "outbox:S-28" "restore:S-3" "export:S-33" "headers:S-38"; do
  grep -q "^PASS  ${pair#*:}" "$PEN_OUT" || fail "SCOPE: حوزهٔ ${pair%%:*} شاهد سبز ندارد"
done
ok

# ── ۳) مدل تهدید: بخش‌های الزامی ──────────────────────────────────────────
for KEY in "دارایی‌ها" "STRIDE" "auth/session" "authorization" "tenant" "IDOR" "storage" "outbox" "restore" "cache/export" "پوشش نمی‌دهد"; do
  grep -q "$KEY" "$TM" || fail "TM-SECTION: بخش «$KEY» در مدل تهدید نیست"
done
ok
grep -q 'UNKNOWN' "$TM" || fail "TM-STATUS: وضعیت امنیت باید UNKNOWN (شاهد‌محور) بماند"; ok

# ── ۴) شاهدِ رفع یافته‌ها: کنترل‌های امنیتی در کد ─────────────────────────
INDEX=server/index.js
grep -q "x-content-type-options', 'nosniff'" "$INDEX" || fail "FIX-SEC03: سرآیند nosniff برنگشته"; ok
grep -q 'x-frame-options' "$INDEX" || fail "FIX-SEC03b: x-frame-options نیست"; ok
grep -q 'function exportRow' "$INDEX" || fail "FIX-SEC01: پاک‌سازی خروجی CSV نیست"; ok
grep -q "password_hash|password_plain" "$INDEX" || fail "FIX-SEC01b: فهرست ممنوعهٔ خروجی نیست"; ok
grep -q "msg === 'bad_json' ? 400" "$INDEX" || fail "FIX-SEC02: بدنهٔ خراب باید ۴۰۰ بدهد"; ok
grep -q "cache-control', 'no-store, max-age=0'" "$INDEX" || fail "FIX-SEC04: گاوصندوق رمزها کش‌شدنی است"; ok

# ── ۵) آزمون منفی: خاموش‌کردن یک کنترل امنیتی ⇒ شکست آزمون نفوذ ────────────
if [ -z "${SEC_NOSELFCHECK:-}" ]; then
  NEGTREE=$(mktemp -d /tmp/sec-neg-XXXXXX)
  git worktree add --detach "$NEGTREE" HEAD >/dev/null 2>&1 || fail "NEGATIVE-SETUP: ساخت worktree موقت ناموفق"
  # فقط خطِ صادرکردن سرآیند حذف می‌شود (خط نقشهٔ سرآیندها دست‌نخورده می‌ماند)
  sed -i "/res.setHeader('x-content-type-options'/d" "$NEGTREE/server/index.js"
  grep -q "res.setHeader('x-content-type-options'" "$NEGTREE/server/index.js" && { git worktree remove --force "$NEGTREE"; fail "NEGATIVE-APPLY: حذف سرآیند اعمال نشد"; }
  ln -s "$PWD/node_modules" "$NEGTREE/node_modules" 2>/dev/null || true
  node --experimental-sqlite --disable-warning=ExperimentalWarning \
    "$NEGTREE/docs/cloud/reports/evidence/security/pen-test.cjs" >/dev/null 2>&1
  NEGRC=$?
  git worktree remove --force "$NEGTREE" >/dev/null 2>&1 || rm -rf "$NEGTREE"
  [ "$NEGRC" != "0" ] || fail "NEGATIVE-SELF: حذف سرآیند nosniff آزمون نفوذ را رد نکرد"
fi
ok

{
  echo "# دروازهٔ امنیت — ردیف ۲۸ (Security Gate مستقل)"
  echo "generated_by: docs/cloud/reports/evidence/gen-security-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "penetration_witness: $PEN_OUT (SECURITY-PEN pass=40 fail=0 skip=0)"
  echo "threat_model: $TM"
  echo "fixes_verified: SEC-01 CSV/hashes · SEC-02 bad_json→400 · SEC-03 nosniff/frame · SEC-04 vault no-store"
  echo "checks_passed: $CHECKS"
  echo "security_status: UNKNOWN (evidence-backed — طبق §۱۰.۲ و D‑25)"
  echo "row-28: CLOSED"
  echo
  echo "SECURITY-GATE-CLOSED checks=$CHECKS pen=40/0/0 status=UNKNOWN"
} > "$OUT"
echo "→ $OUT"
echo "SECURITY-GATE-CLOSED checks=$CHECKS pen=40/0/0 status=UNKNOWN"
