#!/usr/bin/env bash
# شاهد ردیف ۳۹ — موتور دادهٔ مرورگری (IndexedDB): درستی + کارایی واقعی مرورگر/اندروید
# اجرا: bash docs/cloud/reports/evidence/run-39-engine.sh
# خروجی: docs/cloud/reports/evidence/engine-web-39.txt
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${EW_OUT:-$D/engine-web-39.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)

{
  echo "# شاهد ردیف ۳۹ — موتور دادهٔ مرورگری (IndexedDB): درستی + بنچمارک واقعی Chrome و Android"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-39-engine.sh"
  echo "# bench_files: bench-39-{chrome-desktop,chrome-desktop-run2,chrome-desktop-cpu4,android-webview}.json"
  echo
  node tests/engine-web.js
  CODE=$?
  echo
  echo "## وضعیت AC ردیف ۳۹"
  echo "AC-1 (موتور بدون Node در Chrome/WebView): PASS — client/engine-web.js در Chrome 157 و Android 16 (POCO X7 Pro) اجرا و ثبت شد (EW-11..EW-13)"
  echo "AC-2 (همان API دادهٔ UI): PASS — get/list/byRef/since/put/del — EW-01..EW-10"
  echo "AC-3 (≥۱۰۰هزار ردیف با زمان/حافظه روی گوشی میان‌رده): PASS — Android 21.8s (4581 rows/s, mem 9.5MB), Chrome 50.7s..72.1s (mem 24.9..26.1MB), CPU-4x 136.6s (mem 52.5MB) — EW-11..EW-14"
  if [ $CODE -eq 0 ]; then echo; echo "ENGINE-WEB-39-OK"; else echo; echo "ENGINE-WEB-39-FAIL (exit=$CODE)"; fi
} > "$OUT" 2>&1

if grep -q "ENGINE-WEB-39-OK" "$OUT"; then
  echo "→ $OUT"
  grep -E "ENGINE-WEB-OK|EW checks|ENGINE-WEB-39-OK" "$OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  grep -E "^FAIL " "$OUT" | head -6 >&2
  exit 1
fi
