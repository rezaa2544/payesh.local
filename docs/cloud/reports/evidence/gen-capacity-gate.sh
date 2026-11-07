#!/usr/bin/env bash
# دروازهٔ ظرفیت/HA/DR — ردیف ۲۹ · FAIL-CLOSED
#
# چه چیزی را اثبات می‌کند (و چه چیزی را نه):
#   ✔ بار واقعی خواندن/نوشتن هم‌زمان روی محصول واقعی (p95/p99، CPU، RSS)
#   ✔ سقف ظرفیت اندازه‌گیری‌شده روی همین میزبان (نه ادعای مقیاس تولیدی)
#   ✔ قطع ناگهانی فرایند ⇒ بازگشت سرویس و سالم‌ماندن داده
#   ✔ از دست رفتن کامل فایل پایگاه‌داده ⇒ بازیابی واقعی از پشتیبان امضاشده (RTO)
#   ✔ RPO اندازه‌گیری‌شده (تأخیر آینه) و پروب هشدار که در قطعی «بحرانی» می‌شود
#   ✘ HA چندسروری، failover خودکار، پارتیشن شبکه، SLA — وجود ندارد و ادعا نمی‌شود
#
# اجرا: bash docs/cloud/reports/evidence/gen-capacity-gate.sh
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
C=$D/capacity
OUT="${CAP_OUT:-$D/cc-capacity-gate.txt}"
LOAD_OUT="${CAP_LOAD_OUT:-$D/capacity-mixed-load.txt}"
DR_OUT="${CAP_DR_OUT:-$D/capacity-dr-drill.txt}"
MON_OUT="${CAP_MON_OUT:-$D/capacity-monitoring.txt}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0
NODE="node --experimental-sqlite --disable-warning=ExperimentalWarning"

ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "CAP-FAIL: $1" >&2
  { echo "# دروازهٔ ظرفیت/DR — شکست"; echo "head: $HEAD"; echo "reason: $1"; } \
    > "$D/cc-capacity-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۰) پیش‌نیاز: دروازه‌های قبلی باید سبز باشند ──────────────────────────
[ -f "$D/cc-security-gate.txt" ] || fail "PREREQ: cc-security-gate.txt نیست (ردیف ۲۸ باید اول بسته شود)"
grep -q 'SECURITY-GATE-CLOSED' "$D/cc-security-gate.txt" || fail "PREREQ: دروازهٔ امنیت سبز نیست"
for pair in "f01:F01-CLOSED" "f02:F02-CLOSED" "f04:F04-CLOSED" "f06:F06-CLOSED" "sync:SYNC-CLOSED"; do
  G=${pair%%:*}; MARK=${pair#*:}
  [ -f "$D/cc-$G-gate.txt" ] || fail "PREREQ: شاهد cc-$G-gate.txt نیست"
  grep -q "$MARK" "$D/cc-$G-gate.txt" || fail "PREREQ: $MARK در شاهد نیست"
done
ok
[ -f "$D/f05-product-tenancy.txt" ] && grep -q 'F05-PG-OK checks=12' "$D/f05-product-tenancy.txt" \
  || fail "PREREQ: شاهد PostgreSQL مستأجر سبز نیست"
ok
[ -f server/index.js ] && [ -f scripts/healthcheck.mjs ] || fail "FILES: کد محصول یا پروب پایش نیست"
ok

# ── ۱) بار ترکیبی خواندن/نوشتن ───────────────────────────────────────────
$NODE "$C/mixed-load.cjs" --concurrency=1,8,16,32 --seconds=5 --out="$LOAD_OUT" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] || fail "LOAD: سنجش بار شکست (exit=$RC) — $LOAD_OUT"
ok
grep -qE '^LOAD-CAP max_ok_concurrency=[1-9]' "$LOAD_OUT" || fail "LOAD-CAP: هیچ سطح موفقی ثبت نشده"
ok
grep -E '^LOAD level=' "$LOAD_OUT" | grep -qE 'read_p95=[0-9]+' || fail "LOAD: ستون p95 خواندن نیست"
ok
grep -E '^LOAD level=' "$LOAD_OUT" | grep -qE 'write_p99=[0-9]+' || fail "LOAD: ستون p99 نوشتن نیست"
ok
grep -E '^LOAD level=' "$LOAD_OUT" | grep -qE 'cpu_pct=(n/a|[0-9.]+).*rss_max_mb=(n/a|[0-9.]+)' || fail "LOAD: منابع (CPU/RSS) اندازه‌گیری نشده"
ok
grep -q '^LOAD-ASSUMPTION.*no_sla_claim=1' "$LOAD_OUT" || fail "LOAD: فرض/محدودهٔ صادقانه اعلام نشده"
ok
MAXOK=$(grep -oE '^LOAD-CAP max_ok_concurrency=[0-9]+' "$LOAD_OUT" | head -1 | grep -oE '[0-9]+$')
[ "${MAXOK:-0}" -ge 4 ] || fail "LOAD-CAP: سقف اندازه‌گیری‌شده ($MAXOK) کمتر از کف پذیرش ۴ است"
ok
# آستانه‌های هدف سند ۰۴ در سطح «حداقل یک سطح»
grep -E '^LOAD level=' "$LOAD_OUT" | grep -qE 'read_p95=([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-9][0-9]|300)\b' || fail "LOAD: هیچ سطحی p95 خواندن ≤۳۰۰ms ندارد"
ok
grep -q 'LOAD-COST' "$LOAD_OUT" || fail "LOAD: هزینه محاسبه نشده"
ok

