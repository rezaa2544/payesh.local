#!/usr/bin/env bash
# دروازهٔ دور بستن ردیف ۱۶ (CC‑16) — fail-closed
#
# چه چیزی را می‌سنجد:
#   ۰) پیش‌نیاز: پایهٔ ممیزی f2fc472 باید واقعاً در مخزن موجود باشد (شاخهٔ کم‌عمق نباید
#      «۰ فایل تغییر» جعلی بسازد) و diff محصول نسبت به آن باید ۰ فایل باشد.
#   ۱) پروب مدل: ۴۰ بررسی (ورودی اندازه‌گیری‌شده، بازمحاسبهٔ پهنای باند/لاگ/هزینه،
#      نگهبان‌های قیمت/SLA، پوشش ۱۴ معیار، هفت اصلاح R‑16، هم‌ترازی ۰۴/۱۵، تازگی شاهد).
#   ۲) شاهد رفتار امروز: بازتولید می‌شود و باید head=HEAD و EXPECTATIONS=ALL-MET باشد.
#   ۳) Manifest: هر برچسب لازم باید عیناً با ✓ آمده باشد و هیچ ✗ نباشد.
#   ۴) SUMMARY بدنه باید با شمارش واقعی و با تعداد Manifest بخواند.
#   ۵) ماتریس AC سند باید همان ۱۴ ردیف و حکم ۱۴/۱۴ باشد (سازگاری با gen-review-closure C8).
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc16-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/cc16-gate.txt ⇒ CC16-OK
# قاعده: هر شکست ⇒ exit≠0، CC16-FAIL، و شاهد سبز قبلی بازنویسی نمی‌شود.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC16_OUT:-$D/cc16-gate.txt}"
RAW="${CC16_RAW_DIR:-$D}"
MAN="${CC16_MANIFEST:-$D/cc16-required-labels.txt}"
BASE="${CC16_BASE:-f2fc472}"
DOC="${CC16_DOC:-docs/cloud/16-ha-observability-cost.md}"
PROBE="${CC16_PROBE_CMD:-node --experimental-sqlite --disable-warning=ExperimentalWarning $D/probe-16-model.cjs}"
RUNTIME="${CC16_RUNTIME_CMD:-bash $D/gen-mission-16-evidence.sh}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
FAILDIR="${CC16_FAILDIR:-$D}"
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"

fail() { # $1=code-lines
  local txt="$1"
  echo "CC16-FAIL: $txt" >&2
  {
    echo "# دروازهٔ CC‑16 — شکست"
    echo "head: $HEAD"
    echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "reason: $txt"
  } > "$FAILDIR/cc16-gate.FAILED-$TS.txt"
  exit 1
}

mkdir -p "$RAW"
RAW_MODEL="$RAW/cc16-raw-model.txt"
RAW_RUNTIME="$RAW/cc16-raw-runtime.txt"

# ── ۰) پیش‌نیاز: پایهٔ ممیزی موجود و diff محصول صفر ─────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست (clone کم‌عمق؟) — هر «۰ فایل تغییر» بی‌اعتبار است"
PROD_DIFF=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS 2>/dev/null) || fail "PRODUCT-DIFF-CMD: فرمان diff شکست خورد"
PROD_N=$(printf '%s\n' "$PROD_DIFF" | grep -c . || true)
[ "$PROD_N" = "0" ] || fail "PRODUCT-CHANGED: $PROD_N فایل محصول نسبت به $BASE تغییر کرده"
NON_PROD=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -c . || true)
[ "$NON_PROD" = "0" ] || fail "PRODUCT-STILL-CHANGED: $NON_PROD"

# ── ۱) اجرای پروب مدل ──────────────────────────────────────────────────────
bash -c "$PROBE" > "$RAW_MODEL" 2>&1
PROBE_RC=$?
[ "$PROBE_RC" = "0" ] || fail "MODEL-PROBE-EXIT=$PROBE_RC — جزئیات: $RAW_MODEL"

# ── ۲) بازتولید شاهد رفتار امروز ──────────────────────────────────────────
bash -c "$RUNTIME" > "$RAW_RUNTIME" 2>&1
RT_RC=$?
[ "$RT_RC" = "0" ] || fail "RUNTIME-EVIDENCE-EXIT=$RT_RC — جزئیات: $RAW_RUNTIME"
EV="$D/mission-16-observability-probe.txt"
[ -f "$EV" ] || fail "RUNTIME-EVIDENCE-MISSING: $EV"
EV_HEAD=$(sed -n 's/^head: *//p' "$EV" | head -1)
[ "$EV_HEAD" = "$HEAD" ] || fail "RUNTIME-STALE: head شاهد «$EV_HEAD» ≠ HEAD «$HEAD»"
grep -q '^EXPECTATIONS=ALL-MET$' "$EV" || fail "RUNTIME-EXPECTATIONS: shاهد رفتار امروز ALL-MET نیست"
grep -q '^exit=0$' "$EV" || fail "RUNTIME-EXIT: خط exit=0 در شاهد نیست"

