#!/usr/bin/env bash
# شاهد ساختاری ممیزی‌های ۰۵ تا ۱۱
# اجرا: bash docs/cloud/reports/evidence/gen-audit-evidence.sh
# خروجی: docs/cloud/reports/evidence/mission-05-11-structure.txt
set -u
cd "$(dirname "$0")/../../../.."
OUT=docs/cloud/reports/evidence/mission-05-11-structure.txt
DOCS="docs/cloud/05-audit-sha-freeze.md docs/cloud/06-audit-auth-session.md docs/cloud/07-audit-roles-tenant.md docs/cloud/08-audit-source-of-truth.md docs/cloud/09-audit-cache-queue-sync.md docs/cloud/10-audit-crypto-backup-restore.md docs/cloud/11-gap-report.md"
{
  echo "# شاهد ساختاری ممیزی ۰۵–۱۱"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-audit-evidence.sh"
  echo "# تاریخ: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# SHA ممیزی: $(git rev-parse HEAD)"
  echo "# branch: $(git rev-parse --abbrev-ref HEAD)"
  echo
  echo "## آزمون واقعی مخزن"
  echo "نتیجه: $(grep -o '[0-9]* موفق · [0-9]* ناموفق' docs/cloud/reports/evidence/mission-05-tests-run.log 2>/dev/null || echo 'اجرا نشده')"
  echo "کد خروج: $(grep -o 'EXIT=[0-9]*' docs/cloud/reports/evidence/mission-05-tests-run.log 2>/dev/null || echo '-')"
  echo
  echo "## پروب‌های اجرایی ۰۶–۱۰ (خروجی خام: mission-06-10-probes.txt)"
  grep -c '^\[' docs/cloud/reports/evidence/mission-06-10-probes.txt 2>/dev/null | sed 's/^/تعداد خط شاهد: /'
  grep -o 'F-0[0-9]' docs/cloud/reports/evidence/mission-06-10-probes.txt 2>/dev/null | sort | uniq -c | sed 's/^/  /'
  echo
  echo "## وضعیت هر سند"
  for d in $DOCS; do
    echo "--- $d"
    echo "خطوط: $(wc -l < "$d") · ردیف AC: $(grep -c '^| AC-' "$d")"
    grep -n '^| وضعیت' "$d" | head -1
    grep -o 'F‑0[0-9]' "$d" | sort -u | tr '\n' ' ' | sed 's/^/یافته‌ها: /'
    echo
  done
  echo
  echo "## شمارش احکام ممیزی (پایهٔ درصد ۱۱)"
  printf 'PASS    : %s\n' "$(grep -rho '| \*\*PASS\*\*' docs/cloud/06*.md docs/cloud/07*.md docs/cloud/08*.md docs/cloud/09*.md docs/cloud/10*.md | wc -l)"
  printf 'FAIL    : %s\n' "$(grep -rho '| \*\*FAIL' docs/cloud/06*.md docs/cloud/07*.md docs/cloud/08*.md docs/cloud/09*.md docs/cloud/10*.md | wc -l)"
  printf 'UNKNOWN : %s\n' "$(grep -rho '| \*\*UNKNOWN' docs/cloud/06*.md docs/cloud/07*.md docs/cloud/08*.md docs/cloud/09*.md docs/cloud/10*.md | wc -l)"
  echo
  echo "## تغییر کد محصول در کل ممیزی"
  echo "diff محصول f2fc472..HEAD: $(git diff --name-only f2fc472 HEAD -- server client tests installer scripts | wc -l) فایل"
  git status --porcelain -- server client tests installer scripts
  echo
  echo "## ۶۲ مسیر API (سطح حمله)"
  grep -o "'/api/[a-z0-9/_-]*'" server/index.js | sort -u | tr '\n' ' '
} > "$OUT"
echo "→ $OUT"
