#!/usr/bin/env bash
# شاهد ردیف ۵۹ — سیاست شاخهٔ قفل‌شده (D-38)
# اجرا: bash docs/cloud/reports/evidence/run-59-branch-policy.sh
set -u
cd "$(dirname "$0")/../../../.." || exit 2
export LC_ALL=C.UTF-8
D=docs/cloud/reports/evidence
OUT=${BP59_OUT:-$D/branch-policy-59.txt}
HEAD=$(git rev-parse --short HEAD); BR=$(git rev-parse --abbrev-ref HEAD)
echo "# وضعیت مرجع: git fetch قبل از سنجش" >/dev/null
git fetch -q origin main 2>/dev/null || true

{
  echo "# شاهد ردیف ۵۹ — سیاست اجرا روی شاخهٔ قفل‌شده (B1..B5)"
  echo "# branch: $BR   head: $HEAD   at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# POLICY_SINCE="$(node -e 'import("./tools/branch-policy-59.mjs").then(m=>console.log(m.POLICY_SINCE))')
  echo

  echo "## بخش ۱ — سنجش قواعد روی همین مخزن"
  node tools/branch-policy-59.mjs
  A=${PIPESTATUS[0]}

  echo
  echo "## بخش ۲ — آزمون BP-01..BP-10 (مخزن‌های موقت، با کنترل منفی)"
  node tests/branch-policy-59.js 2>&1 | tail -13
  T=${PIPESTATUS[0]}

  echo
  echo "## بخش ۳ — B5: یک PR برای هر ردیف (gh)"
  node tools/branch-policy-59.mjs --pr-audit --rows "${BP59_ROWS:-60,59}" 2>&1 | tail -8
  P=${PIPESTATUS[0]}

  echo
  echo "## بخش ۴ — رگرسیون کامل"
  npm test --silent 2>&1 | tail -3
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# policy_exit:     $A"
  echo "# policy_test_exit: $T"
  echo "# pr_audit_exit:   $P"
  echo "# regression_exit: $R"
  echo "# NOTE: B5 به gh/شبکه نیاز دارد و در CI اجرا نمی‌شود؛ قفل سخت سمت GitHub = OWNER."
  echo "#       خروجی non-zero در B5 تا زمانی طبیعی است که PR این ردیف هنوز ثبت نشده باشد."
  if [ "$A" -eq 0 ] && [ "$T" -eq 0 ] && [ "$R" -eq 0 ]; then echo "# EXIT=0"; echo "BRANCH-POLICY-59-EVIDENCE-OK";
  else echo "# EXIT=1"; echo "BRANCH-POLICY-59-EVIDENCE-FAILED"; fi
} > "$OUT" 2>&1
sed -n '/بخش ۱/,$p' "$OUT" | head -30
grep -q '^BRANCH-POLICY-59-EVIDENCE-OK$' "$OUT"
