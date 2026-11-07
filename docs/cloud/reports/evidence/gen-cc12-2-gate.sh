#!/usr/bin/env bash
# دروازهٔ شرط CC‑12‑2 — «آیا RLS واقعاً از مسیر محصول اجرا شده و شاهدش معتبر است؟»
# فاز ۳ · D‑35 · fail-closed: هر ادعای بی‌شاهد، عدد ناسازگار، هش ناهمخوان یا
# تغییر محصول بیرون از فهرست مجاز ⇒ شکست
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc12-2-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc12-2-gate.txt ⇒ CC12-2-CLOSED
set -u
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC122_OUT:-$D/cc12-2-gate.txt}"
RAW="${CC122_RAW:-$D/cc12-2-product-rls.txt}"
TESTS="${CC122_TESTS:-$D/mission-05-tests-run.log}"
DOC12="${CC122_DOC12:-docs/cloud/12-multitenant-architecture.md}"
REV12="${CC122_REV12:-docs/cloud/reports/REVIEW-12-CONDITIONS.md}"
CONST="${CC122_CONST:-docs/00-PAYESH-CLOUD-CONSTITUTION.md}"
HARNESS="${CC122_HARNESS:-$D/product-rls-path.cjs}"
RUNNER="${CC122_RUNNER:-$D/run-cc12-2-product-rls.sh}"
BASE="${CC122_BASE:-f2fc472}"
ALLOW="${CC122_ALLOW:-package.json package-lock.json server/index.js server/tenancy.js}"
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
FP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
CHECKS=0

fail() {
  echo "CC12-2-FAIL: $1" >&2
  { echo "# دروازهٔ CC‑12‑2 — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "${CC122_FAILDIR:-$D}/cc12-2-gate.FAILED-$TS.txt"
  exit 1
}
ok() { CHECKS=$((CHECKS+1)); }

[ -f "$RAW" ] || fail "RAW-MISSING: شاهد خام CC‑12‑2 نیست: $RAW"
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست"
[ -f "$HARNESS" ] || fail "HARNESS-MISSING: $HARNESS"
[ -f "$RUNNER" ] || fail "RUNNER-MISSING: $RUNNER"

# ── ۱) انتساب شاهد به همین درخت (اثر انگشت محصول، بدون docs/) ───────────────
RAWFP=$(grep -m1 '^# product_tree_sha256:' "$RAW" | awk '{print $3}')
[ -n "$RAWFP" ] || fail "RAW-NO-TREE: اثر انگشت محصول در سرصفحهٔ شاهد نیست"
[ "$RAWFP" = "$FP" ] || fail "RAW-TREE-MISMATCH: شاهد از درخت دیگری است (raw=$RAWFP head=$FP)"; ok

PGLINE=$(grep -m1 '^# postgres version:' "$RAW" | sed -E 's/^# postgres version: *//')
[ -n "$PGLINE" ] || fail "PG-VERSION: نسخهٔ PostgreSQL در شاهد نیست (شاهد باید از پایگاه‌دادهٔ واقعی باشد)"; ok
[ -f "$DOC12" ] && grep -qE 'CC.12.2' "$RAW" && ok

grep -q '^# product_path: .*server/tenancy\.js' "$RAW" || fail "RAW-PATH: شاهد مسیر محصول را اعلام نمی‌کند"; ok

# ── ۲) هش ابزارها همان چیزی است که در شاهد ثبت شده ─────────────────────────
H_HARNESS=$(sha256sum "$HARNESS" | cut -d' ' -f1)
R_HARNESS=$(grep -m1 '^# sha256(product-rls-path.cjs):' "$RAW" | awk '{print $3}')
[ "$H_HARNESS" = "$R_HARNESS" ] || fail "HARNESS-HASH: هش product-rls-path.cjs عوض شده (raw=$R_HARNESS now=$H_HARNESS)"; ok
H_RUNNER=$(sha256sum "$RUNNER" | cut -d' ' -f1)
R_RUNNER=$(grep -m1 '^# sha256(run-cc12-2-product-rls.sh):' "$RAW" | awk '{print $3}')
[ "$H_RUNNER" = "$R_RUNNER" ] || fail "RUNNER-HASH: هش runner عوض شده (raw=$R_RUNNER now=$H_RUNNER)"; ok

# ── ۳) سازگاری درونی بدنه: اعداد اعلام‌شده = خط‌های واقعی ───────────────────
TOTAL=$(grep -E '^TOTAL [0-9]+ · FAIL [0-9]+$' "$RAW" | tail -1)
[ -n "$TOTAL" ] || fail "TOTAL-MISSING: خط TOTAL در شاهد نیست"
T_N=$(printf '%s' "$TOTAL" | sed -E 's/^TOTAL ([0-9]+) .*/\1/')
T_F=$(printf '%s' "$TOTAL" | sed -E 's/^.* FAIL ([0-9]+)$/\1/')
P_LINES=$(grep -c '^PASS  ' "$RAW" || true)
F_LINES=$(grep -c '^FAIL  ' "$RAW" || true)
[ "$T_F" = "0" ] || fail "TOTAL-FAIL: شاهد FAIL=$T_F اعلام می‌کند"
[ "$F_LINES" = "0" ] || fail "FAIL-LINE: بدنهٔ شاهد $F_LINES خط FAIL دارد"
[ "$P_LINES" = "$T_N" ] || fail "TOTAL-MISMATCH: اعلام $T_N ولی $P_LINES ادعای PASS"
[ "$P_LINES" -ge 20 ] || fail "TOTAL-SMALL: فقط $P_LINES ادعا (باید ≥۲۰)"; ok

# ── ۴) همهٔ ادعاهای الزامی حاضرند و هیچ‌کدام حذف نشده ───────────────────────
for id in N0 N0b P1 P2 P3 P4 P5 P6 P7 P8 P9 P10 P11 P12 P13 P14 P15 P16 P17 P18; do
  grep -qE "^PASS  $id  " "$RAW" || fail "REQ-ASSERT: ادعای $id در شاهد نیست"
  ok
done

# ── ۵) نتیجهٔ اجرا و رگرسیون پایه ───────────────────────────────────────────
grep -q '^EXIT=0 ' "$RAW" || grep -q '^EXIT=0$' "$RAW" || fail "EXIT: خروجی اجرای RLS صفر نیست"
grep -q 'BASE_EXIT=0' "$RAW" || fail "BASE-EXIT: رگرسیون پایهٔ محصول صفر نیست"; ok
grep -q 'CC12-2-RLS-PATH-OK' "$RAW" || fail "VERDICT: خط حکم CC12-2-RLS-PATH-OK نیست"; ok

[ -f "$TESTS" ] || fail "BASE-TESTS-MISSING: شاهد آزمون پایه نیست"
grep -q '^SUMMARY pass=88 fail=0$' "$TESTS" || fail "BASE-TESTS: آزمون پایه ۸۸/۰ نیست"
grep -q '^EXIT=0$' "$TESTS" || fail "BASE-TESTS: خروجی آزمون پایه صفر نیست"
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
[ "$TFP" = "$FP" ] || fail "BASE-TESTS-TREE: شاهد آزمون از درخت دیگری است"; ok

# ── ۶) تغییر محصول: فقط فایل‌های اعلام‌شدهٔ D‑35 ─────────────────────────────
PROD_DIFF=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -c . || true)
[ "$PROD_DIFF" -gt 0 ] || fail "PRODUCT-UNCHANGED: هیچ فایل محصولی تغییر نکرده — مسیر محصول اثبات نشده"
OUTSIDE=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)
[ "$OUTSIDE" = "0" ] || fail "PRODUCT-SCOPE: $OUTSIDE فایل محصول بیرون از فهرست مجاز D‑35 تغییر کرده — $(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -vxF -f <(printf '%s\n' $ALLOW) | head -3 | tr '\n' ' ')"; ok

