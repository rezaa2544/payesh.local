#!/usr/bin/env bash
# شاهد ردیف ۶۰ — شناسهٔ تصمیم اسناد ۳۱/۳۲/۳۴ (ADR‑31/32/34)
# اجرا: bash docs/cloud/reports/evidence/run-60-adr-ids.sh
set -u
cd "$(dirname "$0")/../../../.." || exit 2
export LC_ALL=C.UTF-8
D=docs/cloud/reports/evidence
OUT=${ADR60_OUT:-$D/adr-ids-60.txt}
HEAD=$(git rev-parse --short HEAD); BR=$(git rev-parse --abbrev-ref HEAD)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

{
  echo "# شاهد ردیف ۶۰ — شناسهٔ تصمیم اسناد ۳۱/۳۲/۳۴"
  echo "# branch: $BR   head: $HEAD   at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo

  echo "## بخش ۱ — شناسه‌ها در سه سند"
  node tools/adr-ids-60.mjs
  A=${PIPESTATUS[0]}

  echo
  echo "## بخش ۲ — آزمون AD-01..AD-09 (با کنترل منفی)"
  node tests/adr-ids-60.js 2>&1 | tail -12
  T=${PIPESTATUS[0]}

  echo
  echo "## بخش ۳ — کنترل منفی زنده: برگرداندن D‑31 در یک کپی ⇒ باید قرمز شود"
  mkdir -p "$TMP/docs/cloud"
  cp docs/cloud/31-adr-local-engine.md "$TMP/docs/cloud/"
  sed -i "s/ADR\u201131/D\u201131/" "$TMP/docs/cloud/31-adr-local-engine.md"
  node tools/adr-ids-60.mjs --root "$TMP" 2>&1 | grep -E "PROBLEM|ADR-IDS" | head -5
  N=${PIPESTATUS[0]}
  echo "# exit کنترل منفی: $N (غیرصفر = درست)"

  echo
  echo "## بخش ۴ — گیت‌های ذی‌ربط"
  node tests/repo-boundary.js 2>&1 | tail -2
  B=${PIPESTATUS[0]}

  echo
  echo "## بخش ۵ — رگرسیون کامل"
  npm test --silent 2>&1 | tail -3
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# adr_tool_exit:  $A"
  echo "# adr_test_exit:  $T"
  echo "# negative_exit:  $N"
  echo "# boundary_exit:  $B"
  echo "# regression_exit: $R"
  echo "# NOTE: این ردیف فقط سند/آزمون/شاهد است؛ صفر تغییر منطق محصول."
  if [ "$A" -eq 0 ] && [ "$T" -eq 0 ] && [ "$N" -ne 0 ] && [ "$B" -eq 0 ] && [ "$R" -eq 0 ]; then
    echo "# EXIT=0"; echo "ADR-IDS-60-EVIDENCE-OK"
  else echo "# EXIT=1"; echo "ADR-IDS-60-EVIDENCE-FAILED"; fi
} > "$OUT" 2>&1
tail -22 "$OUT"
grep -q '^ADR-IDS-60-EVIDENCE-OK$' "$OUT"
