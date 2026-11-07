#!/usr/bin/env bash
# دروازهٔ ردیف ۲۶ (F‑05) — tenant model + RLS بدنهٔ محصول
# fail-closed: نبود شاهد PostgreSQL، جعل tenant از بدنه، خاموشی RLS،
# rollback مستأجر-ناشناس، یا ناسازگاری درخت ⇒ شکست.
#
# اجرا: bash docs/cloud/reports/evidence/gen-f05-gate.sh
# خروجی سبز: docs/cloud/reports/evidence/cc-f05-gate.txt ⇒ F05-CLOSED
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${F05_OUT:-$D/cc-f05-gate.txt}"
FAILDIR="${F05_FAILDIR:-$D}"
TESTS="${F05_TESTS:-$D/mission-05-tests-run.log}"
PG="${F05_PG:-$D/f05-product-tenancy.txt}"
NEG="${F05_NEG:-$D/f05-negative.txt}"
TEN="${F05_TENANCY:-server/tenancy.js}"
CTX="${F05_CTX:-server/tenant-context.js}"
MIG="${F05_MIG:-scripts/tenancy-migrate-product.js}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "F05-FAIL: $1" >&2
  { echo "# دروازهٔ ردیف ۲۶ — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$FAILDIR/cc-f05-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۱) شاهد PostgreSQL واقعی ───────────────────────────────────────────────
[ -f "$PG" ] || fail "PG-MISSING: $PG"
grep -q 'F05-PG-OK checks=12' "$PG" || fail "PG-WITNESS: ۱۲ بررسی روی PostgreSQL سبز نیست"; ok
for i in 01 02 03 04 05 06 07 08 09 10 11 12; do
  grep -q "^PASS  F05-$i" "$PG" || fail "PG-CHECK: F05-$i در شاهد نیست"
done
ok
grep -q '^EXIT=0 BASE_EXIT=0' "$PG" || fail "PG-EXIT: اجرای شاهد ناموفق"; ok
grep -q 'F05-RLS-OK' "$PG" || fail "PG-MARK: نشانهٔ موفقیت نیست"; ok

# ── ۲) شاهد آزمون واحد ─────────────────────────────────────────────────────
[ -f "$TESTS" ] || fail "TESTS-MISSING: $TESTS"
grep -q 'F05-OK checks=13' "$TESTS" || fail "UNIT: بلوک F‑05 در شاهد آزمون نیست"; ok
TP=$(sed -n 's/^SUMMARY pass=\([0-9]*\) fail=\([0-9]*\)$/\1 \2/p' "$TESTS" | tail -1)
[ -n "$TP" ] || fail "TESTS-SUMMARY: خط SUMMARY نیست"
[ "$(echo "$TP" | awk '{print $2}')" = "0" ] || fail "TESTS-FAIL: شکست آزمون ($TP)"; ok
[ "$(echo "$TP" | awk '{print $1}')" -ge 94 ] || fail "TESTS-COUNT: کمتر از ۹۴ ($TP)"; ok
TFP=$(grep -m1 '^# product_tree_sha256:' "$TESTS" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
[ "$TFP" = "$HEADFP" ] || fail "TESTS-TREE: شاهد از درخت دیگری است (log=$TFP head=$HEADFP)"; ok

# ── ۳) جدول بدنهٔ محصول + RLS + نقش غیرمالک ────────────────────────────────
grep -q "PRODUCT_TABLE = 'product_records'" "$TEN" || fail "PRODUCT-TABLE: جدول بدنهٔ محصول نیست"; ok
grep -q 'ALTER TABLE ${PRODUCT_TABLE} ENABLE ROW LEVEL SECURITY' "$TEN" || fail "RLS-ENABLE: RLS روشن نیست"; ok
grep -q 'ALTER TABLE ${PRODUCT_TABLE} FORCE ROW LEVEL SECURITY' "$TEN" || fail "RLS-FORCE: FORCE RLS نیست"; ok
grep -q "USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)" "$TEN" \
  || fail "RLS-POLICY: سیاست USING نیست"; ok
grep -q 'ALTER TABLE ${PRODUCT_TABLE} OWNER TO ${OWNER_ROLE}' "$TEN" || fail "OWNER: مالک جدول نقش جدا نیست"; ok
grep -q 'ALTER TABLE ${JOBS_TABLE} FORCE ROW LEVEL SECURITY' "$TEN" || fail "JOBS-RLS: جدول کارها RLS ندارد"; ok

# ── ۴) مستأجر فقط از نشست ──────────────────────────────────────────────────
grep -q 'const tid = claims.tid;' "$TEN" || fail "TENANT-SESSION: مستأجر از توکن گرفته نمی‌شود"; ok
grep -q 'delete clean.tenant_id' "$TEN" || fail "TENANT-BODY: میدان tenant ورودی پاک نمی‌شود"; ok
grep -q 'delete clean.school_id' "$TEN" || fail "SCHOOL-BODY: میدان school ورودی پاک نمی‌شود"; ok
grep -q 'tenantCtx.stamp(incoming, actor)' server/sync.js || fail "SYNC-STAMP: همگام‌سازی مستأجر را مهر نمی‌کند"; ok
! grep -rq "body\.school_id\|op\.data\.school_id\|body\.tenant_id" server/*.js \
  || fail "CLIENT-TENANT: کد محصول school_id/tenant_id را از بدنه می‌خواند"; ok
grep -q 'function sanitize' "$CTX" || fail "CTX: ماژول زمینهٔ مستأجر نیست"; ok
grep -q 'TENANT_FIELDS' "$CTX" || fail "CTX-FIELDS: فهرست میدان‌های مستأجر نیست"; ok

# ── ۵) migration و rollback ────────────────────────────────────────────────
grep -q 'insert into product_records' "$MIG" || fail "MIGRATE: مهاجرت بدنه نوشته نشده"; ok
grep -q 'PAYESH_TENANCY_CONFIRM' "$MIG" || fail "ROLLBACK-CONFIRM: rollback بدون تأیید اجرا می‌شود"; ok
grep -q "where tenant_id = \$1 returning record_id" "$MIG" || fail "ROLLBACK-SCOPE: rollback به مستأجر محدود نیست"; ok
grep -q 'rollbackProduct' "$TEN" || fail "ROLLBACK-SCHEMA: rollback طرح وجود ندارد"; ok

# ── ۶) آزمون منفی ──────────────────────────────────────────────────────────
[ -f "$NEG" ] || fail "NEG-MISSING: $NEG"
grep -q 'F05-NEGATIVE-OK checks=5' "$NEG" || fail "NEG-FAIL: آزمون منفی سبز نیست"; ok

# ── ۷) آزمون منفیِ درون‌دروازه (RLS خاموش ⇒ شکست) ──────────────────────────
if [ -z "${F05_NOSELFCHECK:-}" ]; then
  FX=$(mktemp /tmp/f05-gate-XXXXXX.js)
  cp "$TEN" "$FX"
  sed -i '/ALTER TABLE ${PRODUCT_TABLE} FORCE ROW LEVEL SECURITY/d' "$FX"
  if ! grep -q 'ALTER TABLE ${PRODUCT_TABLE} FORCE ROW LEVEL SECURITY' "$FX"; then
    F05_TENANCY="$FX" F05_NOSELFCHECK=1 F05_OUT="$FAILDIR/f05-selfcheck.txt" F05_FAILDIR="$FAILDIR" \
      F05_TESTS="$TESTS" F05_PG="$PG" F05_NEG="$NEG" bash "$0" >/dev/null 2>&1 \
      && { rm -f "$FX" "$FAILDIR/f05-selfcheck.txt"; fail "NEGATIVE-SELF: RLS خاموش دروازه را رد نکرد"; }
    rm -f "$FAILDIR/f05-selfcheck.txt"
  fi
  rm -f "$FX"
fi
ok

# ── ۸) دروازه‌های پیشین نباید تضعیف شوند ───────────────────────────────────
for G in f01 f02 f04 f06 sync; do
  case $G in
    f01) MARK='F01-CLOSED' ;;
    f02) MARK='F02-CLOSED' ;;
    f04) MARK='F04-CLOSED' ;;
    f06) MARK='F06-CLOSED' ;;
    sync) MARK='SYNC-CLOSED' ;;
  esac
  bash "$D/gen-$G-gate.sh" >/dev/null 2>&1 || fail "REGRESSION: دروازهٔ $G سبز نیست"
  grep -q "$MARK" "$D/cc-$G-gate.txt" || fail "REGRESSION-MARK: $MARK نیست"
  ok
done

{
  echo "# دروازهٔ ردیف ۲۶ — tenancy/RLS بدنهٔ محصول (F‑05)"
  echo "generated_by: docs/cloud/reports/evidence/gen-f05-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_tree_sha256: $HEADFP"
  echo "tests: $TP"
  echo "postgres_witness: PASS F05-01..F05-12 (F05-PG checks=12 pass=12 fail=0)"
  echo "negatives: 5"
  echo "checks_passed: $CHECKS"
  echo "row-26: CLOSED"
  echo
  echo "F05-CLOSED checks=$CHECKS tests=$TP pg=12/12 negatives=5"
} > "$OUT"
echo "→ $OUT"
echo "F05-CLOSED checks=$CHECKS tests=$TP pg=12/12 negatives=5"
