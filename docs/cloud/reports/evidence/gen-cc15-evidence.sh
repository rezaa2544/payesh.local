#!/usr/bin/env bash
# دروازهٔ دور بستن ردیف ۱۵ (CC‑15) — fail-closed
#
# چه چیزی را می‌سنجد:
#   ۰) پیش‌نیاز: پایهٔ ممیزی f2fc472 در مخزن موجود باشد (clone کم‌عمق نباید
#      «۰ فایل تغییر» جعلی بسازد) و diff محصول نسبت به آن صفر باشد.
#   ۱) شاهد رفتار امروز (probe-15) بازتولید شود: head=HEAD، ALL-MET، PRODUCT-DIFF=0.
#   ۲) تمرین واقعی بکاپ/فاجعه/بازیابی (drill-15) با کد ۰ تمام شود و ✗ نداشته باشد.
#   ۳) بند BACKUP_RUN عدد واقعی بدهد: records>0، bytes>0، زمان ثبت‌شده (زمان/حجم/رکورد).
#   ۴) COUNTS_BEFORE == COUNTS_AFTER (هیچ ردیفی گم/تکرار نشود).
#   ۵) مصرف‌کننده‌های واقعی بعد از بازیابی: ورود ۲۰۰ · نشست قدیمی ۴۰۱ · نمره/اطلاعیه > ۰.
#   ۶) مانیفست امضاشده (SHA ۶۴ hex، امضای ۶۴ بایت) و Manifest برچسب‌ها کامل.
#   ۷) ماتریس AC سند ۱۵ همان ۱۲ ردیف و حکم ۱۲/۱۲ باشد (سازگاری C8) + §۸ موجود.
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc15-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/cc15-gate.txt ⇒ CC15-OK
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC15_OUT:-$D/cc15-gate.txt}"
RAW="${CC15_RAW_DIR:-$D}"
MAN="${CC15_MANIFEST:-$D/cc15-required-labels.txt}"
BASE="${CC15_BASE:-f2fc472}"
DOC="${CC15_DOC:-docs/cloud/15-backup-recovery.md}"
DRILL="${CC15_DRILL_CMD:-node --experimental-sqlite --disable-warning=ExperimentalWarning $D/drill-15-recovery.cjs}"
RUNTIME="${CC15_RUNTIME_CMD:-bash $D/gen-mission-15-evidence.sh}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"

fail() {
  local txt="$1"
  echo "CC15-FAIL: $txt" >&2
  {
    echo "# دروازهٔ CC‑15 — شکست"
    echo "head: $HEAD"
    echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "reason: $txt"
  } > "${CC15_FAILDIR:-$D}/cc15-gate.FAILED-$TS.txt"
  exit 1
}

mkdir -p "$RAW"
RAW_DRILL="$RAW/cc15-raw-drill.txt"
RAW_RT="$RAW/cc15-raw-runtime.txt"

# ── ۰) پیش‌نیاز ────────────────────────────────────────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست (clone کم‌عمق؟) — هر «۰ فایل تغییر» بی‌اعتبار است"
PROD_N=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS 2>/dev/null | grep -c . || true)
[ "$PROD_N" = "0" ] || fail "PRODUCT-CHANGED: $PROD_N فایل محصول نسبت به $BASE تغییر کرده"

# ── ۱) شاهد رفتار امروز (اول؛ تازگی با HEAD سنجیده می‌شود) ─────────────────
bash -c "$RUNTIME" > "$RAW_RT" 2>&1 || fail "RUNTIME-EVIDENCE-EXIT≠0 — جزئیات: $RAW_RT"
EV="$D/mission-15-backup-probe.txt"
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

# ── ۴) عدد واقعی تمرین (زمان/حجم/تعداد رکورد) ──────────────────────────────
RUNLINE=$(grep -E '^BACKUP_RUN ' "$RAW_DRILL" | tail -1)
[ -n "$RUNLINE" ] || fail "BACKUP-RUN-MISSING"
REC=$(printf '%s' "$RUNLINE" | sed -E 's/.*records=([0-9]+).*/\1/')
BYTES=$(printf '%s' "$RUNLINE" | sed -E 's/.*bytes=([0-9]+).*/\1/')
TOTALMS=$(printf '%s' "$RUNLINE" | sed -E 's/.*total_ms=([0-9]+).*/\1/')
RWMS=$(printf '%s' "$RUNLINE" | sed -E 's/.*restore_write_ms=([0-9]+).*/\1/')
[ "${REC:-0}" -gt 0 ] 2>/dev/null || fail "BACKUP-RECORDS: تعداد رکورد نامعتبر «$REC»"
[ "${BYTES:-0}" -gt 0 ] 2>/dev/null || fail "BACKUP-BYTES: حجم نامعتبر «$BYTES»"
case "${TOTALMS:-}" in ''|*[!0-9]*) fail "BACKUP-DURATION: زمان اندازه‌گیری‌شده ثبت نشده («${TOTALMS:-}»)";; esac
[ "${TOTALMS:-0}" -gt 0 ] 2>/dev/null || fail "BACKUP-DURATION: زمان کل صفر است"
case "${RWMS:-}" in ''|*[!0-9]*) fail "RESTORE-DURATION: زمان بازیابی ثبت نشده («${RWMS:-}»)";; esac

