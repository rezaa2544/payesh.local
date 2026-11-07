#!/usr/bin/env bash
# شاهد اجرایی مأموریت ۱۶ — سلامت/رصدپذیری/بار نظرسنجی روی سرور واقعی (دیتابیس موقت)
# بازپخش: bash docs/cloud/reports/evidence/gen-mission-16-evidence.sh
set -u
cd "$(dirname "$0")/../../../.." || exit 1   # ریشهٔ مخزن
OUT="docs/cloud/reports/evidence/mission-16-observability-probe.txt"
{
  echo "# شاهد اجرایی مأموریت ۱۶ — رفتار سلامت/رصدپذیری/بار در کد امروز"
  echo "generated_by: docs/cloud/reports/evidence/gen-mission-16-evidence.sh"
  echo "probe: docs/cloud/reports/evidence/probe-16-observability.mjs"
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  echo "head: $(git rev-parse HEAD)"
  echo "node: $(node -v)"
  echo "note: دیتابیس موقت (mktemp)؛ هیچ نوشتنی روی data/ مخزن انجام نمی‌شود"
  echo
  echo "## اجرا"
  node --experimental-sqlite --disable-warning=ExperimentalWarning \
    docs/cloud/reports/evidence/probe-16-observability.mjs
  echo "exit=$?"
  echo
  echo "## جای کد مرجع (بدون تغییر)"
  echo "-- server/index.js:262-... (/api/health: بدون بررسی وابستگی)"
  sed -n '261,268p' server/index.js | sed 's/^/   /'
  echo "-- server/index.js:166-174 (محدودیت نرخ درون‌حافظه، بدون پاک‌سازی)"
  sed -n '166,175p' server/index.js | sed 's/^/   /'
  echo "-- server/index.js:418-420 (سد احراز هویت سراسری)"
  sed -n '418,421p' server/index.js | sed 's/^/   /'
  echo "-- server/index.js:484-489 (/api/live/rev: every_ms=1000)"
  sed -n '484,489p' server/index.js | sed 's/^/   /'
  echo "-- server/index.js:1583-1589 (قالب لاگ درخواست: بدون tenant_id/request_id)"
  sed -n '1583,1589p' server/index.js | sed 's/^/   /'
  echo "-- server/live.js:24 (INTERVAL_MS=1000) و :30/:96-98 (حالت درون‌حافظه)"
  sed -n '24p;30p;96,98p' server/live.js | sed 's/^/   /'
  echo
  echo "## تغییر کد محصول نسبت به پایهٔ ممیزی f2fc472 (باید ۰ باشد)"
  if git cat-file -e f2fc472^{commit} 2>/dev/null; then
    n=$(git diff --name-only f2fc472 -- server client tests scripts package.json | wc -l | tr -d ' ')
    echo "product_diff_files=$n"
    if [ "$n" = "0" ]; then echo "PRODUCT-DIFF=0"; else echo "PRODUCT-DIFF=NONZERO"; fi
  else
    echo "BASE-MISSING=f2fc472"
    echo "PRODUCT-DIFF=UNKNOWN"
  fi
} > "$OUT"
echo "written: $OUT"
wc -l "$OUT"
