#!/usr/bin/env bash
# شاهد ردیف ۴۶ — تست بار ناوگان کلاینت (هزاران کلاینت sync روی دیتابیس جدا)
# اجرا: bash docs/cloud/reports/evidence/run-46-fleet-load.sh
# خروجی: docs/cloud/reports/evidence/fleet-46.txt  +  fleet-46.json
# اگر PostgreSQL واقعی در دسترس نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

pkill -f "server/gateway.js" 2>/dev/null || true
sleep 1

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${FLEET_PGPORT:-5650}
GWPORT=${FLEET_GWPORT:-5651}
OUT=${FLEET_OUT:-$D/fleet-46.txt}
JSON=${FLEET_JSON:-$D/fleet-46.json}
STAGES=${FLEET_STAGES:-100,300,600,1200}
SECONDS_=${FLEET_STAGE_SECONDS:-10}

if [ ! -x "$BIN/initdb" ]; then
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE (no PostgreSQL binary: $BIN/initdb)"
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE" > "$OUT"
  exit 3
fi

HEAD=$(git rev-parse HEAD); BR=$(git rev-parse --abbrev-ref HEAD)
PGVER=$("$BIN/postgres" --version 2>&1 | awk '{print $3}')
SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")
DATA=$(mktemp -d)
GWLOG=$(mktemp)

cleanup() {
  kill "$GWPID" 2>/dev/null || true
  "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$DATA" "$GWLOG"
}
trap cleanup EXIT

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$DATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || {
  echo "BLOCKED — initdb failed" >&2; echo "BLOCKED — initdb failed" > "$OUT"; exit 3; }
"$BIN/pg_ctl" -D "$DATA" -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=400" -l "$DATA/pg.log" start >/dev/null 2>&1 || {
  echo "BLOCKED — server did not start" >&2; tail -5 "$DATA/pg.log" >&2; echo "BLOCKED — server did not start" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/postgres"
node -e '
const { Client } = require("pg");
(async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
  await c.query("CREATE DATABASE payesh_fleet"); await c.end(); })().catch(e => { console.error(e.message); process.exit(1); });
' "$ADMIN_URL" || { echo "BLOCKED — createdb failed" >&2; echo "BLOCKED" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_fleet"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_fleet"
GATEWAY="http://127.0.0.1:$GWPORT"

# Gateway با سهمیهٔ سخاوتمند: هدفِ این ردیف سقف سرویس است، نه آزمون سهمیه (ردیف ۳۷).
PORT=$GWPORT HOST=127.0.0.1 PGURL="$RUNTIME_URL" GW_SECRET="$SECRET" \
  GW_QUOTA_MAX=100000000 GW_QUOTA_WINDOW_SEC=60 GW_PULL_MAX=1000 GW_INSTANCE=fleet-gw PAYESH_LOG=0 \
  node server/gateway.js > "$GWLOG" 2>&1 &
GWPID=$!
for _ in $(seq 1 150); do curl -sf "$GATEWAY/healthz" > /dev/null && break; sleep 0.2; done
curl -sf "$GATEWAY/healthz" > /dev/null || {
  echo "BLOCKED — gateway did not start"; tail -5 "$GWLOG"
  { echo "BLOCKED — gateway did not start"; tail -5 "$GWLOG"; } > "$OUT"; exit 3; }

{
  echo "# شاهد ردیف ۴۶ — تست بار ناگهانی ناوگان کلاینت (pull دوره‌ای + push دسته‌ای)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)   os: $(uname -srm)   cpu: $(nproc) هسته"
  echo "# postgres: $PGVER (بانک جدا: payesh_fleet؛ کاربر برنامه: payesh_runtime)"
  echo "# gateway: http://127.0.0.1:$GWPORT (فرایند جدا از تست)"
  echo "# params: stages=$STAGES seconds=$SECONDS_ batch=${FLEET_PUSH_BATCH:-10} pull_limit=${FLEET_PULL_LIMIT:-200}"
  echo "# topology: DB و Gateway دو فرایند جدا روی همین میزبان هستند؛ تفکیک PHYSICAL میزبان در محیط مالک سنجیده می‌شود."
  echo "# تعریف سقف سالم: p99 pull/push < 2000ms و نرخ خطا < 1٪"
  echo

  echo "## بخش ۱ — پله‌های بار (هر پله با کلاینت‌های تازه و توکن خودشان)"
  PAYESH_PG_ADMIN_URL="$ADMIN_URL" PAYESH_PG_APP_URL="$RUNTIME_URL" PAYESH_TENANCY_SECRET="$SECRET" \
    PAYESH_GW_URL="$GATEWAY" node tools/fleet-load-46.mjs \
      --clients "$STAGES" --seconds "$SECONDS_" --json-out "$JSON"
  A=$?

  echo
  echo "## بخش ۲ — سلامت سرویس پس از بار (نباید پس از فشار مرده باشد)"
  echo "# /healthz → $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/healthz")"
  echo "# /readyz  → $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/readyz")"
  curl -s "$GATEWAY/metrics" | grep -E '^(payesh_db_connections|payesh_pg_pool_(total|idle|waiting)|payesh_ready) ' | sed 's/^/# metric: /'
  echo "# gateway_log_lines=$(wc -l < "$GWLOG")"

  echo
  echo "## بخش ۳ — رگرسیون: آزمون‌های موجود دست‌نخورده"
  npm test --silent 2>&1 | tail -3
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# fleet_exit:      $A"
  echo "# regression_exit: $R"
  echo "# NOTE: این عددها روی یک میزبان مشترک اندازه‌گیری شده‌اند؛ سقف تولید با تفکیک میزبان‌ها بازآزمایی شود."
  if [ "$A" -eq 0 ] && [ "$R" -eq 0 ]; then echo "# EXIT=0"; echo "FLEET-46-OK"; else echo "# EXIT=1"; echo "FLEET-46-FAIL"; fi
} > "$OUT" 2>&1

tail -30 "$OUT"
grep -q '^FLEET-46-OK$' "$OUT"
