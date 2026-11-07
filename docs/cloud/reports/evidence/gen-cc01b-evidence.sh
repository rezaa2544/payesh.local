#!/usr/bin/env bash
# دروازهٔ دور بستن ردیف ۰۱‑ب (CC‑01B) — fail-closed
#
# چه چیزی را می‌سنجد:
#   ۰) پیش‌نیاز: پایهٔ ممیزی f2fc472 در مخزن باشد و diff محصول نسبت به آن صفر.
#   ۱) پروب قیدهای طرح (probe-01b-schema) دوباره اجرا شود و الگوی مورد انتظار
#      را بدهد: N2/N3/N3c/N4/N5/N5c موفق · N3b/N4b/N5b ردِ درست.
#   ۲) تمرین واقعی چرخهٔ وضعیت (drill-01b) با کد ۰ تمام شود و ✗ نداشته باشد.
#   ۳) بند LIFECYCLE_RUN عدد بدهد: ۱۳ گذار مجاز · ۳ گذار ممنوع آزموده · ۱۲ پیام ·
#      سقف‌های ۳۰۰/۲۵۰/۲۰۴۸ · duration_ms عددی>۰.
#   ۴) Manifest: هر برچسب لازم عیناً با ✓ آمده باشد و SUMMARY با بدنه بخواند.
#   ۵) سند ۰۱‑ب: ۱۲ ردیف AC · «حکم: ۱۲/۱۲» · §۹ با ۴ تصمیم باز و جملهٔ
#      «هیچ‌کدام مانع بستن ۰۱‑ب نیست» · §۱۱ بند دور بستن.
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc01b-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/cc01b-gate.txt ⇒ CC01B-OK
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC01B_OUT:-$D/cc01b-gate.txt}"
RAW="${CC01B_RAW_DIR:-$D}"
MAN="${CC01B_MANIFEST:-$D/cc01b-required-labels.txt}"
BASE="${CC01B_BASE:-f2fc472}"
DOC="${CC01B_DOC:-docs/cloud/01b-school-plan-subscription.md}"
DRILL="${CC01B_DRILL_CMD:-node --experimental-sqlite --disable-warning=ExperimentalWarning $D/drill-01b-subscription-lifecycle.cjs}"
PROBE="${CC01B_PROBE_CMD:-node --experimental-sqlite --disable-warning=ExperimentalWarning $D/probe-01b-schema.cjs}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"

fail() {
  local txt="$1"
  echo "CC01B-FAIL: $txt" >&2
  {
    echo "# دروازهٔ CC‑01B — شکست"
    echo "head: $HEAD"
    echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "reason: $txt"
  } > "${CC01B_FAILDIR:-$D}/cc01b-gate.FAILED-$TS.txt"
  exit 1
}

mkdir -p "$RAW"
RAW_DRILL="$RAW/cc01b-raw-drill.txt"
RAW_PROBE="$RAW/cc01b-raw-probe.txt"

# ── ۰) پیش‌نیاز ────────────────────────────────────────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست (clone کم‌عمق؟) — هر «۰ فایل تغییر» بی‌اعتبار است"
PROD_N=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS 2>/dev/null | grep -c . || true)
[ "$PROD_N" = "0" ] || fail "PRODUCT-CHANGED: $PROD_N فایل محصول نسبت به $BASE تغییر کرده"

# ── ۱) پروب قیدهای طرح §۲ (الگوی مورد انتظار) ──────────────────────────────
bash -c "$PROBE" > "$RAW_PROBE" 2>&1 || fail "PROBE-EXIT≠0 — جزئیات: $RAW_PROBE"
for okline in "N2" "N3 " "N3c" "N4 " "N5 " "N5c"; do
  grep -q "^\[OK\]   ${okline}" "$RAW_PROBE" || fail "PROBE-EXPECTED-OK: خط [OK] «${okline}» در پروب نیست"
done
grep -q '^\[ERR\]  N3b' "$RAW_PROBE" || fail "PROBE-EXPECTED-REJECT: دو مجوز باز هم‌زمان باید رد شود (N3b)"
grep -q '^\[ERR\]  N4b' "$RAW_PROBE" || fail "PROBE-EXPECTED-REJECT: نقض سقف ۷۲ ساعت باید رد شود (N4b)"
grep -q '^\[ERR\]  N5b' "$RAW_PROBE" || fail "PROBE-EXPECTED-REJECT: دو اشتراک جاری باید رد شود (N5b)"

# ── ۲) اجرای تمرین واقعی چرخهٔ وضعیت ───────────────────────────────────────
bash -c "$DRILL" > "$RAW_DRILL" 2>&1
RC=$?
[ "$RC" = "0" ] || fail "DRILL-EXIT=$RC — جزئیات: $RAW_DRILL"
grep -q '^✗ ' "$RAW_DRILL" && fail "DRILL-CROSS: خط ✗ در خروجی تمرین"

