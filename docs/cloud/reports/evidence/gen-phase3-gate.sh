#!/usr/bin/env bash
# دروازهٔ فاز ۳ — «آیا پیش‌نیازهای ورود به فاز ۳ کامل و شاهددار است؟»
# fail-closed · هرگز دروازه را باز نمی‌کند: باز شدن فقط با تصمیم ثبت‌شدهٔ مالک (D‑34)
#
# اجرا: bash docs/cloud/reports/evidence/gen-phase3-gate.sh
# خروجی: docs/cloud/reports/evidence/phase3-gate.txt ⇒ PHASE3-GATE-READY (GATE_OPEN=0)
set -u
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${P3_OUT:-$D/phase3-gate.txt}"
CONST="${P3_CONST:-docs/00-PAYESH-CLOUD-CONSTITUTION.md}"
SNAP="${P3_SNAPSHOT:-$D/queue-state-snapshot.txt}"
D11="${P3_DOC11:-docs/cloud/11-gap-report.md}"
DOC04="${P3_DOC04:-docs/cloud/04-capacity-and-availability.md}"
DOC04B="${P3_DOC04B:-docs/cloud/04b-plan-caps-usage-model.md}"
DOC12="${P3_DOC12:-docs/cloud/12-multitenant-architecture.md}"
REV12="${P3_REV12:-docs/cloud/reports/REVIEW-12-CONDITIONS.md}"
BASE="${P3_BASE:-f2fc472}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"
CHECKS=0

fail() {
  echo "PHASE3-FAIL: $1" >&2
  { echo "# دروازهٔ فاز ۳ — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "${P3_FAILDIR:-$D}/phase3-gate.FAILED-$TS.txt"
  exit 1
}
ok() { CHECKS=$((CHECKS+1)); }

# ── ۰) پیش‌نیاز: پایهٔ ممیزی و کد محصول دست‌نخورده ──────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست"
PROD_N=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -c . || true)
[ "$PROD_N" = "0" ] || fail "PRODUCT-CHANGED: $PROD_N فایل محصول نسبت به $BASE تغییر کرده"; ok

# ── ۱) دروازهٔ فاز ۰: اسناد نیازمندی و اعداد ────────────────────────────────
for f in 01-scope-and-roles-matrix 01b-school-plan-subscription 02-scenarios 03-local-data-and-manager-backup 04-capacity-and-availability 04b-plan-caps-usage-model; do
  [ -f "docs/cloud/$f.md" ] || fail "PHASE0-DOC: docs/cloud/$f.md نیست"
  grep -q '✅' "docs/cloud/$f.md" || fail "PHASE0-DOC: $f هیچ معیار تأییدشده ندارد"
  ok
done
A04=$(grep -cE '^\| AC‑[0-9]+ \|' "$DOC04" || true)
[ "$A04" -ge 14 ] || fail "PHASE0-04: ماتریس ۰۴ فقط $A04 ردیف AC (باید ≥۱۴)"
grep -qE '^\| AC‑[0-9]+ \|[^✅]*$' "$DOC04" && fail "PHASE0-04: ردیف AC بدون ✅ در سند ۰۴"; ok
grep -qE 'D.32' "$DOC04B" || fail "PHASE0-04B: تصمیم O‑14 (D‑32) ثبت نشده"
grep -qE 'D.33' "$DOC04B" || fail "PHASE0-04B: تصمیم O‑18 (D‑33) ثبت نشده"; ok
grep -qE 'D.30' "$DOC04" || fail "PHASE0-04: تصمیم O‑06 (D‑30) ثبت نشده"; ok
grep -q '## ۲.۱' "$DOC04" || fail "PHASE0-04: خط پایهٔ اندازه‌گیری‌شده نیست"; ok

# ── ۲) دروازهٔ فاز ۱: گزارش شکاف + اتصال ادعا→شاهد ─────────────────────────
[ -f "$D11" ] || fail "PHASE1-DOC11: سند گزارش شکاف نیست"
grep -q '^## ۶\.' "$D11" || fail "PHASE1-DOC11: بند §۶ (دور بستن) نیست"
grep -q '۳۵٫۶' "$D11" || fail "PHASE1-DOC11: تطابق ۳۵٫۶٪ در سند نیست"; ok
bash docs/cloud/reports/evidence/gen-cc11-evidence.sh >"${P3_TMP_CC11:-/tmp/p3-cc11.txt}" 2>&1 \
  || fail "PHASE1-CC11: دروازهٔ اتصال ادعا→شاهد شکست خورد — $(tail -1 /tmp/p3-cc11.txt)"
grep -q '^CC11-OK$' "${P3_TMP_CC11:-/tmp/p3-cc11.txt}" || fail "PHASE1-CC11: خروجی CC11-OK نبود"; ok

# ── ۳) دروازهٔ فاز ۲: هفت سند طراحی + شرط‌ها ────────────────────────────────
for f in 12-multitenant-architecture 12b-owner-panel-boundaries 13-secure-cache-offline-queue 14-conflict-convergence 15-backup-recovery 16-ha-observability-cost 16b-tenant-provisioning-migration; do
  [ -f "docs/cloud/$f.md" ] || fail "PHASE2-DOC: docs/cloud/$f.md نیست"
  grep -q '✅' "docs/cloud/$f.md" || fail "PHASE2-DOC: $f معیار تأییدشده ندارد"
  ok
done
bash docs/cloud/reports/evidence/gen-cc12-closure.sh >"${P3_TMP_CC12:-/tmp/p3-cc12.txt}" 2>&1 \
  || fail "PHASE2-CC12: دروازهٔ بستن ردیف ۱۲ شکست خورد — $(tail -2 /tmp/p3-cc12.txt)"
