#!/usr/bin/env bash
# شاهد اجرایی مأموریت ۱۵ — بکاپ و بازیابی روی سرور واقعی با دیتابیس موقت
# بازپخش: bash docs/cloud/reports/evidence/gen-mission-15-evidence.sh
set -u
cd "$(dirname "$0")/../../../.." || exit 1   # ریشهٔ مخزن
OUT="docs/cloud/reports/evidence/mission-15-backup-probe.txt"
{
  echo "# شاهد اجرایی مأموریت ۱۵ — رفتار بکاپ/بازیابی در کد امروز"
  echo "generated_by: docs/cloud/reports/evidence/gen-mission-15-evidence.sh"
  echo "probe: docs/cloud/reports/evidence/probe-15-backup.mjs"
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  echo "head: $(git rev-parse HEAD)"
  echo "node: $(node -v)"
  echo "note: دیتابیس و فایل‌های بکاپ در mktemp — هیچ نوشتنی روی data/ مخزن انجام نمی‌شود"
  echo
  echo "## اجرا"
  node --experimental-sqlite --disable-warning=ExperimentalWarning \
    docs/cloud/reports/evidence/probe-15-backup.mjs
  echo "exit=$?"
  echo
  echo "## جای کد مرجع (بدون تغییر)"
  echo "-- server/index.js:47 (BACKUP_ROLES — چهار نقش)"
  sed -n '47p' server/index.js | sed 's/^/   /'
  echo "-- server/index.js:558-561 (استثنای مسیر آینه/بازیابی)"
  sed -n '558,561p' server/index.js | sed 's/^/   /'
  echo "-- server/index.js:1073-1085 (بازیابی: بدون بررسی امضا/مانیفست، audit بدون هویت)"
  sed -n '1073,1085p' server/index.js | sed 's/^/   /'
  echo "-- server/db.js:268-279 (backupTo = VACUUM INTO، نگهداشت ۴۸)"
  sed -n '268,279p' server/db.js | sed 's/^/   /'
  echo "-- server/mirror.js:179-217 (restore از payload کلاینت، replace اختیاری)"
  sed -n '179,190p' server/mirror.js | sed 's/^/   /'
  echo "   …"
  sed -n '207,217p' server/mirror.js | sed 's/^/   /'
  echo "-- server/mirror.js:32 (KEEP_DAYS=400)"
  sed -n '32p' server/mirror.js | sed 's/^/   /'
  echo
  echo "## تغییر کد محصول نسبت به پایهٔ ممیزی f2fc472 (باید ۰ باشد)"
  git diff --name-only f2fc472 -- server client tests scripts package.json | wc -l
} > "$OUT"
echo "written: $OUT"
wc -l "$OUT"
