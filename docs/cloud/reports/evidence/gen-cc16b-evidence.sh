#!/usr/bin/env bash
# دروازهٔ دور بستن ردیف ۱۶‑ب (CC‑16B) — fail-closed
#
# چه چیزی را می‌سنجد:
#   ۰) پیش‌نیاز: پایهٔ ممیزی f2fc472 در مخزن موجود باشد (شاخهٔ کم‌عمق نباید
#      «۰ فایل تغییر» جعلی بسازد) و diff محصول نسبت به آن صفر باشد.
#   ۱) شاهد رفتار امروز (probe-16b) بازتولید شود: head=HEAD و ALL-MET.
#   ۲) تمرین واقعی (drill-16b) با کد ۰ تمام شود و هیچ ✗ نداشته باشد.
#   ۳) بند MIGRATION_RUN عدد واقعی بدهد: records>0، bytes>0، duration ثبت‌شده.
#   ۴) دو مستأجر آزمایشی شناسهٔ متفاوت داشته باشند.
#   ۵) Manifest: هر برچسب لازم عیناً با ✓ آمده باشد و SUMMARY با شمارش بدنه بخواند.
#   ۶) ماتریس AC سند ۱۶‑ب همان ۱۲ ردیف و حکم ۱۲/۱۲ باشد (سازگاری C8).
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc16b-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/cc16b-gate.txt ⇒ CC16B-OK
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC16B_OUT:-$D/cc16b-gate.txt}"
RAW="${CC16B_RAW_DIR:-$D}"
MAN="${CC16B_MANIFEST:-$D/cc16b-required-labels.txt}"
BASE="${CC16B_BASE:-f2fc472}"
DOC="${CC16B_DOC:-docs/cloud/16b-tenant-provisioning-migration.md}"
DRILL="${CC16B_DRILL_CMD:-node --experimental-sqlite --disable-warning=ExperimentalWarning $D/drill-16b-provision-migrate.cjs}"
RUNTIME="${CC16B_RUNTIME_CMD:-bash $D/gen-mission-16b-evidence.sh}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"

fail() {
  local txt="$1"
  echo "CC16B-FAIL: $txt" >&2
  {
    echo "# دروازهٔ CC‑16B — شکست"
    echo "head: $HEAD"
    echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "reason: $txt"
  } > "${CC16B_FAILDIR:-$D}/cc16b-gate.FAILED-$TS.txt"
  exit 1
}

mkdir -p "$RAW"
RAW_DRILL="$RAW/cc16b-raw-drill.txt"
RAW_RT="$RAW/cc16b-raw-runtime.txt"

# ── ۰) پیش‌نیاز ────────────────────────────────────────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست (clone کم‌عمق؟) — هر «۰ فایل تغییر» بی‌اعتبار است"
PROD_N=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS 2>/dev/null | grep -c . || true)
[ "$PROD_N" = "0" ] || fail "PRODUCT-CHANGED: $PROD_N فایل محصول نسبت به $BASE تغییر کرده"

# ── ۱) شاهد رفتار امروز (اول؛ تازگی با HEAD سنجیده می‌شود) ─────────────────
bash -c "$RUNTIME" > "$RAW_RT" 2>&1 || fail "RUNTIME-EVIDENCE-EXIT≠0 — جزئیات: $RAW_RT"
EV="$D/mission-16b-tenant-probe.txt"
[ -f "$EV" ] || fail "RUNTIME-EVIDENCE-MISSING: $EV"
EV_HEAD=$(sed -n 's/^head: *//p' "$EV" | head -1)
[ "$EV_HEAD" = "$HEAD" ] || fail "RUNTIME-STALE: head شاهد «$EV_HEAD» ≠ HEAD «$HEAD»"
grep -q '^EXPECTATIONS=ALL-MET$' "$EV" || fail "RUNTIME-EXPECTATIONS: شاهد رفتار امروز ALL-MET نیست"
grep -q '^exit=0$' "$EV" || fail "RUNTIME-EXIT: خط exit=0 در شاهد نیست"
grep -q '^PRODUCT-DIFF=0$' "$EV" || fail "RUNTIME-PRODUCT-DIFF: شاهد رفتار امروز diff محصول را ۰ تأیید نکرد"

# ── ۲) اجرای تمرین واقعی ───────────────────────────────────────────────────
bash -c "$DRILL" > "$RAW_DRILL" 2>&1
RC=$?
[ "$RC" = "0" ] || fail "DRILL-EXIT=$RC — جزئیات: $RAW_DRILL"
grep -q '^✗ ' "$RAW_DRILL" && fail "DRILL-CROSS: خط ✗ در خروجی تمرین"

