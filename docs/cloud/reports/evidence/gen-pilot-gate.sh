#!/usr/bin/env bash
# دروازهٔ پایلوت چند‌مدرسه‌ای — ردیف ۳۰ · FAIL-CLOSED
#
# چه چیزی را اثبات می‌کند (و چه چیزی را نه):
#   ✔ دو tenant پایلوت روی PostgreSQL واقعی، از مسیر خود محصول
#   ✔ مهاجرت کنترل‌شدهٔ یک مدرسهٔ موجود + reconciliation (شمارش و هش محتوا)
#   ✔ rollback واقعی و محدود به مستأجر هدف، بدون آسیب به مستأجر دیگر و به منبع
#   ✔ re-apply idempotent و reconciliation دوباره
#   ✔ پایش per-tenant با ابزار اجرایی (scripts/pilot-tenant-report.mjs)
#   ✔ stop criteria با اعداد اندازه‌گیری‌شده
#   ✔ آزمون منفی: خرابی عمدی در مقصد باید توسط reconciliation گرفته شود،
#     و آستانهٔ ناممکن در پایش باید هشدار بدهد (پایش ساکت نیست)
#   ✘ خوشهٔ PostgreSQL تولیدی، چند‌ناحیه‌ای، و بار واقعی مدارس — ادعا نمی‌شود
#
# اجرا: bash docs/cloud/reports/evidence/gen-pilot-gate.sh
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
P=$D/pilot
OUT="${PILOT_OUT:-$D/cc-pilot-gate.txt}"
DR_OUT="${PILOT_DR_OUT:-$D/pilot-migration-drill.txt}"
MON_OUT="${PILOT_MON_OUT:-$D/pilot-tenant-monitoring.txt}"
HEAD=$(git rev-parse HEAD)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECKS=0

# مسیر باینری PostgreSQL: EMBEDDED_PG_HOME، وگرنه نصب سیستمی (CI)
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
if [ ! -x "$BIN/initdb" ]; then
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql*/bin; do
    if [ -x "$d/initdb" ]; then BIN="$d"; LIB=""; break; fi
  done
fi
PGPORT_=${PILOT_PORT:-5640}
APPPORT=${PILOT_APP_PORT:-5641}
TENANT_A=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa
TENANT_B=bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb

ok() { CHECKS=$((CHECKS + 1)); }
fail() {
  echo "PILOT-GATE-FAIL: $1" >&2
  { echo "# دروازهٔ پایلوت — شکست"; echo "head: $HEAD"; echo "reason: $1"; } > "$D/cc-pilot-gate.FAILED-$TS.txt"
  exit 1
}

# ── ۰) پیش‌نیاز: امنیت و DR و جداسازی مستأجر باید سبز باشند ───────────────
[ -f "$D/cc-security-gate.txt" ] && grep -q 'SECURITY-GATE-CLOSED' "$D/cc-security-gate.txt" \
  || fail "PREREQ: دروازهٔ امنیت (ردیف ۲۸) سبز نیست"
ok
[ -f "$D/cc-capacity-gate.txt" ] && grep -q 'CAPACITY-GATE-CLOSED' "$D/cc-capacity-gate.txt" \
  || fail "PREREQ: دروازهٔ ظرفیت/DR (ردیف ۲۹) سبز نیست"
ok
[ -f "$D/f05-product-tenancy.txt" ] && grep -q 'F05-PG-OK checks=12' "$D/f05-product-tenancy.txt" \
  || fail "PREREQ: جداسازی مستأجر در محصول (F‑05) سبز نیست"
ok
if [ ! -x "$BIN/initdb" ]; then
  echo "PILOT-BLOCKED: ENVIRONMENT UNAVAILABLE (no PostgreSQL binary)" >&2
  { echo "# دروازهٔ پایلوت — BLOCKED"; echo "head: $HEAD"; echo "reason: no PostgreSQL binary"; } > "$D/cc-pilot-gate.BLOCKED-$TS.txt"
  exit 3
fi
ok
[ -f "$P/pilot-drill.cjs" ] && [ -f scripts/pilot-tenant-report.mjs ] || fail "FILES: هارنس پایلوت یا اسکریپت پایش نیست"
ok

