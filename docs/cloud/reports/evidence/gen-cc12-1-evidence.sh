#!/usr/bin/env bash
# دروازهٔ شرط CC-12-1 (ردیف ۱۲ — بازتولیدپذیری نتیجهٔ RLS) — FAIL-CLOSED
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc12-1-evidence.sh
# ورودی: docs/cloud/reports/evidence/mission-12-cc1-rls-repro.txt  (خروجی خام rls-execution-test.sh)
# خروجی موفق: docs/cloud/reports/evidence/cc12-1-gate.txt  ⇒  CC12-1-OK
# خروجی ناموفق: همان فایل با CC12-1-FAIL + exit 1 (هیچ ادعای سبز بی‌شاهد چاپ نمی‌شود)
#
# قرارداد:
#   1) فایل شاهد خام باید وجود داشته باشد                                  (exit 3)
#   2) EXIT=0 و «TOTAL 14 · FAIL 0» باید در بدنه باشد
#   3) تعداد واقعی خطوط PASS/FAIL از بدنه شمرده و با TOTAL مقایسه می‌شود   (شاهد ساختگی رد می‌شود)
#   4) نسخهٔ PostgreSQL باید در سرصفحه ثبت شده باشد (بازتولیدپذیری محیط)
#   5) هش SHA-256 اسکریپت‌های آزمون باید با سرصفحه بخواند (شاهد متعلق به همین ابزار باشد)
#   6) اثر انگشت درخت محصول در سرصفحه باید با HEAD فعلی بخواند (بدون تغییر کد محصول)
#
# متغیرهای اختیاری برای آزمون منفی:
#   CC12_EVIDENCE=<path>   مسیر شاهد خام (پیش‌فرض: فایل بالا)
#   CC12_GATE_OUT=<path>   مسیر خروجی دروازه (پیش‌فرض: cc12-1-gate.txt ؛ /dev/null مجاز)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

EV=${CC12_EVIDENCE:-docs/cloud/reports/evidence/mission-12-cc1-rls-repro.txt}
OUT=${CC12_GATE_OUT:-docs/cloud/reports/evidence/cc12-1-gate.txt}
CJS=docs/cloud/reports/evidence/rls-execution-test.cjs
SH=docs/cloud/reports/evidence/rls-execution-test.sh

RC=0
CHECKS=""
fail() { RC=1; CHECKS="${CHECKS}FAIL  $1"$'\n'; echo "CC12-1-FAIL: $1" >&2; }
ok()   { CHECKS="${CHECKS}PASS  $1"$'\n'; }

if [ ! -f "$EV" ]; then
  echo "CC12-1-FAIL: evidence not found: $EV" >&2
  echo "  run: RLS_TEST_OUT=$EV bash docs/cloud/reports/evidence/rls-execution-test.sh" >&2
  { echo "# دروازهٔ CC-12-1 — BLOCKED"; echo "BLOCKED  evidence not found: $EV"; } > "$OUT" 2>/dev/null || true
  exit 3
fi

# ---------- ۱) EXIT=0 ----------
EXITC=$(grep -o '^EXIT=[0-9]*' "$EV" | tail -1 | cut -d= -f2)
if [ "${EXITC:-x}" = "0" ]; then ok "EXIT=0"; else fail "EXIT=${EXITC:-missing} (must be 0)"; fi

# ---------- ۲) خط TOTAL ----------
if grep -qF 'TOTAL 14 · FAIL 0' "$EV"; then ok "declared: TOTAL 14 · FAIL 0"; else fail "missing declared line 'TOTAL 14 · FAIL 0'"; fi
DECL_TOTAL=$(grep -o 'TOTAL [0-9]* · FAIL [0-9]*' "$EV" | tail -1 | sed -E 's/TOTAL ([0-9]+).*/\1/')
DECL_FAIL=$(grep -o 'TOTAL [0-9]* · FAIL [0-9]*' "$EV" | tail -1 | sed -E 's/.*FAIL ([0-9]+)/\1/')