# ── ۳) Manifest و حساب SUMMARY ─────────────────────────────────────────────
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

# ── ۴) اعداد واقعی تمرین ───────────────────────────────────────────────────
RUNLINE=$(grep -E '^LIFECYCLE_RUN ' "$RAW_DRILL" | tail -1)
[ -n "$RUNLINE" ] || fail "LIFECYCLE-RUN-MISSING"
AL=$(printf '%s' "$RUNLINE" | sed -E 's/.*transitions_allowed=([0-9]+).*/\1/')
FB=$(printf '%s' "$RUNLINE" | sed -E 's/.*forbidden=([0-9]+).*/\1/')
MS=$(printf '%s' "$RUNLINE" | sed -E 's/.*msgs=([0-9]+).*/\1/')
DUR=$(printf '%s' "$RUNLINE" | sed -E 's/.*duration_ms=([0-9]+).*/\1/')
[ "${AL:-0}" = "13" ] || fail "TRANSITIONS-ALLOWED: $AL ≠ ۱۳ گذار جدول §۳.۱"
[ "${FB:-0}" -ge 3 ] 2>/dev/null || fail "FORBIDDEN-TRANSITIONS: $FB کمتر از ۳ گذار ممنوع آزموده‌شده"
[ "${MS:-0}" = "12" ] || fail "MESSAGES: $MS ≠ ۱۲ کد پیام §۷"
case "${DUR:-}" in ''|*[!0-9]*) fail "DURATION: زمان اندازه‌گیری‌شده ثبت نشده («${DUR:-}»)";; esac
[ "${DUR:-0}" -gt 0 ] 2>/dev/null || fail "DURATION: زمان صفر است"
printf '%s' "$RUNLINE" | grep -q 'quota_cap=300/250/2048' || fail "QUOTA-CAP: سقف‌های آزموده‌شده در خروجی نیست — $RUNLINE"
SUB=$(grep -E '^SUB_STATE ' "$RAW_DRILL" | tail -1)
[ -n "$SUB" ] || fail "SUB-STATE-MISSING"
printf '%s' "$SUB" | grep -Eq 'events=[1-9][0-9]*' || fail "SUB-STATE-EVENTS: هیچ رویداد گذاری ثبت نشد — $SUB"

# ── ۵) سند ۰۱‑ب ────────────────────────────────────────────────────────────
AC_N=$(grep -cE '^\| \*{0,2}AC' "$DOC" || true)
[ "$AC_N" = "12" ] || fail "AC-COUNT: $AC_N ردیف AC در سند ۰۱‑ب (باید ۱۲)"
grep -q 'حکم: ۱۲/۱۲' "$DOC" || fail "AC-VERDICT: خط «حکم: ۱۲/۱۲» در سند نیست"
grep -q 'هیچ‌کدام مانع بستن ۰۱‑ب نیست' "$DOC" || fail "OPEN-DECISIONS: جملهٔ «هیچ‌کدام مانع بستن ۰۱‑ب نیست» در §۹ نیست"
P_N=$(grep -cE '^\| \*\*P‑01b‑' "$DOC" || true)
[ "$P_N" = "4" ] || fail "OPEN-DECISIONS-COUNT: $P_N ردیف P‑01b (باید ۴)"
grep -q '^## ۱۱\.' "$DOC" || fail "DOC-CLOSURE: بند §۱۱ (دور بستن شرط) در سند ۰۱‑ب نیست"

# ── موفق ───────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ CC‑01B — تمرین واقعی مدل مدرسه/پلن/اشتراک و چرخهٔ وضعیت"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc01b-evidence.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node -v)"
  echo "product_diff_files: $PROD_N"
  echo "schema_probe: ok_lines=6 reject_lines=3"
  echo "drill_summary: $SUMMARY"
  echo "labels_required: $(grep -c . "$MAN")  labels_verified: $BODY"
  echo "lifecycle_run: $RUNLINE"
  echo "sub_state: $SUB"
  echo "open_decisions: $P_N (P‑01b‑۱..۴ — هیچ‌کدام مانع بستن نیست)"
  echo "ac_rows: $AC_N  verdict: ۱۲/۱۲"
  echo "drill_sha256: $(sha256sum "$D/drill-01b-subscription-lifecycle.cjs" | cut -d' ' -f1)"
  echo "manifest_sha256: $(sha256sum "$MAN" | cut -d' ' -f1)"
  echo "doc_sha256: $(sha256sum "$DOC" | cut -d' ' -f1)"
  echo
  echo "## بررسی‌های گذر‌کرده (عین برچسب‌های تمرین)"
  grep '^✓ ' "$RAW_DRILL"
  echo
  echo "CC01B-OK"
} > "$OUT"
echo "→ $OUT"
echo "CC01B-OK"
grep -c '^✓ ' "$RAW_DRILL" | sed 's/^/checks_passed=/'
