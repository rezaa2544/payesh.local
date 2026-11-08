#!/usr/bin/env bash
# شاهد ردیف ۴۹ — پایش و هشدار (readyz/healthz، متریک lag/صف/خطا، قواعد هشدار، تحویل)
# اجرا: bash docs/cloud/reports/evidence/run-49-observability.sh
# خروجی سبز: docs/cloud/reports/evidence/observability-49.txt  (پایان: OBSERVABILITY-49-OK)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${OB49_OUT:-$D/observability-49.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
VER=$(node -e "process.stdout.write(require('./package.json').version)")
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

{
  echo "# شاهد ردیف ۴۹ — پایش و هشدار (probe + metric + alert rules + delivery)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)   os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-49-observability.sh"
  echo "# scope: سرور مدرسه واقعی (فرایند جدا، SQLite واقعی) + ارزیاب قواعد + گیرندهٔ HTTP واقعی"
  echo "# NOTE: تحویل به Pager بیرونی تنظیم نشده است (OWNER، ردیف ۵۸) — این شاهد فقط زنجیرهٔ محلی را اثبات می‌کند."
  echo

  echo "## بخش ۱ — قواعد هشدار: تجزیه و کامل‌بودن (severity/runbook/for)"
  node tools/alerts-49.mjs --check-rules
  A=$?

  echo
  echo "## بخش ۲ — آزمون OB-01..OB-19 (خرابی تزریقی واقعی + کنترل منفی + تحویل HTTP)"
  npm run test:observability49 --silent 2>&1 | tail -25
  B=${PIPESTATUS[0]}

  echo
  echo "## بخش ۳ — scrape واقعی از سرور تازه (نمونهٔ متن Prometheus)"
  TMPD=$(mktemp -d)
  PORT=$(( (RANDOM % 2000) + 18000 ))
  PAYESH_DATA="$TMPD" PORT=$PORT HOST=127.0.0.1 PAYESH_LOG=0 PAYESH_AUTO_BACKUP=0 \
    node $FLAGS server/index.js > "$TMPD/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null && break; sleep 0.1; done
  echo "# GET /healthz → $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/healthz)"
  echo "# GET /readyz  → $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/readyz)"
  echo "# GET /metrics → $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/metrics)"
  curl -s "http://127.0.0.1:$PORT/metrics" > "$TMPD/metrics.txt"
  echo "# families=$(grep -c '^# TYPE ' "$TMPD/metrics.txt") series=$(grep -vc '^#' "$TMPD/metrics.txt")"
  echo "----- (نمونه: ۲۰ خط اول) -----"
  head -20 "$TMPD/metrics.txt"
  echo "----- (پایان نمونه) -----"
  kill "$SRV" 2>/dev/null
  rm -rf "$TMPD"
  C=$?

  echo
  echo "## بخش ۴ — رگرسیون: آزمون‌های موجود دست‌نخورده"
  npm test --silent 2>&1 | tail -4
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# rules_check_exit:    $A"
  echo "# observability_exit:  $B"
  echo "# scrape_exit:         $C"
  echo "# regression_exit:     $R"
  echo "# OWNER-REMAINING: تحویل به Pager بیرونی + تعیین on-call — ردیف ۵۸ (OWNER)."
  if [ "$A" -eq 0 ] && [ "$B" -eq 0 ] && [ "$C" -eq 0 ] && [ "$R" -eq 0 ]; then
    echo "# EXIT=0"
    echo "OBSERVABILITY-49-OK"
  else
    echo "# EXIT=1"
    echo "OBSERVABILITY-49-FAILED"
  fi
} > "$OUT" 2>&1

tail -22 "$OUT"
grep -q '^OBSERVABILITY-49-OK$' "$OUT"