# ---------- ۳) شمارش واقعی بدنه ----------
PASSES=$(grep -c '^PASS  N' "$EV" || true)
FAILS=$(grep -c '^FAIL  N' "$EV" || true)
[ -z "${PASSES:-}" ] && PASSES=0
[ -z "${FAILS:-}" ] && FAILS=0
if [ "${FAILS:-0}" -eq 0 ]; then ok "body has 0 failing assertion line"; else fail "body has $FAILS failing assertion line(s)"; fi
if [ "${PASSES:-0}" -eq 14 ]; then ok "body has 14 passing assertion lines"; else fail "body has $PASSES passing assertion lines (expected 14)"; fi
if [ "${DECL_TOTAL:-x}" = "$PASSES" ]; then ok "declared total ($DECL_TOTAL) matches body ($PASSES)"; else fail "declared total ($DECL_TOTAL) ≠ body ($PASSES) — forged or truncated evidence"; fi
if [ "${DECL_FAIL:-x}" = "$FAILS" ]; then ok "declared fail ($DECL_FAIL) matches body ($FAILS)"; else fail "declared fail ($DECL_FAIL) ≠ body ($FAILS)"; fi

# ---------- ۴) نسخهٔ PostgreSQL ----------
PGVER=$(grep -m1 '^# postgres version:' "$EV" | sed 's/^# postgres version: *//')
if echo "$PGVER" | grep -Eq '^[0-9]+(\.[0-9]+)*$'; then
  ok "postgres version recorded: $PGVER"
else
  fail "postgres version missing or malformed ('${PGVER:-none}')"
fi
# نسخهٔ اعلام‌شده در اجرای واقعی (خط 'postgres: PostgreSQL x.y' که خود آزمون چاپ می‌کند)
LIVER=$(grep -m1 '^postgres: PostgreSQL ' "$EV" | sed 's/^postgres: //')
if [ -n "${LIVER:-}" ] && [ "$LIVER" = "PostgreSQL $PGVER" ]; then
  ok "header version matches the live server reported by the test ($LIVER)"
else
  fail "header postgres version ('${PGVER:-none}') does not match live server ('${LIVER:-none}')"
fi

# ---------- ۵) هش ابزار آزمون ----------
HDRCJS=$(grep -m1 '^# sha256(rls-execution-test.cjs):' "$EV" | awk '{print $3}')
HDRSH=$(grep -m1 '^# sha256(rls-execution-test.sh):' "$EV" | awk '{print $3}')
NOWCJS=$(sha256sum "$CJS" | cut -d' ' -f1)
NOWSH=$(sha256sum "$SH" | cut -d' ' -f1)
if [ -n "${HDRCJS:-}" ] && [ "$HDRCJS" = "$NOWCJS" ]; then ok "harness .cjs hash matches ($NOWCJS)"; else fail "harness .cjs hash mismatch: header=${HDRCJS:-none} now=$NOWCJS"; fi
if [ -n "${HDRSH:-}" ] && [ "$HDRSH" = "$NOWSH" ]; then ok "harness .sh hash matches ($NOWSH)"; else fail "harness .sh hash mismatch: header=${HDRSH:-none} now=$NOWSH (evidence produced by a different script version)"; fi

# ---------- ۶) اثر انگشت کد محصول ----------
HDRFP=$(grep -m1 '^# product_tree_sha256:' "$EV" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d' ' -f1)
if [ -n "${HDRFP:-}" ] && [ "$HDRFP" = "$HEADFP" ]; then ok "product tree fingerprint matches HEAD ($HEADFP)"; else fail "product tree mismatch: header=${HDRFP:-none} head=$HEADFP"; fi

# ---------- خروجی ----------
{
  echo "# دروازهٔ شرط CC-12-1 (ردیف ۱۲) — بازتولیدپذیری نتیجهٔ RLS"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc12-1-evidence.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# شاهد خام: $EV"
  echo
  printf '%s' "$CHECKS"
  echo
  if [ "$RC" = "0" ]; then
    echo "CC12-1-OK  assertions=14  fail=0  postgres=\"$LIVER\"  product_tree=$HEADFP"
  else
    echo "CC12-1-FAIL"
  fi
} > "$OUT"

if [ "$RC" = "0" ]; then
  echo "CC12-1-OK — RLS isolation reproduced: 14/14 on $LIVER; harness hashes and product fingerprint verified"
  echo "→ $OUT"
  exit 0
fi
echo "CC12-1-FAIL — see $OUT" >&2
exit 1