# ── ۲) آزمون منفی: آستانهٔ ناممکن ⇒ سنجش باید شکست بدهد ──────────────────
if [ -z "${CAP_NOSELFCHECK:-}" ]; then
  $NODE "$C/mixed-load.cjs" --concurrency=1 --seconds=3 --p95_read_max=0 >/dev/null 2>&1
  NEG=$?
  [ "$NEG" != "0" ] || fail "NEGATIVE-SELF: آستانهٔ ناممکن دروازه را رد نکرد"
fi
ok

# ── ۳) تمرین DR: قطعی، بازیابی، RPO/RTO ─────────────────────────────────
$NODE "$C/dr-drill.cjs" --out="$DR_OUT" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] || fail "DR: تمرین شکست (exit=$RC) — $DR_OUT"
ok
grep -qE '^DR-OUTAGE users_before=[1-9][0-9]* .*new_process_up=1 .*reauth=1' "$DR_OUT" || fail "DR-OUTAGE: بازگشت سرویس/احراز هویت پس از قطعی اثبات نشد"
ok
BOUT=$(grep -oE '^DR-OUTAGE users_before=[0-9]+' "$DR_OUT" | grep -oE '[0-9]+$')
AOUT=$(grep -oE '^DR-OUTAGE .*users_after=[0-9]+' "$DR_OUT" | grep -oE 'users_after=[0-9]+' | grep -oE '[0-9]+$')
[ -n "$BOUT" ] && [ "$BOUT" = "$AOUT" ] || fail "DR-OUTAGE: یکپارچگی داده پس از قطعی حفظ نشد ($BOUT → $AOUT)"
ok
grep -qE '^DR-RPO .*measured_lag_ms=[0-9]+' "$DR_OUT" || fail "DR-RPO: تأخیر آینه اندازه‌گیری نشد"
ok
grep -qE '^DR-RPO .*within_target=1' "$DR_OUT" || fail "DR-RPO: RPO پیش‌فرض بیرون از هدف ۵ دقیقه است"
ok
grep -qE '^DR-RESTORE .*restored=1' "$DR_OUT" || fail "DR-RESTORE: بازیابی پس از از دست رفتن DB انجام نشد"
ok
grep -qE '^DR-RESTORE .*rto_ms=[0-9]+' "$DR_OUT" || fail "DR-RESTORE: RTO اندازه‌گیری نشد"
ok
grep -q 'DR-FAILOVER auto_failover=0' "$DR_OUT" || fail "DR: ادعای نادرست failover خودکار — باید صریح ۰ باشد"
ok
grep -q 'DR-SCOPE scope=local_single_host no_multi_node_ha=1' "$DR_OUT" || fail "DR: محدودهٔ صادقانه اعلام نشده"
ok
grep -q '^DR-DRILL-OK' "$DR_OUT" || fail "DR: جمع‌بندی سبز نیست"
ok

# ── ۴) مانیتورینگ/هشدار: پروب واقعی + قطعی + حساسیت ─────────────────────
$NODE "$C/monitor-probe.cjs" --out="$MON_OUT" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] || fail "MON: پروب پایش/هشدار شکست (exit=$RC) — $MON_OUT"
ok
grep -qE '^MON-HEALTHY exit=0' "$MON_OUT" || fail "MON: healthcheck روی سرویس سالم سبز نیست"
ok
grep -qE '^MON-STRICT exit=[12]' "$MON_OUT" || fail "MON: پروب با آستانهٔ سخت هشدار نداد (ساکت است)"
ok
grep -qE '^MON-DOWN exit=2' "$MON_OUT" || fail "MON: پروب در قطعی سرویس بحرانی نشد"
ok
grep -q 'readyz' "$MON_OUT" && grep -q 'MON-READYZ status=200' "$MON_OUT" || fail "MON: /api/readyz آماده نیست"
ok
grep -q 'MON-PROBE-OK' "$MON_OUT" || fail "MON: جمع‌بندی پروب سبز نیست"
ok

# ── ۵) مدل/سند عملیاتی باید اعداد اندازه‌گیری‌شده را داشته باشد ───────────
RUNBOOK=docs/cloud/16-ha-observability-cost.md
[ -f "$RUNBOOK" ] || fail "DOC: $RUNBOOK نیست"
for KEY in "readyz" "healthcheck.mjs" "RPO" "RTO" "Capacity" "ظرفیت"; do
  grep -q "$KEY" "$RUNBOOK" || fail "DOC: بخش «$KEY» در سند HA/مشاهده‌پذیری نیست"
done
ok

{
  echo "# دروازهٔ ظرفیت / HA / DR — ردیف ۲۹"
  echo "generated_by: docs/cloud/reports/evidence/gen-capacity-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "load_witness: $LOAD_OUT"
  echo "dr_witness: $DR_OUT"
  echo "monitoring_witness: $MON_OUT"
  echo "capacity_max_ok_concurrency: ${MAXOK}"
  echo "honest_scope: single_host · no_multi_node_ha · no_auto_failover · no_sla · no_network_simulation"
  echo "checks_passed: $CHECKS"
  echo "row-29: CLOSED"
  echo
  echo "CAPACITY-GATE-CLOSED checks=$CHECKS max_ok_concurrency=${MAXOK} dr=OK monitoring=OK"
} > "$OUT"
echo "→ $OUT"
echo "CAPACITY-GATE-CLOSED checks=$CHECKS max_ok_concurrency=${MAXOK} dr=OK monitoring=OK"
