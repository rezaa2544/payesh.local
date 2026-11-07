#!/usr/bin/env bash
# دروازهٔ ردیف F‑04 (P0) — «هیچ کلید صندوقچه‌ای به کلاینت/باندل/پاسخ‌ها نمی‌رسد»
# fail-closed: هر نشت، هر پاسخ کلیددار، هر تیکتِ بی‌انقضا یا هر شاهدِ ناسازگار ⇒ شکست
#
# اجرا: bash docs/cloud/reports/evidence/gen-f04-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-f04-gate.txt ⇒ F04-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${F04_OUT:-$D/cc-f04-gate.txt}"
TESTS="${F04_TESTS:-$D/mission-05-tests-run.log}"
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"
ALLOW="${F04_ALLOW:-package.json package-lock.json server/index.js server/tenancy.js server/outbox.js server/cloud-defaults.js server/s3mem.js client/app.js client/pages.js client/lib/phone.js client/lib/s3mini.js client/lib/sigv4.js client/cloud-baked.js tests/run.js tests/phone-flow.js scripts/bake-cloud.mjs}"
BASE="${F04_BASE:-f2fc472}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "F04-FAIL: $1" >&2
  { echo "# دروازهٔ F‑04 — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "${F04_FAILDIR:-$D}/cc-f04-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۱) کد و باندل ───────────────────────────────────────────────────────────
node scripts/bake-cloud.mjs --check >/dev/null 2>&1 || fail "DEFAULTS-KEYS: کلید در server/cloud-defaults.js هست"; ok

for f in client/cloud-baked.js client/lib/phone.js client/app.js client/pages.js; do
  [ -f "$f" ] || fail "MISSING: $f"
done
if grep -qE "accessKey[[:space:]]*:[[:space:]]*[\"'][A-Za-z0-9/+]{12,}" client/cloud-baked.js; then
  fail "BUNDLE-KEY: کلید در باندل پخته‌شده"
fi; ok
if grep -qE "PAYESH_CLOUD\.(accessKey|secret)" client/*.js client/lib/*.js; then
  fail "CLIENT-KEY: ماژول کلاینت از کلید باندل می‌خواند"
fi; ok
if grep -q "localStorage.setItem('payesh.cloudcfg'" client/app.js; then
  fail "LOCALSTORAGE-KEY: پیکربندی صندوقچه در حافظهٔ مرورگر ذخیره می‌شود"
fi; ok
grep -q "localStorage.removeItem('payesh.cloudcfg')" client/app.js \
  || fail "LOCALSTORAGE-CLEANUP: پاک‌سازی مقدار قدیمی نیست"; ok

# ── ۲) پاسخ‌های HTTP کلید نمی‌دهند ─────────────────────────────────────────
grep -q "upload: 'server'" server/index.js || fail "API-UPLOAD: مسیر ابری «نوشتن فقط از سرور» را اعلام نمی‌کند"; ok
grep -q "reveal_allowed: false" server/index.js || fail "API-REVEAL: بازخوانی کلید در پنل مدیر بسته نشده"; ok
if sed -n '/api\/cloud\/config/,/^  }/p' server/index.js | grep -qE "accessKey:|secret:"; then
  fail "API-CLOUD-KEYS: پاسخ /api/cloud/config هنوز کلید/راز دارد"
fi; ok
if sed -n "/api\/phone\/config/,/^  }/p" server/index.js | grep -qE "accessKey:|secret:"; then
  fail "API-PHONE-KEYS: پاسخ /api/phone/config هنوز کلید/راز دارد"
fi; ok
grep -q 'presign(' server/index.js || fail "TICKET: تیکت کوتاه‌عمر صادر نمی‌شود"; ok
grep -q "PHONE_TICKET_TTL" server/index.js || fail "TICKET-TTL: عمر تیکت محدود نشده"; ok

# ── ۳) شاهد آزمون: F‑04 سبز و آزمون پایه بدون شکست ─────────────────────────
[ -f "$TESTS" ] || fail "TESTS-MISSING: $TESTS"
grep -q 'F04-OK checks=35' "$TESTS" || fail "F04-TEST: آزمون F‑04 در شاهد اجرا نیست"; ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: آزمون پایه شکست دارد ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 88 ] || fail "TESTS-COUNT: آزمون پایه کمتر از ۸۸ است ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد آزمون از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۴) آزمون منفی: اگر کلید به پیش‌فرض‌ها برگردد، ساخت می‌ایستد ──────────────
FX=$(mktemp /tmp/f04-gate-XXXXXX.cjs)
printf 'module.exports = { DEFAULTS: { endpoint: "https://x", region: "r", accessKey: "AKIAEXAMPLE123456", secret: "S3CRET" } };\n' > "$FX"
node scripts/bake-cloud.mjs --check "$FX" >/dev/null 2>&1
RC=$?
rm -f "$FX"
[ "$RC" = "2" ] || fail "NEGATIVE: کلید در پیش‌فرض‌ها ساخت را متوقف نکرد (exit=$RC)"; ok

# ── ۵) هیچ نشتی از کلید قدیمی در فایل‌های ردیابی‌شده ────────────────────────
# کلیدهای «نمونه»ی خودِ AWS در آزمون‌ها (…EXAMPLE) حساب نمی‌شوند
LEAK=$(git grep -I -n -E "997cc6ad|AKIA[A-Z0-9]{12,}" -- . ':!docs' ':!*.log' | grep -v 'EXAMPLE' || true)
[ -z "$LEAK" ] || fail "LEAK: نشانهٔ کلید در فایل‌های ردیابی‌شده → $(echo "$LEAK" | head -2 | tr '\n' ' ')"; ok

# ── ۶) دامنهٔ تغییر محصول همان فهرست مجاز است ───────────────────────────────
PROD_DIFF=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -c . || true)
[ "$PROD_DIFF" -gt 0 ] || fail "PRODUCT-UNCHANGED: هیچ فایل محصولی تغییر نکرده"; ok
OUTSIDE=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)
[ "$OUTSIDE" = "0" ] || fail "PRODUCT-SCOPE: $OUTSIDE فایل محصول بیرون از فهرست مجاز"; ok

{
  echo "# دروازهٔ F‑04 — حذف افشای کلید S3 از کلاینت/API (P0 · D‑23)"
  echo "generated_by: docs/cloud/reports/evidence/gen-f04-gate.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "product_diff_files: $PROD_DIFF"
  echo "product_scope_outside: $OUTSIDE"
  echo "checks_passed: $CHECKS"
  echo "F-04: CLOSED"
  echo
  echo "F04-CLOSED checks=$CHECKS product_diff=$PROD_DIFF outside=$OUTSIDE"
} > "$OUT"
echo "→ $OUT"
echo "F04-CLOSED checks=$CHECKS product_diff=$PROD_DIFF outside=$OUTSIDE"
