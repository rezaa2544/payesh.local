#!/usr/bin/env bash
# شاهد مأموریت ۰۵ — تثبیت SHA و نقشهٔ شواهد مخزن
# اجرا: bash docs/cloud/reports/evidence/gen-mission-05-inventory.sh
# خروجی: docs/cloud/reports/evidence/mission-05-inventory.txt
set -u
cd "$(dirname "$0")/../../../.."
OUT=docs/cloud/reports/evidence/mission-05-inventory.txt
{
  echo "# نقشهٔ شواهد مخزن — مأموریت ۰۵"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-mission-05-inventory.sh"
  echo "# تاریخ: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v) · npm: $(npm -v) · سکو: $(uname -srm)"
  echo
  echo "## ۱. SHA تثبیت‌شدهٔ ممیزی"
  echo "HEAD            : $(git rev-parse HEAD)"
  echo "branch          : $(git rev-parse --abbrev-ref HEAD)"
  echo "commit base     : $(git rev-list --max-parents=0 HEAD | tail -1)"
  echo "تعداد commit    : $(git rev-list --count HEAD)"
  echo "working tree    : $(git status --porcelain | wc -l) تغییر ثبت‌نشده"
  echo "تگ‌های موجود    : $(git tag | tail -3 | tr '\n' ' ')"
  echo
  echo "## ۲. ساختار مخزن (بدون node_modules/.git)"
  find . -maxdepth 2 -type d -not -path './.git*' -not -path './node_modules*' | sort
  echo
  echo "## ۳. فایل‌های حیاتی و اندازه"
  for f in server/index.js server/sync.js server/auth.js server/policy.js server/db.js server/mirror.js \
           server/outbox.js server/live.js server/update.js server/s3mem.js server/qr.js server/tunnel.js \
           client/app.js client/pages.js client/import.js client/schedule.js client/authz.js client/cloud-baked.js \
           installer/payesh.iss scripts/lint-iss.mjs; do
    [ -f "$f" ] && printf '%-28s %6s خط  %8s بایت\n' "$f" "$(wc -l < "$f")" "$(wc -c < "$f")"
  done
  echo
  echo "## ۴. فهرست فایل‌های آزمون و اجرای واقعی"
  ls -1 tests/*.js | while read -r f; do printf '%-22s %6s خط\n' "$f" "$(wc -l < "$f")"; done
  echo
  echo "آزمون اصلی (npm test) — خروجی خام: docs/cloud/reports/evidence/mission-05-tests-run.log"
  echo "نتیجه: $(grep -o '[0-9]* موفق · [0-9]* ناموفق' docs/cloud/reports/evidence/mission-05-tests-run.log 2>/dev/null || echo 'اجرا نشده')"
  echo "کد خروج: $(grep -o 'EXIT=[0-9]*' docs/cloud/reports/evidence/mission-05-tests-run.log 2>/dev/null || echo '—')"
  echo
  echo "## ۵. مسیرهای حیاتی (نقشهٔ ممیزی ۰۶–۱۰)"
  echo "احراز هویت/نشست   : server/auth.js · server/index.js:157 (actorFrom) · server/index.js:420 (auth gate)"
  echo "مجوز/نقش          : server/policy.js · server/index.js:47 (BACKUP_ROLES) · server/index.js:558 (admin gate)"
  echo "همگام‌سازی        : server/sync.js (pull/push، idempotency، OCC)"
  echo "صف/صندوقچه        : server/outbox.js · client/app.js (flushQueue)"
  echo "بکاپ/آینه/بازیابی : server/mirror.js · server/index.js:1023-1090"
  echo "زنده (۱ ثانیه)     : server/live.js:24 (INTERVAL_MS=1000)"
  echo "ذخیره‌سازی ابری     : server/s3mem.js · client/lib/s3mini.js · client/cloud-baked.js"
  echo "به‌روزرسانی        : server/update.js"
  echo
  echo "## ۶. شمارش واقعیت‌های معماری"
  echo "school_id (تک‌مدرسه) در سرور: $(grep -rho 'school_id' server/*.js | wc -l) مورد"
  echo "tenant_id در سرور           : $(grep -rho 'tenant_id' server/*.js | wc -l) مورد"
  echo "password_plain در سرور/کلاینت: $(grep -rho 'password_plain' server/*.js client/*.js | wc -l) مورد"
  echo "crypto (رمزنگاری سکون)       : $(grep -rho 'createCipheriv\|createDecipheriv' server/*.js client/*.js | wc -l) مورد (۰ = نبود رمزنگاری سکون)"
  echo "endpointهای /api             : $(grep -o "'/api/[a-z0-9/_-]*'" server/index.js | sort -u | wc -l) مسیر یکتا"
  echo
  echo "## ۷. پاک‌بودن درخت کاری پس از ممیزی"
  git status --porcelain
  echo "(خالی = پاک)"
} > "$OUT"
echo "→ $OUT"