# ── ۳) Manifest ────────────────────────────────────────────────────────────
LABELS=$(mktemp)
trap 'rm -f "$LABELS"' EXIT
sed -n 's/^✓ //p' "$RAW_DRILL" | sed 's/  ::  .*$//' > "$LABELS"
SUMMARY=$(grep -E '^SUMMARY pass=[0-9]+ fail=[0-9]+ total=[0-9]+$' "$RAW_DRILL" | tail -1)
[ -n "$SUMMARY" ] || fail "SUMMARY-MISSING"
S_P=$(printf '%s' "$SUMMARY" | sed -E 's/.*pass=([0-9]+).*/\1/')
S_F=$(printf '%s' "$SUMMARY" | sed -E 's/.*fail=([0-9]+).*/\1/')
S_T=$(printf '%s' "$SUMMARY" | sed -E 's/.*total=([0-9]+).*/\1/')
BODY=$(grep -c . "$LABELS" || true)
MISSING=""
while IFS= read -r label; do
  [ -n "$label" ] || continue
  grep -Fqx "$label" "$LABELS" || { [ -n "$MISSING" ] && MISSING="$MISSING | "; MISSING="$MISSING$label"; }
done < "$MAN"
[ -z "$MISSING" ] || fail "LABEL-MISSING: $MISSING"
[ "$S_F" = "0" ] || fail "SUMMARY-FAIL: $S_F"
[ "$S_P" = "$BODY" ] || fail "SUMMARY-MISMATCH: pass=$S_P ولی بدنه $BODY ✓"
[ "$S_T" = "$(grep -c . "$MAN" || true)" ] || fail "MANIFEST-COUNT: total=$S_T ≠ $(grep -c . "$MAN" || true)"

# ── ۴) عدد واقعی تمرین: زمان/حجم/تعداد رکورد + دو مستأجر مستقل ────────────
RUNLINE=$(grep -E '^MIGRATION_RUN ' "$RAW_DRILL" | tail -1)
[ -n "$RUNLINE" ] || fail "MIGRATION-RUN-MISSING"
REC=$(printf '%s' "$RUNLINE" | sed -E 's/.*records=([0-9]+).*/\1/')
BYTES=$(printf '%s' "$RUNLINE" | sed -E 's/.*bytes_copied=([0-9]+).*/\1/')
DUR=$(printf '%s' "$RUNLINE" | sed -E 's/.*duration_ms=([0-9]+).*/\1/')
[ "${REC:-0}" -gt 0 ] 2>/dev/null || fail "MIGRATION-RECORDS: تعداد رکورد نامعتبر «$REC»"
[ "${BYTES:-0}" -gt 0 ] 2>/dev/null || fail "MIGRATION-BYTES: حجم نامعتبر «$BYTES»"
case "${DUR:-}" in ''|*[!0-9]*) fail "MIGRATION-DURATION: زمان اندازه‌گیری‌شده ثبت نشده («${DUR:-}»)";; esac
TA=$(sed -n 's/.*TENANT_A=\([a-z0-9]*\).*/\1/p' "$RAW_DRILL" | head -1)
TB=$(sed -n 's/.*TENANT_B=\([a-z0-9]*\).*/\1/p' "$RAW_DRILL" | head -1)
[ -n "$TA" ] && [ -n "$TB" ] || fail "TENANT-IDS: شناسهٔ مستأجرها در خروجی نیست"
[ "$TA" != "$TB" ] || fail "TENANT-COLLISION: دو مستأجر یک شناسه دارند"

# ── ۵) ماتریس AC سند ───────────────────────────────────────────────────────
AC_N=$(grep -cE '^\| \*{0,2}AC' "$DOC" || true)
[ "$AC_N" = "12" ] || fail "AC-COUNT: $AC_N ردیف AC در سند ۱۶‑ب (باید ۱۲)"
grep -q 'حکم: ۱۲/۱۲' "$DOC" || fail "AC-VERDICT: خط «حکم: ۱۲/۱۲» در سند نیست"

# ── موفق ───────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ CC‑16B — تمرین واقعی راه‌اندازی/مهاجرت/کلید/آرشیو روی مدرسهٔ موجود"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc16b-evidence.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node -v)"
  echo "product_diff_files: $PROD_N"
  echo "runtime_evidence_head: $EV_HEAD"
  echo "drill_summary: $SUMMARY"
  echo "labels_required: $(grep -c . "$MAN")  labels_verified: $BODY"
  echo "migration_run: $RUNLINE"
  echo "tenant_a: $TA  tenant_b: $TB"
  echo "ac_rows: $AC_N  verdict: ۱۲/۱۲"
  echo "drill_sha256: $(sha256sum "$D/drill-16b-provision-migrate.cjs" | cut -d' ' -f1)"
  echo "manifest_sha256: $(sha256sum "$MAN" | cut -d' ' -f1)"
  echo "doc_sha256: $(sha256sum "$DOC" | cut -d' ' -f1)"
  echo
  echo "## بررسی‌های گذر‌کرده (عین برچسب‌های تمرین)"
  grep '^✓ ' "$RAW_DRILL"
  echo
  echo "CC16B-OK"
} > "$OUT"
echo "→ $OUT"
echo "CC16B-OK"
grep -c '^✓ ' "$RAW_DRILL" | sed 's/^/checks_passed=/'