# ── ۱) PostgreSQL واقعی (موقت، بیرون از مخزن) ────────────────────────────
PGDATA=$(mktemp -d)
APPDATA=$(mktemp -d)
cleanup() { "$BIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1; rm -rf "$PGDATA" "$APPDATA"; }
trap cleanup EXIT

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$PGDATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || fail "ENV: initdb شکست"
"$BIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1" -l "$PGDATA/pg.log" start >/dev/null 2>&1 \
  || { tail -5 "$PGDATA/pg.log" >&2; fail "ENV: PostgreSQL بالا نیامد"; }
ok

node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.argv[1] });
  await c.connect();
  await c.query("CREATE DATABASE payesh_pilot");
  await c.query("CREATE ROLE payesh_runtime LOGIN");
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || fail "ENV: ساخت پایگاه‌داده/نقش پایلوت شکست"
ok

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_pilot"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_pilot"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# دروازهٔ پایلوت چند‌مدرسه‌ای — ردیف ۳۰"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-pilot-gate.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $HEAD"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo "# postgres: $("$BIN/postgres" --version 2>&1 | awk '{print $3}') (باینری موقت بیرون از مخزن)"
  echo "# tenants: A=$TENANT_A (مهاجرت‌شده) · B=$TENANT_B (فراهم‌شده)"
  echo
} > "$DR_OUT"

# ── ۲) دریل اصلی: مهاجرت + reconciliation + rollback + پایش + stop criteria ─
set +e
PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" \
APP_PORT="$APPPORT" PAYESH_DATA="$APPDATA" \
  node --experimental-sqlite --disable-warning=ExperimentalWarning "$P/pilot-drill.cjs" 2>&1 | tee -a "$DR_OUT"
RC=${PIPESTATUS[0]}
set -e
[ "$RC" = "0" ] || fail "DRILL: پایلوت شکست خورد (exit=$RC) — $DR_OUT"
ok
grep -q '^PILOT-OK' "$DR_OUT" || fail "DRILL: جمع‌بندی سبز نیست"
ok
grep -qE '^PILOT-RECON tenant=A .*match=1' "$DR_OUT" || fail "RECON: هیچ reconciliation برابری ثبت نشد"
ok
RECON_LINES=$(grep -cE '^PILOT-RECON .*match=1' "$DR_OUT")
[ "$RECON_LINES" -ge 2 ] || fail "RECON: انتظار حداقل دو بار reconciliation برابر (پس از مهاجرت و پس از re-apply) — $RECON_LINES"
ok
grep -qE '^PILOT-ROLLBACK tenant=A rows_after=0 .*b_intact=1 source_intact=1' "$DR_OUT" || fail "ROLLBACK: بازگشت واقعی/محدود به مستأجر اثبات نشد"
ok
MON_A=$(grep -cE "^PILOT-MON tenant=$TENANT_A " "$DR_OUT")
MON_B=$(grep -cE "^PILOT-MON tenant=$TENANT_B " "$DR_OUT")
[ "$MON_A" -ge 1 ] && [ "$MON_B" -ge 1 ] || fail "MON: پایش هر دو مستأجر در دریل ثبت نشد"
ok
STOP_N=$(grep -cE '^PILOT-STOP S[0-9] ' "$DR_OUT")
[ "$STOP_N" -ge 4 ] || fail "STOP: معیارهای توقف ارزیابی نشد ($STOP_N)"
grep -qE '^PILOT-STOP .*verdict=BREACH' "$DR_OUT" && fail "STOP: معیار توقفی نقض شده است"
ok

# ── ۳) آزمون منفی ۱: خرابی عمدی در مقصد ⇒ reconciliation باید بگیرد ───────
NEGDIR=$(mktemp -d)
set +e
PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" \
APP_PORT="$APPPORT" PAYESH_DATA="$NEGDIR" PILOT_SELFCHECK_MISMATCH=1 \
  node --experimental-sqlite --disable-warning=ExperimentalWarning "$P/pilot-drill.cjs" > "$NEGDIR/neg.log" 2>&1
NEGRC=$?
set -e
[ "$NEGRC" = "0" ] || { tail -3 "$NEGDIR/neg.log" >&2; rm -rf "$NEGDIR"; fail "NEGATIVE-SELF: آشکارساز reconciliation در آزمون منفی سبز نشد (exit=$NEGRC)"; }
grep -q 'mismatch_detected=1' "$NEGDIR/neg.log" || { rm -rf "$NEGDIR"; fail "NEGATIVE-SELF: نشانهٔ تشخیص ناهمخوانی ثبت نشد"; }
grep -qE 'PILOT-RECON .*match=0' "$NEGDIR/neg.log" || { rm -rf "$NEGDIR"; fail "NEGATIVE-SELF: reconciliation ناهمخوانی را match=0 نکرد"; }
rm -rf "$NEGDIR"
ok