CB=$(grep -E '^COUNTS_BEFORE=' "$RAW_DRILL" | tail -1 | sed 's/^COUNTS_BEFORE=//')
CA=$(grep -E '^COUNTS_AFTER=' "$RAW_DRILL" | tail -1 | sed 's/^COUNTS_AFTER=//')
[ -n "$CB" ] && [ -n "$CA" ] || fail "COUNTS-MISSING"
[ "$CB" = "$CA" ] || fail "COUNTS-DIFF: شمارش قبل «$CB» ≠ بعد «$CA»"

CONS=$(grep -E '^CONSUMERS=' "$RAW_DRILL" | tail -1 | sed 's/^CONSUMERS=//')
[ -n "$CONS" ] || fail "CONSUMERS-MISSING"
printf '%s' "$CONS" | grep -q '"login":200' || fail "CONSUMER-LOGIN: ورود پس از بازیابی ۲۰۰ نیست — $CONS"
printf '%s' "$CONS" | grep -q '"session_revoked_status":401' || fail "CONSUMER-SESSION: نشست قدیمی ۴۰۱ نگرفت — $CONS"
LOGIN_G=$(printf '%s' "$CONS" | sed -E 's/.*"grades":([0-9]+).*/\1/')
ANN_G=$(printf '%s' "$CONS" | sed -E 's/.*"announcements":([0-9]+).*/\1/')
[ "${LOGIN_G:-0}" -gt 0 ] 2>/dev/null || fail "CONSUMER-GRADES: خواندن نمره پس از بازیابی صفر/نامعتبر — $CONS"
[ "${ANN_G:-0}" -gt 0 ] 2>/dev/null || fail "CONSUMER-ANNOUNCEMENTS: خواندن اطلاعیه پس از بازیابی صفر/نامعتبر — $CONS"

BSHA=$(grep -E '^BACKUP_SHA256=' "$RAW_DRILL" | tail -1 | sed 's/^BACKUP_SHA256=//')
printf '%s' "${BSHA:-}" | grep -Eq '^[0-9a-f]{64}$' || fail "BACKUP-SHA: SHA بکاپ نامعتبر «${BSHA:-}»"
SIGB=$(grep -E '^MANIFEST_SIG_BYTES=' "$RAW_DRILL" | tail -1 | sed 's/^MANIFEST_SIG_BYTES=//')
[ "${SIGB:-0}" = "64" ] || fail "MANIFEST-SIG: امضای مانیفست ۶۴ بایت نیست («${SIGB:-}»)"

# ── ۵) ماتریس AC سند + بند دور بستن ────────────────────────────────────────
AC_N=$(grep -cE '^\| \*{0,2}AC' "$DOC" || true)
[ "$AC_N" = "12" ] || fail "AC-COUNT: $AC_N ردیف AC در سند ۱۵ (باید ۱۲)"
grep -q 'حکم: ۱۲/۱۲' "$DOC" || fail "AC-VERDICT: خط «حکم: ۱۲/۱۲» در سند نیست"
grep -q '^## ۸\.' "$DOC" || fail "DOC-CLOSURE: بند §۸ (دور بستن شرط) در سند ۱۵ نیست"

# ── موفق ───────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ CC‑15 — تمرین واقعی بکاپ رمزنگاری‌شده/فاجعه/بازیابی/آشتی"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc15-evidence.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node -v)"
  echo "product_diff_files: $PROD_N"
  echo "runtime_evidence_head: $EV_HEAD"
  echo "drill_summary: $SUMMARY"
  echo "labels_required: $(grep -c . "$MAN")  labels_verified: $BODY"
  echo "backup_run: $RUNLINE"
  echo "counts_before: $CB"
  echo "counts_after: $CA"
  echo "consumers: $CONS"
  echo "backup_sha256: $BSHA  manifest_sig_bytes: $SIGB"
  echo "ac_rows: $AC_N  verdict: ۱۲/۱۲"
  echo "drill_sha256: $(sha256sum "$D/drill-15-recovery.cjs" | cut -d' ' -f1)"
  echo "manifest_sha256: $(sha256sum "$MAN" | cut -d' ' -f1)"
  echo "doc_sha256: $(sha256sum "$DOC" | cut -d' ' -f1)"
  echo
  echo "## بررسی‌های گذر‌کرده (عین برچسب‌های تمرین)"
  grep '^✓ ' "$RAW_DRILL"
  echo
  echo "CC15-OK"
} > "$OUT"
echo "→ $OUT"
echo "CC15-OK"
grep -c '^✓ ' "$RAW_DRILL" | sed 's/^/checks_passed=/'
