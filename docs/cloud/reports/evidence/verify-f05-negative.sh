#!/usr/bin/env bash
# آزمون‌های منفیِ ردیف ۲۶ (F‑05) — هر حفاظ اگر برداشته شود، آزمون باید بشکند.
# اجرا: bash docs/cloud/reports/evidence/verify-f05-negative.sh
# خروجی سبز: docs/cloud/reports/evidence/f05-negative.txt ⇒ F05-NEGATIVE-OK checks=5
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="$D/f05-negative.txt"
CHECKS=0
TMPLOG=$(mktemp)
PRIS=""
cleanup() {
  for f in $PRIS; do [ -f "$f.pristine" ] && mv -f "$f.pristine" "$f"; done
  rm -f "$TMPLOG"
}
trap cleanup EXIT

mutate() { # $1=file $2=grep-pattern-must-appear  $3..=sed args
  local f="$1" pat="$2"; shift 2
  if [ ! -f "$f.pristine" ]; then cp "$f" "$f.pristine"; PRIS="$PRIS $f"; else cp "$f.pristine" "$f"; fi
  sed -i "$@" "$f"
  grep -q "$pat" "$f" || { echo "F05-NEGATIVE-FAIL: mutation did not apply: $f :: $*"; exit 1; }
}
restore_all() { for f in $PRIS; do cp "$f.pristine" "$f"; done; }

run_unit() { node --experimental-sqlite --disable-warning=ExperimentalWarning tests/run.js > "$TMPLOG" 2>&1; echo $?; }
run_pg()   { bash "$D/run-f05-product-tenancy.sh" > "$TMPLOG" 2>&1; echo $?; }

expect_fail() { # $1=name $2=unit|pg
  local code
  if [ "$2" = "unit" ]; then code=$(run_unit); else code=$(run_pg); fi
  restore_all
  if [ "$code" -eq 0 ]; then
    echo "F05-NEGATIVE-FAIL: $1 — با حذف حفاظ، آزمون سبز ماند"
    exit 1
  fi
  CHECKS=$((CHECKS + 1))
  echo "  ✓ $1 (exit=$code)"
}

echo "F05-NEGATIVE: ۵ حفاظ"

# N1 — RLS جدول محصول خاموش شود ⇒ آزمون F05-08 باید بشکند
mutate server/tenancy.js 'FORCE ROW LEVEL SECURITY' \
  -e '/ALTER TABLE ${PRODUCT_TABLE} ENABLE ROW LEVEL SECURITY/d' \
  -e '/ALTER TABLE ${PRODUCT_TABLE} FORCE ROW LEVEL SECURITY/d'
expect_fail "N1 خاموش‌کردن RLS روی جدول بدنهٔ محصول" pg

# N2 — پاک‌نکردن میدان‌های مستأجر از ورودی کلاینت ⇒ آزمون جعل باید بشکند
mutate server/tenant-context.js "function sanitize(data) { return data;" \
  -e 's/function sanitize(data) {/function sanitize(data) { return data;/'
expect_fail "N2 پذیرش school_id/tenant_id از کلاینت" unit

# N3 — مستأجر از بدنه/هدر به‌جای توکن ⇒ آزمون scope باید بشکند
mutate server/tenancy.js "body.tenant_id" \
  -e "s/const tid = claims.tid;/const tid = (body \&\& body.tenant_id) || (headers['x-tenant']) || claims.tid;/"
expect_fail "N3 گرفتن مستأجر از بدنه/هدر" pg

# N4 — نادیده گرفتن مستأجر در محاسبهٔ زمینه (همیشه مستأجر اول) ⇒ آزمون cross-tenant باید بشکند
mutate server/tenancy.js "11111111-1111-1111-1111-111111111111" \
  -e "s/await client.query(\"select set_config('app.tenant_id', \$1, true)\", \[String(tenantId)\]);/await client.query(\"select set_config('app.tenant_id', \$1, true)\", ['11111111-1111-1111-1111-111111111111']);/"
expect_fail "N4 نادیده‌گرفتن مستأجر در زمینهٔ تراکنش" pg

# N5 — rollback مهاجرت بدون محدودکردن به مستأجر ⇒ آزمون rollback باید بشکند
mutate scripts/tenancy-migrate-product.js "delete from product_records returning record_id" \
  -e 's/delete from product_records where tenant_id = $1 returning record_id/delete from product_records returning record_id/'
expect_fail "N5 rollback مستأجر-ناشناس" pg

{
  echo "# آزمون‌های منفیِ ردیف ۲۶ — tenancy/RLS بدنهٔ محصول"
  echo "generated_by: docs/cloud/reports/evidence/verify-f05-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "mutations: N1 rls-off, N2 accept-client-tenant, N3 tenant-from-body, N4 ignore-tenant-context, N5 unscoped-rollback"
  echo
  echo "F05-NEGATIVE-OK checks=$CHECKS"
} > "$OUT"
echo "→ $OUT"
echo "F05-NEGATIVE-OK checks=$CHECKS"
