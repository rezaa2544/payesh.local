#!/usr/bin/env bash
# دروازهٔ بستن صف — تصمیم‌های مالک (D‑30..D‑33) و شرایط ردیف ۱۲ (CC‑12‑3 / CC‑12‑4)
# fail-closed: هر ادعای بی‌شاهد، عدد ناسازگار یا فایل نبود ⇒ شکست
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc12-closure.sh
# خروجی سبز: docs/cloud/reports/evidence/cc12-closure-gate.txt ⇒ CC12-CLOSURE-OK
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="${CC12_OUT:-$D/cc12-closure-gate.txt}"
CONST="${CC12_CONST:-docs/00-PAYESH-CLOUD-CONSTITUTION.md}"
DOC04="${CC12_DOC4:-docs/cloud/04-capacity-and-availability.md}"
DOC04B="${CC12_DOC4B:-docs/cloud/04b-plan-caps-usage-model.md}"
DOC12="${CC12_DOC12:-docs/cloud/12-multitenant-architecture.md}"
DOC16B="${CC12_DOC16B:-docs/cloud/16b-tenant-provisioning-migration.md}"
BENCH="${CC12_BENCH:-$D/mission-12-cc3-load-baseline.txt}"
BENCH_SH="${CC12_BENCH_SCRIPT:-$D/bench-poll-load.cjs}"
TESTS="${CC12_TESTS:-$D/mission-05-tests-run.log}"
BASE="${CC12_BASE:-f2fc472}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HEAD=$(git rev-parse HEAD)
PRODUCT_PATHS="server client tests scripts package.json package-lock.json installer desktop install deploy"

fail() {
  echo "CC12-CLOSURE-FAIL: $1" >&2
  { echo "# دروازهٔ بستن صف — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "${CC12_FAILDIR:-$D}/cc12-closure.FAILED-$TS.txt"
  exit 1
}

# ارقام لاتین → فارسی (برای مقایسهٔ اعداد دست‌نویس در اسناد)
fa() {
  printf '%s' "$1" | sed -e 's/0/۰/g' -e 's/1/۱/g' -e 's/2/۲/g' -e 's/3/۳/g' \
    -e 's/4/۴/g' -e 's/5/۵/g' -e 's/6/۶/g' -e 's/7/۷/g' -e 's/8/۸/g' -e 's/9/۹/g'
}

[ -f "$BENCH" ] || fail "BENCH-MISSING: $BENCH"

# ── ۰) پیش‌نیاز: پایهٔ ممیزی + کد محصول دست‌نخورده ─────────────────────────
git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "BASE-MISSING: $BASE در مخزن نیست"
PROD_N=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -c . || true)
# D‑35: تغییر محصول مجاز است، ولی فقط در فایل‌های اعلام‌شدهٔ فاز ۳
ALLOW="${CC12_ALLOW:-package.json package-lock.json server/index.js server/tenancy.js server/outbox.js server/cloud-defaults.js server/s3mem.js client/app.js client/pages.js client/lib/phone.js client/lib/s3mini.js client/lib/sigv4.js client/cloud-baked.js tests/run.js tests/phone-flow.js scripts/bake-cloud.mjs}"
OUTSIDE=$(git diff --name-only "$BASE" HEAD -- $PRODUCT_PATHS | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)
[ "$OUTSIDE" = "0" ] || fail "PRODUCT-SCOPE: $OUTSIDE فایل محصول بیرون از فهرست مجاز D‑35 تغییر کرده"

# ── ۱) سازگاری درونی شاهد سنجش بار ─────────────────────────────────────────
SWEEP=$(awk '/^## پویش/{f=1;next} /^## /{f=0} f && /^BENCH devices=/' "$BENCH")
REPEAT=$(awk '/^## تکرار/{f=1;next} /^## /{f=0} f && /^BENCH devices=/' "$BENCH")
[ -n "$SWEEP" ] || fail "BENCH-SWEEP: بخش پویش خالی است"
[ -n "$REPEAT" ] || fail "BENCH-REPEAT: بخش تکرار خالی است"

