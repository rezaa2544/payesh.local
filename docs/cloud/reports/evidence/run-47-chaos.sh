#!/usr/bin/env bash
# شاهد ردیف ۴۷ — آزمون آشوب همگام‌سازی (CHAOS-47)
# اجرا: bash docs/cloud/reports/evidence/run-47-chaos.sh
# خروجی سبز: docs/cloud/reports/evidence/chaos-47.txt  (پایان: CHAOS-47-OK)
# هیچ سرویس بیرونی لازم نیست: سرور واقعی محصول + پروکسی خطا-تزریق TCP + IndexedDB.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${CH47_OUT:-$D/chaos-47.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
NODE=$(node -v)
VER=$(node -e "process.stdout.write(require('./package.json').version)")
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

{
  echo "# شاهد ردیف ۴۷ — آزمون آشوب همگام‌سازی (قطع شبکه، crash وسط push، replay، خارج از ترتیب، تغییر ساعت)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-47-chaos.sh"
  echo "# topology: server/index.js (فرایند جدا، SQLite واقعی) ← پروکسی TCP خطا-تزریق ← client/outbox-web.js (IndexedDB)"
  echo "# invariants: data_loss=0 · duplicate=0 · cross_tenant=0 (در همهٔ سناریوها)"
  echo

  echo "## بخش ۱ — ۱۴ سناریوی آشوب + ۳ کنترل منفی (CH-01..CH-17)"
  TMPRUN=$(mktemp)
  trap 'rm -f "$TMPRUN"' EXIT
  node $FLAGS tests/chaos-47.js > "$TMPRUN" 2>&1
  A=$?
  cat "$TMPRUN"

  echo
  echo "## بخش ۲ — استخراج سنجه‌های پذیرش از خروجی خام (بدون جمع‌زدن دستی)"
  node $FLAGS -e '
    const fs = require("fs");
    const src = process.argv[1];
    const lines = fs.readFileSync(src, "utf8").split("\n");
    const fail = lines.filter(l => l.startsWith("FAIL"));
    /* سناریوهای آشوب = CH-01..CH-14؛ سه کنترل منفی جدا شمرده می‌شوند */
    const scen = lines.filter(l => /^PASS\s+CH-\d\d/.test(l) && !/کنترل منفی/.test(l));
    const tally = lines.find(l => l.startsWith("CHAOS scenarios=")) || "CHAOS scenarios=MISSING";
    const neg = lines.filter(l => /کنترل منفی/.test(l));
    console.log("pass_checks        " + lines.filter(l => l.startsWith("PASS")).length);
    console.log("fail_checks        " + fail.length);
    console.log("chaos_scenarios    " + scen.length + "  (پذیرش: ≥۱۰)");
    console.log("tally              " + tally.replace(/^CHAOS /, ""));
    console.log("negative_controls  " + neg.length + "  (پذیرش: ۳)");
    console.log("negative_ok        " + (neg.length === 3 && neg.every(l => /gate would be RED/.test(l))));
    if (fail.length) { console.log("FAIL-LINES:"); fail.slice(0, 5).forEach(l => console.log("  " + l.slice(0, 200))); }
    const m = tally.match(/data_loss=(\d+) duplicate=(\d+) cross_tenant=(\d+)/);
    const clean = m && m[1] === "0" && m[2] === "0" && m[3] === "0";
    console.log("invariants_clean   " + clean);
    process.exit(fail.length === 0 && scen.length >= 10 && neg.length === 3 && clean ? 0 : 1);
  ' "$TMPRUN"
  V=$?

  echo
  echo "## بخش ۳ — سیم‌کشی واقعی (کد محصول، نه نمونه)"
  echo "server_spawn_in_test:     $(grep -c "server/index.js" tests/chaos-47.js)"
  echo "tcp_fault_injection:      $(grep -c "cut_mid_response\|cut_mid_request\|blackhole\|crash_on_response" tests/chaos-47.js)"
  echo "real_outbox_used:         $(grep -c "client/outbox-web" tests/chaos-47.js)"
  echo "server_restart_on_crash:  $(grep -c "SIGKILL" tests/chaos-47.js)"
  echo "doc_lines:                $(wc -l < docs/cloud/47-chaos-sync.md)"

  echo
  echo "## بخش ۴ — رگرسیون: دروازهٔ موجود دست‌نخورده و سبز"
  npm test --silent 2>&1 | tail -4
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# chaos_exit: $A"
  echo "# invariant_scan_exit: $V"
  echo "# regression_exit: $R"
  if [ "$A" -eq 0 ] && [ "$V" -eq 0 ] && [ "$R" -eq 0 ]; then
    echo "# EXIT=0"
    echo "CHAOS-47-OK"
  else
    echo "# EXIT=1"
    echo "CHAOS-47-FAIL"
  fi
} > "$OUT" 2>&1

tail -24 "$OUT"
grep -q '^CHAOS-47-OK$' "$OUT"
