#!/usr/bin/env bash
# شاهد ردیف ۴۸ — دروازهٔ امنیت ایستا (SECURITY-48)
# اجرا: bash docs/cloud/reports/evidence/run-48-security-scan.sh
# خروجی سبز: docs/cloud/reports/evidence/security-48.txt  (پایان: SECURITY-48-OK)
# پیش‌نیاز: semgrep (SEMGREP_BIN یا PATH). نبودنِ آن = شکست، نه سبزی.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8
export SEMGREP_ENABLE_VERSION_CHECK=0

D=docs/cloud/reports/evidence
OUT=${SEC48_OUT:-$D/security-48.txt}
JSON=${SEC48_JSON:-$D/security-48.json}
SEMGREP=${SEMGREP_BIN:-semgrep}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
VER=$(node -e "process.stdout.write(require('./package.json').version)")

{
  echo "# شاهد ردیف ۴۸ — اسکن امنیتی ایستا + وابستگی در CI (blocking، نه advisory)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)   os: $(uname -srm)"
  echo "# semgrep: $("$SEMGREP" --version 2>&1 | head -1)"
  echo "# command: bash docs/cloud/reports/evidence/run-48-security-scan.sh"
  echo "# tools: npm audit (ادوایزری واقعی) · semgrep الگویی + taint · اسکن راز روی git ls-files"
  echo "# NOTE: این سند pentest انسانی نیست؛ وضعیت امنیت همچنان UNKNOWN است."
  echo

  echo "## بخش ۱ — دروازهٔ اصلی روی مخزن واقعی (G1..G6)"
  node tools/security-scan-48.mjs --semgrep "$SEMGREP" --json-out "$JSON"
  A=$?

  echo
  echo "## بخش ۲ — شمارش‌های پذیرش از خروجی JSON (بدون جمع‌زدن دستی)"
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const d = j.counts || {};
    const rows = [
      ["deps_prod_high",  d.deps_prod_high,  0,  "=0 إطلاقاً (هیچ استثنا)"],
      ["deps_dev_high",   d.deps_dev_high,   null, "همه در allowlist با دلیل+انقضا"],
      ["semgrep_error",   d.semgrep_error,   0,  "=0 (الگویی + taint)"],
      ["semgrep_warning", d.semgrep_warning, null, "زیر سقفِ هر قاعده"],
      ["untriaged",       d.untriaged,       0,  "=0 (قاعدهٔ تازه ممنوع)"],
      ["secrets",         d.secrets,         0,  "=0 (روی فایل‌های ردیابی‌شده)"],
    ];
    let bad = 0;
    for (const [k, v, want, note] of rows) {
      const ok = v !== undefined && (want === null ? true : v === want);
      if (!ok) bad++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${k.padEnd(16)} ${String(v).padStart(4)}  ${note}`);
    }
    const g = j.gates || {};
    for (const k of Object.keys(g)) console.log(`gate  ${k.padEnd(16)} ${g[k] === true ? "ok" : "FAIL"}`);
    process.exit(bad === 0 ? 0 : 1);
  ' "$JSON"
  B=$?

  echo
  echo "## بخش ۳ — آزمون ۱۲گانه شامل ۵ کنترل منفی (دروازه باید قرمز شود)"
  node tests/security-scan-48.js > /dev/null 2>&1
  C=$?
  echo "test:security48 exit=$C  (0 = هر ۵ کنترل منفی قرمز شدند و ۷ بررسی دیگر سبز)"

  echo
  echo "## بخش ۴ — سیاست استثناها و تریاژ (متن، نه ادعا)"
  echo "allowlist_entries:   $(node -e 'const a=require("./tools/deps-allowlist.json");const k=a.packages||a.entries||[];process.stdout.write(String(Array.isArray(k)?k.length:Object.keys(k).length))')"
  echo "triage_rules:        $(node -e 'const t=require("./tools/semgrep/triage.json");process.stdout.write(String(Object.keys(t.rules||{}).length))')"
  echo "all_have_reason:     $(node -e 'const t=require("./tools/semgrep/triage.json");process.stdout.write(String(Object.values(t.rules||{}).every(r=>r.reason&&r.reviewed_at)))')"
  echo "all_have_expiry:     $(node -e 'const a=require("./tools/deps-allowlist.json");const k=a.packages||a.entries||[];const l=Array.isArray(k)?k:Object.values(k);process.stdout.write(String(l.every(r=>r.reason&&r.expires)))')"

  echo
  echo "## بخش ۵ — سیم‌کشی CI (مسدودکننده، نه advisory)"
  echo "ci_step_present:     $(grep -c 'test:security48' .github/workflows/build.yml)"
  echo "sec_step_advisory:   $(node -e '
    const y = require("fs").readFileSync(".github/workflows/build.yml", "utf8");
    const i = y.indexOf("test:security48");
    const blk = y.slice(Math.max(0, y.lastIndexOf("- name:", i)), y.indexOf("- name:", i + 1) > 0 ? y.indexOf("- name:", i + 1) : y.length);
    process.stdout.write(/continue-on-error/.test(blk) ? "YES-BAD" : "NO");
  ')"
  echo "npm_script_gate:     $(node -e 'process.stdout.write(String(!!require("./package.json").scripts["security:scan"]))')"

  echo
  echo "## بخش ۶ — دامنهٔ اسکن (مسیرهای محصول واقعاً پوشش داده می‌شوند)"
  echo "rule_ids_pattern:    $(grep -c '^\s*- id: ' tools/semgrep/rules.yml)"
  echo "rule_ids_taint:      $(grep -c '^\s*- id: ' tools/semgrep/taint-rules.yml)"
  echo "include_roots_in_scan:$(grep -o 'server/\*\*\|client/\*\*' tools/security-scan-48.mjs | sort -u | tr '\n' ' ')"
  echo "doc_lines:           $(wc -l < docs/cloud/48-security-scan.md)"

  echo
  echo "## بخش ۷ — رگرسیون: بقیهٔ آزمون‌ها دست‌نخورده"
  npm test --silent 2>&1 | tail -4
  E=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# gate_exit:            $A"
  echo "# json_counts_exit:     $B"
  echo "# security48_test_exit: $C"
  echo "# regression_exit:      $E"
  echo "# OWNER-REMAINING: pentest مستقل انسانی روی مسیر ابری — وضعیت امنیت همچنان UNKNOWN."
  if [ "$A" -eq 0 ] && [ "$B" -eq 0 ] && [ "$C" -eq 0 ] && [ "$E" -eq 0 ]; then
    echo "# EXIT=0"
    echo "SECURITY-48-OK"
  else
    echo "# EXIT=1"
    echo "SECURITY-48-FAIL"
  fi
} > "$OUT" 2>&1

tail -30 "$OUT"
grep -q '^SECURITY-48-OK$' "$OUT"
