#!/usr/bin/env bash
# شاهد ردیف ۳۹ — موتور دادهٔ مرورگری: بخش «درستی» (بدون مرورگر).
# اجرا: bash docs/cloud/reports/evidence/run-39-engine.sh
# خروجی: docs/cloud/reports/evidence/engine-web-39.txt
# توجه: این فایل فقط درستی API را ثابت می‌کند؛ سنجهٔ کارایی Chrome/WebView
#       باید جداگانه با bench/39 اجرا و به‌صورت JSON در همین پوشه گذاشته شود.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${EW_OUT:-$D/engine-web-39.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)

{
  echo "# شاهد ردیف ۳۹ — موتور دادهٔ مرورگری (IndexedDB): بخش درستی"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-39-engine.sh"
  echo "# note: fake-indexeddb در Node — فقط درستی؛ کارایی مرورگر در این فایل نیست"
  echo
  node tests/engine-web.js
  CODE=$?
  echo
  echo "## وضعیت AC ردیف ۳۹"
  echo "AC-1 (موتور بدون Node در Chrome/WebView): کد آماده است (client/engine-web.js بدون وابستگی) — اجرا در مرورگر واقعی هنوز ثبت نشده"
  echo "AC-2 (همان API دادهٔ UI): get/list/byRef/since/put/del — EW-02..EW-05"
  echo "AC-3 (≥۱۰۰هزار ردیف با زمان/حافظه روی گوشی میان‌رده): NOT-RUN — نیازمند bench/39 در Chrome/WebView"
  if [ $CODE -eq 0 ]; then echo; echo "ENGINE-WEB-39-PARTIAL-OK"; else echo; echo "ENGINE-WEB-39-FAIL (exit=$CODE)"; fi
} > "$OUT" 2>&1

if grep -q "ENGINE-WEB-39-PARTIAL-OK" "$OUT"; then
  echo "→ $OUT"
  grep -E "ENGINE-WEB-OK|EW checks" "$OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  grep -E "^FAIL " "$OUT" | head -6 >&2
  exit 1
fi
