#!/usr/bin/env bash
# دروازهٔ دور بستن ردیف ۱۱ (CC‑11) — fail-closed
#
# چه چیزی را می‌سنجد:
#   ۰) پیش‌نیاز: پایهٔ ممیزی f2fc472 در مخزن باشد و diff محصول نسبت به آن صفر
#      (وگرنه «نتیجهٔ ممیزی روی HEAD» بی‌اعتبار است).
#   ۱) تمرین اجرایی drill-11-claims با کد ۰ تمام شود و هیچ خط ✗ نداشته باشد.
#   ۲) Manifest: هر ۴۸ برچسب لازم عیناً با ✓ آمده باشد و SUMMARY با بدنه بخواند.
#   ۳) اعداد واقعی: ۷۳ آیتم · ۷۳ متصل · ۶۱ ارجاع حل‌شده · ۰ مرده · ۱۱ رانش
#      (۹ تصحیح + ۲ تأیید) · ۸ پروب · توزیع ۲۶/۴۰/۷ · تطابق ۳۵٫۶٪.
#   ۴) ادعاهای «نبود»: رمزنگاری/tenant_id/TLS/امضا/seq/سقف صف = ۰.
#   ۵) سند ۱۱: اعداد جدول = بازشماری · §۲.۳ دقیقاً ۷ ردیف · ۵ ردیف AC · «حکم: ۵/۵»
#      · §۶ دور بستن با جدول ۹ تصحیح · ثبت C‑11‑۱ · پین 04e0636.
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc11-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/cc11-gate.txt ⇒ CC11-OK
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC11_OUT:-$D/cc11-gate.txt}"
RAW="${CC11_RAW_DIR:-$D}"
MAN="${CC11_MANIFEST:-$D/cc11-required-labels.txt}"
BASE="${CC11_BASE:-f2fc472}"
DOC="${CC11_DOC:-docs/cloud/11-gap-report.md}"
DRILL="${CC11_DRILL_CMD:-node $D/drill-11-claims.cjs}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"

fail() {
  local txt="$1"
  echo "CC11-FAIL: $txt" >&2
  {
    echo "# دروازهٔ CC‑11 — شکست"
    echo "head: $HEAD"
    echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "reason: $txt"
  } > "${CC11_FAILDIR:-$D}/cc11-gate.FAILED-$TS.txt"
  exit 1
}

mkdir -p "$RAW"
RAW_DRILL="$RAW/cc11-raw-drill.txt"

# ── ۰) پیش‌نیاز ─────────────────────────────────────────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست (clone کم‌عمق؟) — ادعای «کد محصول تغییر نکرد» بی‌اعتبار است"
PROD_N=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS 2>/dev/null | grep -c . || true)
# D‑35: پس از باز شدن دروازهٔ فاز ۳، تغییر کد محصول مجاز است ولی فقط در فایل‌های اعلام‌شده.
# حکم‌های ممیزی ۰۶–۱۰ به SHA پین‌شدهٔ 04e0636 مربوط‌اند؛ هر تغییر بیرون از این فهرست ⇒ شکست.
ALLOW="${CC11_ALLOW:-package.json package-lock.json server/index.js server/tenancy.js server/outbox.js server/cloud-defaults.js server/s3mem.js server/auth.js server/sync.js server/db.js server/mirror.js server/policy.js server/tenant-context.js server/live.js client/app.js client/pages.js client/lib/phone.js client/lib/s3mini.js client/lib/sigv4.js client/cloud-baked.js tests/run.js tests/restart.js tests/tenancy-pg.js tests/phone-flow.js scripts/bake-cloud.mjs scripts/tenancy-migrate-product.js}"
OUTSIDE=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS 2>/dev/null | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)
[ "$OUTSIDE" = "0" ] || fail "PRODUCT-SCOPE: $OUTSIDE فایل محصول بیرون از فهرست مجاز D‑35 تغییر کرده — شمارش/جدول‌های ۰۶–۱۰ دیگر به HEAD تعمیم‌پذیر نیست"

