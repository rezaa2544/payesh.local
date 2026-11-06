#!/usr/bin/env bash
# شاهد اجرایی مأموریت ۱۴ — پروب تعارض/هم‌گرایی روی سرور واقعی با دیتابیس موقت
# بازپخش: bash docs/cloud/reports/evidence/gen-mission-14-evidence.sh
set -u
cd "$(dirname "$0")/../../../.." || exit 1   # ریشهٔ مخزن
OUT="docs/cloud/reports/evidence/mission-14-conflict-probe.txt"
{
  echo "# شاهد اجرایی مأموریت ۱۴ — رفتار تعارض در کد امروز"
  echo "generated_by: docs/cloud/reports/evidence/gen-mission-14-evidence.sh"
  echo "probe: docs/cloud/reports/evidence/probe-14-conflict.mjs"
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  echo "head: $(git rev-parse HEAD)"
  echo "node: $(node -v)"
  echo "note: دیتابیس موقت و مجزا (mktemp) — هیچ نوشتنی روی data/ مخزن انجام نمی‌شود"
  echo
  echo "## اجرا"
  node --experimental-sqlite --disable-warning=ExperimentalWarning \
    docs/cloud/reports/evidence/probe-14-conflict.mjs
  echo "exit=$?"
  echo
  echo "## جای کد مرجع (بدون تغییر)"
  echo "-- server/sync.js:117-124 (بررسی base_version)"
  sed -n '115,125p' server/sync.js | sed 's/^/   /'
  echo "-- server/sync.js:151-158 (gate نقش/اسکوپ، بعد از بررسی تعارض)"
  sed -n '151,158p' server/sync.js | sed 's/^/   /'
  echo "-- client/app.js:333-341 (پاسخ تعارض: نسخهٔ سرور جای محلی)"
  sed -n '333,341p' client/app.js | sed 's/^/   /'
  echo
  echo "## تغییر کد محصول نسبت به پایهٔ ممیزی f2fc472 (باید ۰ باشد)"
  git diff --name-only f2fc472 -- server client tests scripts package.json | wc -l
} > "$OUT"
echo "written: $OUT"
wc -l "$OUT"