# ── ۴) پایش per-tenant: سبز واقعی + حساسیت به آستانه ─────────────────────
{
  echo "# شاهد خام پایش per-tenant — ردیف ۳۰"
  echo "# HEAD: $HEAD · $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$MON_OUT"
for tid in "$TENANT_A" "$TENANT_B"; do
  PAYESH_TENANCY_PG="$RUNTIME_URL" node scripts/pilot-tenant-report.mjs --tenant="$tid" >> "$MON_OUT" 2>&1
  RC=$?
  [ "$RC" = "0" ] || fail "MON: گزارش مستأجر ${tid:0:4} سبز نیست (exit=$RC)"
done
ok
grep -q '"rls_enforced":true' "$MON_OUT" || fail "MON: RLS اجباری در گزارش نیست"
ok
grep -q '"cross_tenant_visible":0' "$MON_OUT" || fail "MON: نشت بین‌مستأجری در گزارش ثبت شده"
# گزارش کل ناوگان: هر دو مستأجر در یک اجرا (پوشش کامل ردیف‌ها)
PAYESH_TENANCY_PG="$RUNTIME_URL" PAYESH_TENANCY_ADMIN_URL="$ADMIN_URL" \
  node scripts/pilot-tenant-report.mjs --tenant="$TENANT_A,$TENANT_B" >> "$MON_OUT" 2>&1 \
  || fail "MON: گزارش کل ناوگان سبز نیست"
grep -q '"rows_outside_reported"' "$MON_OUT" && fail "MON: ردیف بیرون از مستأجرهای گزارش‌شده وجود دارد"
ok

set +e
PAYESH_TENANCY_PG="$RUNTIME_URL" node scripts/pilot-tenant-report.mjs --tenant="$TENANT_B" --min-rows=999999 >> "$MON_OUT" 2>&1
STRICTRC=$?
set -e
[ "$STRICTRC" = "2" ] || fail "MON-NEGATIVE: آستانهٔ ناممکن هشدار نداد (exit=$STRICTRC) — پایش ساکت است"
ok

# ── ۵) اسناد پایلوت: runbook + Go/No-Go ─────────────────────────────────
RUNBOOK=docs/cloud/18-pilot-runbook.md
GONOGO=docs/cloud/reports/PILOT-GO-NO-GO.md
[ -f "$RUNBOOK" ] || fail "DOC: $RUNBOOK نیست"
[ -f "$GONOGO" ] || fail "DOC: $GONOGO نیست"
for KEY in "مهاجرت" "reconciliation" "rollback" "پایش" "معیار توقف" "Go/No-Go" "پایلوت"; do
  grep -q "$KEY" "$RUNBOOK" || fail "DOC: بخش «$KEY» در runbook نیست"
done
grep -q 'verdict' "$GONOGO" 2>/dev/null || grep -qE 'GO|NO-GO' "$GONOGO" || fail "DOC: حکم Go/No-Go در سند نیست"
ok

{
  echo "# دروازهٔ پایلوت چند‌مدرسه‌ای — ردیف ۳۰"
  echo "generated_by: docs/cloud/reports/evidence/gen-pilot-gate.sh"
  echo "head: $HEAD"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "drill_witness: $DR_OUT"
  echo "monitoring_witness: $MON_OUT"
  echo "tenants: $TENANT_A,$TENANT_B"
  echo "reconciliation: match=1 (post-migration و post-reapply)"
  echo "rollback: tenant_scoped=1 source_intact=1"
  echo "negative_tests: tamper_detected=1 threshold_alert=1"
  echo "checks_passed: $CHECKS"
  echo "honest_scope: single_host · embedded_postgres · no_production_cluster · no_real_school_traffic"
  echo "row-30: CLOSED"
  echo
  echo "PILOT-GATE-CLOSED checks=$CHECKS tenants=2 recon=ok rollback=ok monitor=ok"
} > "$OUT"
echo "→ $OUT"
echo "PILOT-GATE-CLOSED checks=$CHECKS tenants=2 recon=ok rollback=ok monitor=ok"