# ── ۷) کد محصول واقعاً همان مکانیزم را دارد ────────────────────────────────
grep -q "set_config('app.tenant_id'" server/tenancy.js || fail "CODE-CONTEXT: تنظیم زمینهٔ مستأجر در server/tenancy.js نیست"; ok
grep -q 'FORCE ROW LEVEL SECURITY' server/tenancy.js || fail "CODE-RLS: FORCE RLS در server/tenancy.js نیست"; ok
grep -q "nullif(current_setting('app.tenant_id', true), '')" server/tenancy.js || fail "CODE-POLICY: سیاست fail-closed در کد محصول نیست"; ok
grep -q '/api/cloud/tenancy/records' server/tenancy.js || fail "CODE-ROUTE: مسیر HTTP محصول در کد نیست"; ok
grep -q "p.startsWith('/api/cloud/tenancy/')" server/index.js || fail "CODE-MOUNT: مسیر در server/index.js سوار نشده"; ok

# ── ۸) هم‌ترازی اسناد با واقعیت ─────────────────────────────────────────────
grep -qE 'CC.12.2.*CLOSED' "$DOC12" || fail "DOC12-CLOSED: سند ۱۲ شرط CC‑12‑2 را CLOSED اعلام نمی‌کند"; ok
grep -q "$RAW\|cc12-2-product-rls.txt" "$DOC12" || fail "DOC12-EVIDENCE: شاهد در سند ۱۲ ارجاع نشده"; ok
grep -qE 'CC.12.2.*CLOSED' "$REV12" || fail "REVIEW12: به‌روزرسانی بسته شدن CC‑12‑2 در سند بازبینی نیست"; ok
grep -qE '^\| \*\*D.35\*\*' "$CONST" || fail "CONST-D35: تصمیم D‑35 ثبت نشده"; ok
grep -q 'دروازهٔ فاز ۳ باز است (D‑35)\|(D‑35)' "$CONST" || fail "CONST-GATE: وضعیت باز بودن دروازه با D‑35 ثبت نشده"
grep -qE 'F.04.*باز|فهرست مجاز' "$CONST" || fail "CONST-RESIDUAL: مانع‌های باز (F‑04/F‑06) ثبت نشده‌اند"; ok

# ── خروجی ───────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ CC‑12‑2 — اجرای RLS از مسیر محصول"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc12-2-gate.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $FP"
  echo "evidence: $RAW"
  echo "postgres: $PGLINE"
  echo "assertions: $P_LINES"
  echo "assertions_failed: $F_LINES"
  echo "product_diff_files: $PROD_DIFF"
  echo "product_scope_outside: $OUTSIDE"
  echo "product_path: server/tenancy.js + server/index.js (/api/cloud/tenancy/records)"
  echo "base_tests: 88/0"
  echo "checks_passed: $CHECKS"
  echo "CC-12-2: CLOSED"
  echo "residual_p0: F-04 F-06"
  echo "security: UNKNOWN"
  echo
  echo "CC12-2-CLOSED"
} > "$OUT"
echo "→ $OUT"
echo "CC12-2-CLOSED checks=$CHECKS assertions=$P_LINES product_diff=$PROD_DIFF outside=$OUTSIDE"