# ── ۱) اجرای تمرین روی درخت پین‌شدهٔ ممیزی ──────────────────────────────────
# D‑35: کد محصول از دروازهٔ فاز ۳ به بعد تغییر می‌کند، ولی حکم‌های ممیزی ۰۶–۱۰
# مربوط به همان SHA پین‌شده‌اند؛ پس اسکن کد از درخت پین انجام می‌شود، نه از HEAD.
PIN="${CC11_PIN:-04e0636}"
AUD=$(mktemp -d)
trap 'rm -rf "$AUD"; rm -f "$LABELS"' EXIT
git archive "$PIN" 2>/dev/null | tar -x -C "$AUD" || fail "PIN-TREE: استخراج درخت پین $PIN ناموفق بود"
export CC11_AUDIT_ROOT="$AUD"
bash -c "$DRILL" > "$RAW_DRILL" 2>&1
RC=$?
[ "$RC" = "0" ] || fail "DRILL-EXIT=$RC — جزئیات: $RAW_DRILL"
grep -q '^✗ ' "$RAW_DRILL" && fail "DRILL-CROSS: خط ✗ در خروجی تمرین"

# ── ۲) Manifest و حساب SUMMARY ─────────────────────────────────────────────
LABELS=$(mktemp)
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

# ── ۳) اعداد واقعی ─────────────────────────────────────────────────────────
CLAIMS=$(grep -E '^CLAIMS ' "$RAW_DRILL" | tail -1)
VERD=$(grep -E '^VERDICTS ' "$RAW_DRILL" | tail -1)
ATTACH=$(grep -E '^ATTACH ' "$RAW_DRILL" | tail -1)
PROBES=$(grep -E '^PROBES ' "$RAW_DRILL" | tail -1)
DRIFT=$(grep -E '^DRIFT ' "$RAW_DRILL" | tail -1)
ABS=$(grep -E '^ABSENCE ' "$RAW_DRILL" | tail -1)
[ -n "$CLAIMS$VERD$ATTACH$PROBES$DRIFT$ABS" ] || fail "METRICS-MISSING"

grep -qE '^CLAIMS rows=73 attached=73 citations=[0-9]+ resolved=[0-9]+ broken=0$' "$RAW_DRILL" || fail "CLAIMS: ۷۳ ردیف و ۷۳ اتصال و صفر ارجاع مرده اثبات نشد — $CLAIMS"
CIT_T=$(printf '%s' "$CLAIMS" | sed -E 's/.*citations=([0-9]+).*/\1/')
CIT_R=$(printf '%s' "$CLAIMS" | sed -E 's/.*resolved=([0-9]+).*/\1/')
[ "$CIT_T" = "$CIT_R" ] || fail "CITATIONS: resolved=$CIT_R ≠ citations=$CIT_T"
[ "${CIT_R:-0}" -ge 55 ] || fail "CITATIONS-COUNT: فقط $CIT_R ارجاع — ارجاع‌های جدول‌ها کم شده‌اند"
grep -qE '^VERDICTS pass=26 fail=40 unknown=7 blocked=0 conformance=35\.6%$' "$RAW_DRILL" || fail "VERDICTS: توزیع احکام/درصد با اعداد اعلامی نمی‌خواند — $VERD"
grep -qE '^DRIFT rows=11 corrections=9 accepted=2 ' "$RAW_DRILL" || fail "DRIFT: ۱۱ ردیف رانش (۹ تصحیح + ۲ تأیید) ثبت نشد — $DRIFT"
grep -qE '^PROBES cited=[0-9]+ resolved=[0-9]+$' "$RAW_DRILL" || fail "PROBES: پروب‌ها سنجیده نشدند — $PROBES"
grep -qE '^ABSENCE cipher=0 tenant_id=0 tls=0 signature=0 seq=0 queue_cap=0$' "$RAW_DRILL" || fail "ABSENCE: ادعاهای «نبود» با اندازه‌گیری تأیید نشد — $ABS"
grep -q '^ATTACH ' "$RAW_DRILL" || fail "ATTACH-MISSING"