grep -q 'CC12-CLOSURE-OK' "${P3_TMP_CC12:-/tmp/p3-cc12.txt}" || fail "PHASE2-CC12: خروجی CC12-CLOSURE-OK نبود"; ok
grep -qE 'CC.12.2.*PARTIAL' "$REV12" || fail "PHASE2-CC12-2: شرط باز CC‑12‑2 صریحاً PARTIAL نیست"; ok
grep -qE 'CC.12.2.*PARTIAL' "$DOC12" || fail "PHASE2-CC12-2: در سند ۱۲ هم باید PARTIAL بماند"; ok

# ── ۴) صف واقعی: هیچ ردیف باز نمانده ───────────────────────────────────────
[ -f "$SNAP" ] || fail "QUEUE-SNAPSHOT: فایل عکس صف نیست"
OPEN=$(grep -E '^open_rows: *[0-9]+$' "$SNAP" | tail -1 | sed -E 's/^open_rows: *//')
[ "${OPEN:-x}" = "0" ] || fail "QUEUE-OPEN: صف $OPEN ردیف باز دارد — دروازه نباید «آماده» اعلام شود"
DONE_ROWS=$(grep -cE '^row [^ ]+ [0-9a-f-]{36} Done$' "$SNAP" || true)
[ "$DONE_ROWS" -ge 4 ] || fail "QUEUE-SNAPSHOT: فقط $DONE_ROWS ردیف Done در عکس صف ثبت شده"
grep -q 'Status does_not_equal "Done"' "$SNAP" || fail "QUEUE-SNAPSHOT: کوئری مبدأ ثبت نشده"; ok
grep -q 'Status in {Review, Backlog, Ready, In Progress, Blocked}' "$SNAP" || fail "QUEUE-SNAPSHOT: کوئری دوم ثبت نشده"; ok

# ── ۵) قانون اساسی هم‌تراز با واقعیت ───────────────────────────────────────
grep -qE '^\| \*\*D.34\*\*' "$CONST" || fail "CONST-D34: تصمیم هم‌ترازی وضعیت ثبت نشده"; ok
STALE=$(awk '/^### وضعیت مأموریت‌ها/,/^### دروازهٔ فاز ۳/' "$CONST" | grep -cE '\*\*Review|\*\*Backlog' || true)
[ "$STALE" = "0" ] || fail "CONST-STALE: $STALE ردیف وضعیت هنوز Review/Backlog است"
grep -q 'دروازهٔ فاز ۳: پیش‌نیاز کامل' "$CONST" || fail "CONST-STATUS: خط وضعیت، آمادگی دروازه را اعلام نمی‌کند"; ok
grep -q 'دروازهٔ فاز ۳ — وضعیت اجرایی' "$CONST" || fail "CONST-GATEBLOCK: بخش «وضعیت اجرایی دروازهٔ فاز ۳» نیست"; ok
for m in 'CC.12.2' 'F.04' 'F.06'; do
  grep -qE "$m" "$CONST" || fail "CONST-RESIDUAL: مانع $m در سند ثبت نشده"
  ok
done
grep -q 'GATE_OPEN\|باز نشده' "$CONST" || fail "CONST-GATE-STATE: وضعیت «باز نشده» ثبت نشده"; ok

# ── ۶) شاهد آزمون محصول (۸۸/۰) ────────────────────────────────────────────
bash docs/cloud/reports/evidence/gen-audit-evidence.sh >"${P3_TMP_AUDIT:-/tmp/p3-audit.txt}" 2>&1 \
  || fail "EVIDENCE-GATE: دروازهٔ شاهد آزمون شکست خورد — $(tail -2 /tmp/p3-audit.txt)"
grep -q 'EVIDENCE-OK' "${P3_TMP_AUDIT:-/tmp/p3-audit.txt}" || fail "EVIDENCE-GATE: EVIDENCE-OK نبود"; ok

# ── خروجی: «آماده» ولی بسته ───────────────────────────────────────────────
{
  echo "# دروازهٔ فاز ۳ — آمادگی شاهدها (GATE_OPEN=0)"
  echo "generated_by: docs/cloud/reports/evidence/gen-phase3-gate.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_diff_files: $PROD_N"
  echo "checks_passed: $CHECKS"
  echo "queue_open_rows: $OPEN"
  echo "phase0_gate: PASS"
  echo "phase1_gate: PASS (CC11-OK)"
  echo "phase2_gate: PASS (CC12-CLOSURE-OK · شرط ۳/۴)"
  echo "tests: EVIDENCE-OK (88/0)"
  echo "residuals: CC-12-2(PARTIAL) F-04(P0) F-06(P0) security=UNKNOWN"
  echo "GATE_OPEN=0"
  echo "OWNER_DECISION_REQUIRED=1"
  echo
  echo "## مانع‌های ورود به فاز ۳ (باید به‌ترتیب بسته شوند)"
  echo "1) CC-12-2 — اجرای RLS از مسیر محصول (نیازمند تغییر server/)"
  echo "2) F-04 — کلید فضای ذخیره‌سازی در کلاینت (P0)"
  echo "3) F-06 — مسیر دوم نوشتن / هویت از شیء کلاینت (P0)"
  echo
  echo "PHASE3-GATE-READY"
} > "$OUT"
echo "→ $OUT"
echo "PHASE3-GATE-READY checks=$CHECKS open_rows=$OPEN gate_open=0"
