#!/usr/bin/env bash
# شاهد اجرایی مأموریت ۱۶‑ب — tenancy/کلید/چرخهٔ عمر/مهاجرت روی سرور واقعی (دیتابیس موقت)
# بازپخش: bash docs/cloud/reports/evidence/gen-mission-16b-evidence.sh
set -u
cd "$(dirname "$0")/../../../.." || exit 1   # ریشهٔ مخزن
OUT="docs/cloud/reports/evidence/mission-16b-tenant-probe.txt"
{
  echo "# شاهد اجرایی مأموریت ۱۶‑ب — رفتار tenancy در کد امروز"
  echo "generated_by: docs/cloud/reports/evidence/gen-mission-16b-evidence.sh"
  echo "probe: docs/cloud/reports/evidence/probe-16b-tenant.mjs"
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  echo "head: $(git rev-parse HEAD)"
  echo "node: $(node -v)"
  echo "note: دیتابیس/بکاپ در mktemp؛ هیچ نوشتنی روی data/ مخزن انجام نمی‌شود"
  echo
  echo "## اجرا"
  node --experimental-sqlite --disable-warning=ExperimentalWarning \
    docs/cloud/reports/evidence/probe-16b-tenant.mjs
  echo "exit=$?"
  echo
  echo "## جای کد مرجع (بدون تغییر)"
  echo "-- server/sync.js:149 (برچسب مدرسه ثابت، نه از نشست)"
  sed -n '147,151p' server/sync.js | sed 's/^/   /'
  echo "-- server/db.js:201-212 (درج ردیف: بدون ستون tenant_id)"
  sed -n '205,212p' server/db.js | sed 's/^/   /'
  echo "-- server/index.js:48-50 (مسیر بکاپ سراسری، بدون پیشوند مستأجر)"
  sed -n '48,50p' server/index.js | sed 's/^/   /'
  echo "-- server/auth.js:44-60 (setup: فقط یک مدرسه)"
  sed -n '44,60p' server/auth.js | sed 's/^/   /'
  echo
  echo "## شاهد مکمل RLS (Design، PostgreSQL واقعی)"
  grep -c "^PASS" docs/cloud/reports/evidence/mission-a-rls-execution.txt
  grep "^HEAD:\|^postgres:\|^TOTAL" docs/cloud/reports/evidence/mission-a-rls-execution.txt
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