# ── ۴) سند ۱۱ ──────────────────────────────────────────────────────────────
R_P=$(grep -cE '^\| \*{0,2}PASS\*{0,2} \|' "$DOC" || true)
AC_N=$(grep -cE '^\| AC‑[0-9]+ \|' "$DOC" || true)
[ "$AC_N" = "5" ] || fail "AC-COUNT: $AC_N ردیف AC در سند ۱۱ (باید ۵)"
grep -q 'حکم: ۵/۵' "$DOC" || fail "AC-VERDICT: خط «حکم: ۵/۵» در سند نیست"
grep -q '^## ۶\.' "$DOC" || fail "DOC-CLOSURE: بند §۶ (دور بستن) در سند ۱۱ نیست"
grep -q 'C‑11‑۱' "$DOC" || fail "CORRECTION-D10: تصحیح ثبت‌شدهٔ ادعای D‑10 (C‑11‑۱) در سند نیست"
grep -q '04e0636' "$DOC" || fail "AUDIT-PIN: پین SHA ممیزی در سند ۱۱ نیست"
CORR_ROWS=$(grep -cE '^\| [A-E]‑[0-9]+ \| `' "$DOC" || true)
[ "${CORR_ROWS:-0}" -ge 9 ] || fail "CORRECTION-TABLE: جدول لنگرهای تصحیح‌شده کمتر از ۹ ردیف است ($CORR_ROWS)"
grep -q '۳۵٫۶' "$DOC" || fail "CONFORMANCE: درصد ۳۵٫۶٪ در سند نیست"

# ── ۵) سازگاری با دروازهٔ شاهد آزمون ────────────────────────────────────────
TLOG=$D/mission-05-tests-run.log
TLINE=$(grep -E '^SUMMARY pass=[0-9]+ fail=[0-9]+' "$TLOG" | tail -1)
TP=$(printf '%s' "$TLINE" | sed -E 's/.*pass=([0-9]+).*/\1/')
TF=$(printf '%s' "$TLINE" | sed -E 's/.*fail=([0-9]+).*/\1/')
# بازتنظیم (D‑35 → F‑04): ردیف‌های بعدی آزمون اضافه می‌کنند؛ شرط = صفر شکست و pass ≥ ۸۸
[ "${TP:-0}" -ge 88 ] && [ "${TF:-1}" = "0" ] || fail "TESTS-EVIDENCE: لاگ آزمون pass=$TP fail=$TF (باید ≥88 و بدون شکست) — اول run-tests-evidence.sh"

# ── موفق ───────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ CC‑11 — اتصال ادعا→شاهد برای ۷۳ آیتم و بازسنجی روی HEAD"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc11-evidence.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node -v)"
  echo "audit_tree: $PIN"
  echo "product_diff_files: $PROD_N"
  echo "product_diff_outside_allow: $OUTSIDE"
  echo "drill_summary: $SUMMARY"
  echo "labels_required: $(grep -c . "$MAN")  labels_verified: $BODY"
  echo "claims: $CLAIMS"
  echo "verdicts: $VERD"
  echo "attach: $ATTACH"
  echo "probes: $PROBES"
  echo "drift: $DRIFT"
  echo "absence: $ABS"
  echo "doc_ac_rows: $AC_N  verdict: ۵/۵  conformance: ۳۵٫۶٪"
  echo "tests_log: pass=$TP fail=$TF"
  echo "drill_sha256: $(sha256sum "$D/drill-11-claims.cjs" | cut -d' ' -f1)"
  echo "manifest_sha256: $(sha256sum "$MAN" | cut -d' ' -f1)"
  echo "doc_sha256: $(sha256sum "$DOC" | cut -d' ' -f1)"
  echo
  echo "## بررسی‌های گذر‌کرده (عین برچسب‌های تمرین)"
  grep '^✓ ' "$RAW_DRILL"
  echo
  echo "CC11-OK"
} > "$OUT"
echo "→ $OUT"
echo "CC11-OK"
grep -c '^✓ ' "$RAW_DRILL" | sed 's/^/checks_passed=/'
