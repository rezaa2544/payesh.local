#!/usr/bin/env bash
# شاهد ردیف ۴۲ — بودجهٔ درخواست/بایت همگام‌سازی (SYNC-COST-42)
# اجرا: bash docs/cloud/reports/evidence/run-42-sync-cost.sh
# خروجی سبز: docs/cloud/reports/evidence/sync-cost-42.txt  (پایان: SYNC-COST-42-OK)
# هیچ سرویس بیرونی لازم نیست: سرور واقعی محصول روی HTTP + IndexedDB + سوکت خام برای شمارش بایت.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${SC42_OUT:-$D/sync-cost-42.txt}
JSONOUT=${SC42_JSON:-$D/sync-cost-42.json}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
NODE=$(node -v)
VER=$(node -e "process.stdout.write(require('./package.json').version)")
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

{
  echo "# شاهد ردیف ۴۲ — هزینهٔ همگام‌سازی: سقف درخواست/بایت به‌ازای کاربر در روز"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-42-sync-cost.sh"
  echo "# measurement: بایت‌ها روی سوکت خام شمرده می‌شوند (هدر HTTP + بدنه)، agent=false، accept-encoding: identity"
  echo

  echo "## بخش ۱ — ۱۵ کنترل (SC-01..SC-15) روی سرور و کلاینت واقعی"
  TMPRUN=$(mktemp)
  trap 'rm -f "$TMPRUN"' EXIT
  SYNC_COST_OUT="$JSONOUT" node $FLAGS tests/sync-cost-42.js > "$TMPRUN" 2>&1
  A=$?
  cat "$TMPRUN"

  echo
  echo "## بخش ۲ — استخراج سنجه‌ها از خروجی خام (بدون جمع‌زدن دستی)"
  node $FLAGS -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
    const line = lines.find(l => l.startsWith("SYNC-COST-JSON "));
    if (!line) { console.log("json_line           MISSING"); process.exit(1); }
    const r = JSON.parse(line.slice("SYNC-COST-JSON ".length));
    const m = r.measured || {};
    const c = r.caps || {};
    const row = (k, v, unit) => console.log(k.padEnd(20) + v + (unit ? " " + unit : ""));
    row("checks_pass", r.checks.pass, "/ " + (r.checks.pass + r.checks.fail));
    row("etag_304_bytes", m.etag_304_bytes, "B (هدر+بدنهٔ ۰)");
    row("pull_200_empty_bytes", m.pull_200_empty_bytes, "B");
    row("pull_200_rows_bytes", m.pull_rows_bytes, "B (۱۳۲ ردیف)");
    row("saving_ratio", m.saving_ratio, "(پذیرش ≥۰٫۸۵)");
    row("push_120ops_up_bytes", m.push_120_bytes, "B (۱ درخواست)");
    row("backoff_jitter_ms", "[" + m.backoff_jitter_range.join(",") + "]", "(بازهٔ مجاز 500..1000)");
    row("reconnect_buckets", m.reconnect_spread_buckets, "/200 دستگاه (جهش=۱)");
    row("probes_idle_day", m.probes_idle_day, "درخواست/روز");
    row("idle_requests_day", m.idle_requests_day, "≤ " + c.idle_visible.requests);
    row("idle_bytes_day", m.idle_bytes_day, "B ≤ " + c.idle_visible.bytes);
    row("background_requests", m.background_requests_day, "≤ " + c.background.requests);
    const ok = r.checks.fail === 0
      && m.saving_ratio >= 0.85
      && m.idle_requests_day <= c.idle_visible.requests
      && m.idle_bytes_day <= c.idle_visible.bytes
      && m.background_requests_day <= c.background.requests;
    console.log("budget_within_caps " + ok);
    process.exit(ok ? 0 : 1);
  ' "$TMPRUN"
  V=$?

  echo
  echo "## بخش ۳ — دروازهٔ مستقل بودجه (همان چیزی که CI اجرا می‌کند)"
  node tools/sync-budget-42.cjs
  G=$?
  echo "budget_gate_exit: $G"

  echo
  echo "## بخش ۴ — سیم‌کشی واقعی (کد محصول، نه نمونه)"
  echo "server_etag_304:        $(grep -c "if-none-match" server/index.js) (server/index.js)"
  echo "pull_etag_in_sync:      $(grep -c "const etag = 'W/" server/sync.js) (server/sync.js)"
  echo "client_conditional_get: $(grep -c "if-none-match" client/app.js) (client/app.js)"
  echo "client_etag_store:      $(grep -c "payesh.pull_etag" client/app.js) (client/app.js)"
  echo "outbox_jitter:          $(grep -c "this.cfg.jitter" client/outbox-web.js) (client/outbox-web.js)"
  echo "adaptive_scheduler:     $(grep -c "PayeshSchedule" client/app.js) ارجاع در app.js"
  echo "scheduler_module:       $(wc -l < client/sync-schedule.js) خط"
  echo "fixed_live_polling:     $(grep -c "setInterval(() => { liveTick" client/app.js) (انتظار: ۰)"
  echo "fixed_sync_polling:     $(grep -c "setInterval(() => { if (S.online && S.session) syncNow" client/app.js) (انتظار: ۰)"
  echo "doc_lines:              $(wc -l < docs/cloud/42-sync-cost.md)"

  echo
  echo "## بخش ۵ — رگرسیون: دروازه‌های موجود دست‌نخورده و سبز"
  npm test --silent 2>&1 | tail -3
  R=${PIPESTATUS[0]}
  echo
  npm run test:outbox40 --silent 2>&1 | tail -2
  O=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# cost_test_exit: $A"
  echo "# metric_scan_exit: $V"
  echo "# budget_gate_exit: $G"
  echo "# regression_exit: $R"
  echo "# outbox_regression_exit: $O"
  if [ "$A" -eq 0 ] && [ "$V" -eq 0 ] && [ "$G" -eq 0 ] && [ "$R" -eq 0 ] && [ "$O" -eq 0 ]; then
    echo "# EXIT=0"
    echo "SYNC-COST-42-OK"
  else
    echo "# EXIT=1"
    echo "SYNC-COST-42-FAIL"
  fi
} > "$OUT" 2>&1

tail -26 "$OUT"
grep -q '^SYNC-COST-42-OK$' "$OUT"