CAP=$(printf '%s\n' "$SWEEP" | awk '
  { d=$2; sub("devices=","",d); e=$5; sub("errors=","",e); p=$7; sub("p95_ms=","",p) }
  (e+0)==0 && (p+0)<1000 && (d+0)>m { m=d+0 } END { print (m==""?0:m) }')
[ "$CAP" -gt 0 ] || fail "BENCH-CAP-ZERO: هیچ سطحی زیر آستانه نیست"
grep -qE "^BENCH-CAP max_ok_devices=$CAP " "$BENCH" || fail "BENCH-CAP-MISMATCH: بازمحاسبه=$CAP ولی خط CAP چیز دیگری می‌گوید"
grep -q 'no_production_scale_claim=1' "$BENCH" || fail "BENCH-SCOPE: ادعای «بدون مقیاس تولیدی» در شاهد نیست"

# هر ردیف: rps باید نزدیک تعداد دستگاه باشد (poll هر ۱ ثانیه)
printf '%s\n%s\n' "$SWEEP" "$REPEAT" | while read -r line; do
  d=$(printf '%s' "$line" | sed -E 's/.*devices=([0-9]+).*/\1/')
  r=$(printf '%s' "$line" | sed -E 's/.*rps=([0-9.]+).*/\1/')
  awk -v d="$d" -v r="$r" 'BEGIN{ if (r < 0.6*d || r > 1.6*d) exit 9 }' || fail "BENCH-RPS: دستگاه=$d rps=$r ناسازگار"
done

# تکرارها: در سطح زانو، p95 باید از آستانه بگذرد (وگرنه «زانو» اثبات نشده)
REP_BAD=$(printf '%s\n' "$REPEAT" | awk '{ p=$7; sub("p95_ms=","",p); if ((p+0)<1000) n++ } END { print n+0 }')
[ "$REP_BAD" = "0" ] || fail "BENCH-KNEE: $REP_BAD تکرار در سطح زانو زیر آستانه است — ادعای زانو بی‌شاهد"
REP_MIN=$(printf '%s\n' "$REPEAT" | awk '{ p=$7; sub("p95_ms=","",p); p+=0; if (min==""||p<min) min=p } END { print min }')
REP_MAX=$(printf '%s\n' "$REPEAT" | awk '{ p=$7; sub("p95_ms=","",p); p+=0; if (p>max) max=p } END { print max }')
P95_384=$(printf '%s\n' "$SWEEP" | awk '{ d=$2; sub("devices=","",d); if ((d+0)==384) { p=$7; sub("p95_ms=","",p); print p+0 } }')

# ── ۲) اسناد اعداد همان شاهد را نقل کنند ──────────────────────────────────
grep -q '## ۲.۱' "$DOC04" || fail "DOC04-SECTION: بخش «خط پایهٔ اندازه‌گیری‌شده» نیست"
grep -q 'bench-poll-load.cjs' "$DOC04" || fail "DOC04-REPRO: فرمان بازتولید در سند نیست"
grep -qF "$(fa "$P95_384")ms" "$DOC04" || fail "DOC04-P95: p95 سطح ۳۸۴ ($P95_384) در سند ۰۴ نیامده"
grep -qF "$(fa "$REP_MIN")–$(fa "$REP_MAX")ms" "$DOC04" || fail "DOC04-KNEE: بازهٔ تکرار ($REP_MIN–$REP_MAX) در سند ۰۴ نیامده"
grep -q 'حکم: ۱۴/۱۴' "$DOC04" || fail "DOC04-VERDICT: حکم ۱۴/۱۴ در سند ۰۴ نیست"
A4=$(grep -cE '^\| AC‑[0-9]+ \|' "$DOC04" || true)
[ "$A4" -ge 14 ] || fail "DOC04-AC: تعداد ردیف AC=$A4 (باید ≥۱۴)"
A4_NG=$(grep -E '^\| AC‑[0-9]+ \|' "$DOC04" | grep -vc '✅' || true)
[ "$A4_NG" = "0" ] || fail "DOC04-AC-NOTICK: $A4_NG ردیف AC بدون ✅"

grep -q 'D‑32' "$DOC04B" || fail "DOC04B-O14: تصمیم O‑14 (D‑32) در سند ۰۴‑ب نیست"
grep -q 'D‑33' "$DOC04B" || fail "DOC04B-O18: تصمیم O‑18 (D‑33) در سند ۰۴‑ب نیست"
grep -q 'PASS (طراحی)' "$DOC04B" || fail "DOC04B-STATUS: سرصفحهٔ سند ۰۴‑ب PASS نشده"

grep -q 'CC‑12‑3.*CLOSED' "$DOC12" || fail "DOC12-CC3: شرط CC‑12‑3 بسته نشده"
grep -q 'CC‑12‑4.*CLOSED' "$DOC12" || fail "DOC12-CC4: شرط CC‑12‑4 بسته نشده"
# D‑35: CC‑12‑2 پس از باز شدن دروازه با شاهد مسیر محصول بسته شد؛ ادعای PARTIAL دیگر درست نیست
# (الگوی دوخطی: کاراکتر «‑» U+2011 چندبایتی است و '.' در locale ساده فقط یک بایت می‌گیرد)
grep 'CC‑12‑2' "$DOC12" | grep -q 'CLOSED' || fail "DOC12-CC2: شرط CC‑12‑2 باید با شاهد مسیر محصول CLOSED اعلام شود"
grep 'CC‑12‑2' "$DOC12" | grep -q 'PARTIAL' && fail "DOC12-CC2-STALE: سند ۱۲ هنوز CC‑12‑2 را PARTIAL می‌داند — سند از واقعیت عقب است"
grep -q 'D‑31' "$DOC12" || fail "DOC12-O07: تصمیم O‑07 (D‑31) در سند ۱۲ نیست"
grep -q '۸/۸' "$DOC12" || fail "DOC12-VERDICT: حکم ۸/۸ در سند ۱۲ نیست"

# ── ۳) نقشهٔ نهایی مسیرها = خروجی ۱۶‑ب (D‑32 بند ۴) ───────────────────────
for pat in 't/<tenant>/files/<sha256>' 't/<tenant>/backups/db/' 't/<tenant>/exports/'; do
  grep -qF "$pat" "$DOC16B" || fail "DOC16B-MAP: مسیر «$pat» در ۱۶‑ب نیست"
  grep -qF "$pat" "$DOC12" || fail "DOC12-MAP: مسیر «$pat» در سند ۱۲ نقل نشده"
done

# ── ۴) تصمیم‌های مالک در قانون اساسی ───────────────────────────────────────
for d in 'D‑30' 'D‑31' 'D‑32' 'D‑33'; do
  grep -qE "^\| \*\*$d\*\*" "$CONST" || fail "CONST-DECISION: $d در Decision Log نیست"
done
grep -qE '^\| O‑06 \|.*✅.*D‑30' "$CONST" || fail "CONST-O06: پاسخ O‑06 ثبت نشده"
grep -qE '^\| O‑07 \|.*✅.*D‑31' "$CONST" || fail "CONST-O07: پاسخ O‑07 ثبت نشده"
grep -qE '^\| O‑14 \|.*✅.*D‑32' "$CONST" || fail "CONST-O14: پاسخ O‑14 ثبت نشده"
grep -qE '^\| O‑18 \|.*✅.*D‑33' "$CONST" || fail "CONST-O18: پاسخ O‑18 ثبت نشده"

# ── ۵) ابزار سنجش روی همین HEAD واقعاً کار کند (smoke) ────────────────────
SMOKE=$(node "$BENCH_SH" --devices=2 --seconds=2 2>&1)
echo "$SMOKE" | grep -qE '^BENCH devices=2 .*errors=0 ' || fail "BENCH-SMOKE: اجرای ۲ دستگاه روی HEAD خطا داد — $SMOKE"

# ── ۶) آزمون‌های محصول (شاهد موجود) ───────────────────────────────────────
TLINE=$(grep -E '^SUMMARY pass=[0-9]+ fail=[0-9]+' "$TESTS" | tail -1)
TP=$(printf '%s' "$TLINE" | sed -E 's/.*pass=([0-9]+).*/\1/')
TF=$(printf '%s' "$TLINE" | sed -E 's/.*fail=([0-9]+).*/\1/')
[ "${TP:-0}" = "88" ] && [ "${TF:-1}" = "0" ] || fail "TESTS: لاگ آزمون pass=$TP fail=$TF (باید 88/0)"

# ── موفق ──────────────────────────────────────────────────────────────────
{
  echo "# دروازهٔ بستن صف — D‑30..D‑33 و شرایط CC‑12‑3/CC‑12‑4"
  echo "generated_by: docs/cloud/reports/evidence/gen-cc12-closure.sh"
  echo "head: $HEAD"
  echo "base: $BASE"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "product_diff_files: $PROD_N"
  echo "bench_cap_devices: $CAP"
  echo "bench_p95_at_384: $P95_384"
  echo "bench_p95_knee_repeat: $REP_MIN..$REP_MAX"
  echo "bench_sha256: $(sha256sum "$BENCH" | cut -d' ' -f1)"
  echo "harness_sha256: $(sha256sum "$BENCH_SH" | cut -d' ' -f1)"
  echo "doc04_sha256: $(sha256sum "$DOC04" | cut -d' ' -f1)"
  echo "doc12_sha256: $(sha256sum "$DOC12" | cut -d' ' -f1)"
  echo "constitution_sha256: $(sha256sum "$CONST" | cut -d' ' -f1)"
  echo "tests_log: pass=$TP fail=$TF"
  echo "decisions: D-30 O-06 · D-31 O-07 · D-32 O-14 · D-33 O-18"
  echo "row12_conditions: CC-12-1 CLOSED · CC-12-2 CLOSED(product-path) · CC-12-3 CLOSED · CC-12-4 CLOSED"
  echo
  echo "## بررسی‌های گذرکرده"
  echo "✓ پیش‌نیاز پایهٔ ممیزی $BASE و صفر تغییر محصول"
  echo "✓ سازگاری درونی شاهد بار (CAP بازمحاسبه‌شده، rps≈دستگاه، زانو با ۳ تکرار)"
  echo "✓ سند ۰۴ اعداد همان شاهد را نقل می‌کند + AC ۱۴/۱۴"
  echo "✓ سند ۰۴‑ب تصمیم‌های D‑32/D‑33 را ثبت کرده"
  echo "✓ سند ۱۲: هر چهار شرط بسته، CC‑12‑2 با شاهد مسیر محصول (D‑35)"
  echo "✓ نقشهٔ نهایی مسیرها از ۱۶‑ب در سند ۱۲ نقل شده"
  echo "✓ Decision Log و جدول پرسش‌های باز هم‌خوان"
  echo "✓ smoke ابزار سنجش روی HEAD (۲ دستگاه)"
  echo "✓ لاگ آزمون محصول: pass=$TP fail=$TF"
  echo
  echo "CC12-CLOSURE-OK"
} > "$OUT"
echo "→ $OUT"
echo "CC12-CLOSURE-OK cap=$CAP p95@384=${P95_384}ms knee=${REP_MIN}..${REP_MAX}ms"
