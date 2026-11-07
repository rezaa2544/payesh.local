#!/usr/bin/env bash
# شاهد ساختاری مأموریت‌های ۱۲ تا ۱۶‑ب — خروجی قطعی و قابل بازپخش
set -u
cd "$(dirname "$0")/../../../.." || exit 1   # ریشهٔ مخزن
OUT="docs/cloud/reports/evidence/mission-12-16b-structure.txt"
{
  echo "# شاهد ساختاری فاز ۲ (۱۲، ۱۲‑ب، ۱۳، ۱۴، ۱۵، ۱۶، ۱۶‑ب)"
  echo "generated_by: docs/cloud/reports/evidence/gen-mission-12-16b.sh"
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  echo "head: $(git rev-parse HEAD)"
  echo
  echo "## فایل‌های طراحی و تعداد خط/جدول/AC"
  for f in 12-multitenant-architecture 12b-owner-panel-boundaries \
           13-secure-cache-offline-queue 14-conflict-convergence \
           15-backup-recovery 16-ha-observability-cost \
           16b-tenant-provisioning-migration; do
    p="docs/cloud/$f.md"
    if [ -f "$p" ]; then
      printf '%-42s lines=%-4s tables=%-3s ac_rows=%s\n' "$f" \
        "$(wc -l < "$p")" "$(grep -c '^|' "$p")" \
        "$(grep -cE '^\| \*{0,2}AC' "$p")"
    else
      printf '%-42s MISSING\n' "$f"
    fi
  done
  echo
  echo "## حکم‌های ثبت‌شده (هر سند حکم خودش — هیچ سبزی خودکار نیست)"
  grep -h '^\*\*حکم' docs/cloud/1[2-6]*.md 2>/dev/null
  echo
  echo "## تغییر کد محصول نسبت به پایهٔ ممیزی f2fc472 (فقط در فهرست مجاز D‑35)"
  ALLOW="package.json package-lock.json server/index.js server/tenancy.js server/outbox.js server/cloud-defaults.js server/s3mem.js client/app.js client/pages.js client/lib/phone.js client/lib/s3mini.js client/lib/sigv4.js client/cloud-baked.js tests/run.js tests/phone-flow.js scripts/bake-cloud.mjs"
  printf 'product_diff_files: %s\n' "$(git diff --name-only f2fc472 -- server client tests scripts package.json package-lock.json | grep -c . || true)"
  printf 'product_diff_outside_allow: %s\n' "$(git diff --name-only f2fc472 -- server client tests scripts package.json package-lock.json | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)"
  echo
  echo "## شمارش واقعی مخزن"
  printf 'tenant_id: %s\n' "$(grep -rIl --exclude-dir=node_modules --exclude-dir=.git 'tenant_id' server client tests 2>/dev/null | wc -l)"
  printf 'school_id (occurrences, server+client): %s\n' "$(grep -rIo --exclude-dir=node_modules --exclude-dir=.git 'school_id' server client 2>/dev/null | wc -l)"
  printf 'school_id (files): %s\n' "$(grep -rIl --exclude-dir=node_modules --exclude-dir=.git 'school_id' server client 2>/dev/null | wc -l)"
  printf 'api routes (unique /api literals in server/index.js): %s\n' "$(grep -oE "/api/[a-zA-Z0-9/_-]+" server/index.js | sort -u | wc -l)"
  echo
  echo "## وضعیت درخت کاری"
  git status --porcelain | head -20
  echo "(اگر خط بالا خالی است، درخت پاک بوده پیش از تولید این فایل)"
} > "$OUT"
echo "written: $OUT"
wc -l "$OUT"
