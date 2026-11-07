#!/usr/bin/env bash
# دروازهٔ ردیف F‑01 (P0) — «ممیزی و رفع نشت اطلاعات کاربران»
# fail-closed: رمز خام روی دیسک/بکاپ/کش، پشتیبانِ غیرمدیر، لاگ رازدار،
# نبود باطل‌سازی نشست یا شاهد ناسازگار ⇒ شکست.
#
# اجرا: bash docs/cloud/reports/evidence/gen-f01-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-f01-gate.txt ⇒ F01-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${F01_OUT:-$D/cc-f01-gate.txt}"
FAILDIR="${F01_FAILDIR:-$D}"
TESTS="${F01_TESTS:-$D/mission-05-tests-run.log}"
AUTH="${F01_AUTH:-server/auth.js}"
INDEX="${F01_INDEX:-server/index.js}"
DB="${F01_DB:-server/db.js}"
CLIENT_APP="${F01_CLIENT_APP:-client/app.js}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "F01-FAIL: $1" >&2
  { echo "# دروازهٔ F‑01 — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$FAILDIR/cc-f01-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۱) رمز خام در هیچ مسیر ذخیره‌ای نیست ────────────────────────────────────
if grep -qE "password_plain[[:space:]]*:[[:space:]]*[^u[:space:]]" "$AUTH" "$INDEX"; then
  fail "PLAINTEXT: رمز خام در ردیف کاربر ذخیره می‌شود"
fi; ok
grep -q 'password_enc' "$AUTH" || fail "ENC-MISSING: رمز قابل‌بازخوانی رمزنگاری‌شده ذخیره نمی‌شود"; ok
grep -q "createCipheriv('aes-256-gcm'" "$AUTH" || fail "ENC-ALGO: رمزنگاری AES‑256‑GCM نیست"; ok
grep -q "createDecipheriv('aes-256-gcm'" "$AUTH" || fail "ENC-DECRYPT: مسیر بازخوانی رمزنگاری‌شده نیست"; ok
grep -q 'migrateSecrets' "$AUTH" || fail "MIGRATE: مهاجرت رمزهای قدیمی وجود ندارد"; ok
grep -q 'secret:at-rest-key' "$AUTH" || fail "KEY-META: کلید رمزنگاری در متادیتای سرور نیست"; ok
if grep -q 'at-rest-key' "$INDEX" "$CLIENT_APP"; then
  fail "KEY-LEAK: کلید رمزنگاری به لایهٔ API/کلاینت رفته است"
fi; ok

# ── ۲) فایل کامل داده/بکاپ فقط مدیر ─────────────────────────────────────────
grep -q "BACKUP_ROLES = new Set(\['manager'\])" "$INDEX" || fail "BACKUP-SCOPE: پشتیبان برای غیرمدیر باز است"; ok

# ── ۳) لاگ حسابرسی راز ندارد ───────────────────────────────────────────────
grep -q "delete out\[k\]" "$DB" || fail "AUDIT-SANITIZE: پاک‌سازی راز در audit نیست"; ok
grep -q "'password_plain', 'password_enc'" "$DB" || fail "AUDIT-FIELDS: فیلدهای رمزی در فهرست پاک‌سازی نیستند"; ok

# ── ۴) ورودی کاربر و کش کلاینت پاک‌سازی می‌شود ─────────────────────────────
grep -q 'delete incoming.password_plain' server/sync.js || fail "SYNC-SANITIZE: ورودی همگام‌سازی رمز خام را می‌پذیرد"; ok
grep -q 'delete row.password_plain' "$CLIENT_APP" || fail "CLIENT-CACHE: کش محلی رمز خام را نگه می‌دارد"; ok

# ── ۵) باطل‌سازی نشست/دستگاه ────────────────────────────────────────────────
grep -q 'function revokeAll(' "$AUTH" || fail "REVOKE: تابع باطل‌سازی همهٔ نشست‌ها نیست"; ok
grep -q "'/api/auth/revoke-all'" "$INDEX" || fail "REVOKE-ROUTE: مسیر revoke-all وجود ندارد"; ok
grep -qF 'users\/(\d+)\/revoke' "$INDEX" || fail "REVOKE-ADMIN: مدیر نمی‌تواند نشست کاربر را ببندد"; ok

# ── ۶) شاهد آزمون runtime ───────────────────────────────────────────────────
[ -f "$TESTS" ] || fail "TESTS-MISSING: $TESTS"
grep -q 'F01-OK checks=15' "$TESTS" || fail "F01-TEST: آزمون F‑01 در شاهد اجرا نیست"; ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: آزمون پایه شکست دارد ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 91 ] || fail "TESTS-COUNT: آزمون پایه کمتر از ۹۱ است ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد آزمون از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۷) آزمون منفیِ درون‌دروازه: اگر رمز خام برگردد، دروازه باید بایستد ─────
if [ -z "${F01_NOSELFCHECK:-}" ]; then
FX=$(mktemp /tmp/f01-gate-XXXXXX.js)
cp "$AUTH" "$FX"
printf '\n// password_plain: leak\n' >> "$FX"
F01_NOSELFCHECK=1 F01_AUTH="$FX" F01_OUT="$FAILDIR/f01-selfcheck.txt" F01_FAILDIR="$FAILDIR" F01_TESTS="$TESTS" \
  F01_INDEX="$INDEX" F01_DB="$DB" F01_CLIENT_APP="$CLIENT_APP" bash "$0" >/dev/null 2>&1 \
  && { rm -f "$FX" "$FAILDIR/f01-selfcheck.txt"; fail "NEGATIVE-SELF: بازگشت رمز خام دروازه را رد نکرد"; }
rm -f "$FX" "$FAILDIR/f01-selfcheck.txt"; ok
fi

{
  echo "# دروازهٔ ردیف F‑01 — رمزنگاری دادهٔ حساس و بستن نشت‌ها (P0)"
  echo "generated_by: docs/cloud/reports/evidence/gen-f01-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "checks_passed: $CHECKS"
  echo "F-01: CLOSED"
  echo
  echo "F01-CLOSED checks=$CHECKS tests=$TP"
} > "$OUT"
echo "→ $OUT"
echo "F01-CLOSED checks=$CHECKS tests=$TP"