# ── ۳) SUMMARY بدنه: شمارش واقعی ───────────────────────────────────────────
SUM=$(grep -E '^SUMMARY pass=[0-9]+ fail=[0-9]+ total=[0-9]+$' "$RAW_MODEL" | tail -1)
[ -n "$SUM" ] || fail "SUMMARY-MISSING در $RAW_MODEL"
SUM_P=$(printf '%s' "$SUM" | sed -E 's/.*pass=([0-9]+).*/\1/')
SUM_F=$(printf '%s' "$SUM" | sed -E 's/.*fail=([0-9]+).*/\1/')
SUM_T=$(printf '%s' "$SUM" | sed -E 's/.*total=([0-9]+).*/\1/')
LABELS=$(mktemp)
sed -n 's/^✓ //p' "$RAW_MODEL" | sed 's/  ::  .*$//' > "$LABELS"
trap 'rm -f "$LABELS"' EXIT
BODY_OK=$(grep -c . "$LABELS" || true)
BODY_BAD=$(grep -c '^✗ ' "$RAW_MODEL" || true)
[ "$BODY_BAD" = "0" ] || fail "BODY-CROSS: $BODY_BAD خط ✗ در بدنه"

# ── ۳.۱) هر برچسب لازم عیناً با ✓ آمده باشد ──────────────────────────────
MISSING=""
while IFS= read -r label; do
  [ -n "$label" ] || continue
  grep -Fqx "$label" "$LABELS" || { [ -n "$MISSING" ] && MISSING="$MISSING | "; MISSING="$MISSING$label"; }
done < "$MAN"
[ -z "$MISSING" ] || fail "LABEL-MISSING: $MISSING"

# ── ۳.۲) حساب SUMMARY با بدنه و با تعداد Manifest ────────────────────────
[ "$SUM_F" = "0" ] || fail "BODY-FAIL: $SUM_F بررسی ناموفق در بدنه"
[ "$SUM_P" = "$BODY_OK" ] || fail "SUMMARY-MISMATCH: SUMMARY pass=$SUM_P ولی بدنه $BODY_OK ✓"
[ "$SUM_T" = "$BODY_OK" ] || fail "SUMMARY-TOTAL: total=$SUM_T ≠ $BODY_OK"
[ "$SUM_T" = "$(grep -c . "$MAN" || true)" ] || fail "MANIFEST-COUNT: total=$SUM_T ≠ تعداد Manifest $(grep -c . "$MAN" || true)"

# ── ۵) ماتریس AC سند ۱۶ همان ۱۴ ردیف و حکم ۱۴/۱۴ ──────────────────────────
AC_N=$(grep -cE '^\| \*{0,2}AC' "$DOC" || true)
[ "$AC_N" = "14" ] || fail "AC-COUNT: $AC_N ردیف AC در سند ۱۶ (باید ۱۴)"
grep -q 'حکم: ۱۴/۱۴' "$DOC" || fail "AC-VERDICT: خط «حکم: ۱۴/۱۴» در سند ۱۶ نیست"

# ── موفق ───────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ CC‑16 — بازمحاسبهٔ مدل هزینه/ظرفیت و پوشش معیارهای ردیف ۱۶"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc16-evidence.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node -v)"
  echo "product_diff_files: $PROD_N"
  echo "non_product_changed: $NON_PROD"
  echo "runtime_evidence_head: $EV_HEAD"
  echo "model_probe_summary: $SUM"
  echo "labels_required: $(grep -c . "$MAN")  labels_verified: $BODY_OK  crossed: $BODY_BAD"
  echo "ac_rows: $AC_N  verdict: ۱۴/۱۴"
  echo "probe_sha256: $(sha256sum "$D/probe-16-model.cjs" | cut -d' ' -f1)"
  echo "manifest_sha256: $(sha256sum "$MAN" | cut -d' ' -f1)"
  echo "doc_sha256: $(sha256sum "$DOC" | cut -d' ' -f1)"
  echo
  echo "## بررسی‌های گذر‌کرده (عین برچسب‌های پروب)"
  grep '^✓ ' "$RAW_MODEL"
  echo
  echo "CC16-OK"
} > "$OUT"
echo "→ $OUT"
echo "CC16-OK"
grep -c '^✓ ' "$RAW_MODEL" | sed 's/^/checks_passed=/'
