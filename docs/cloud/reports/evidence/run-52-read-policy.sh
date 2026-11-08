#!/usr/bin/env bash
# شاهد ردیف ۵۲ — سیاست خواندن: replica فقط‌خواندنی در برابر read-your-writes
# اجرا: bash docs/cloud/reports/evidence/run-52-read-policy.sh
# خروجی: docs/cloud/reports/evidence/read-policy-52.txt
# بدون PostgreSQL واقعی ⇒ exit 3 با برچسب BLOCKED (نه PASS).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

pkill -f "server/gateway.js" 2>/dev/null || true
sleep 1

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${RP_PGPORT:-5670}
GWPORT=${RP_GWPORT:-5671}
OUT=${RP_OUT:-$D/read-policy-52.txt}
DEVICES=${RP_DEVICES:-40}
ROUNDS=${RP_ROUNDS:-5}

if [ ! -x "$BIN/initdb" ]; then
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE (no PostgreSQL binary)"
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE" > "$OUT"
  exit 3
fi

HEAD=$(git rev-parse --short HEAD); BR=$(git rev-parse --abbrev-ref HEAD)
PGVER=$("$BIN/postgres" --version 2>&1 | awk '{print $3}')
SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")
DATA=$(mktemp -d); GWLOG=$(mktemp); GWPID=""

cleanup() {
  [ -n "$GWPID" ] && kill "$GWPID" 2>/dev/null
  "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$DATA" "$GWLOG"
}
trap cleanup EXIT

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$DATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || {
  echo "BLOCKED — initdb failed" >&2; echo "BLOCKED" > "$OUT"; exit 3; }
"$BIN/pg_ctl" -D "$DATA" -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=200" -l "$DATA/pg.log" start >/dev/null 2>&1 || {
  echo "BLOCKED — server did not start" >&2; echo "BLOCKED" > "$OUT"; exit 3; }

node -e '
const { Client } = require("pg");
(async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
  await c.query("CREATE DATABASE payesh_read"); await c.end(); })().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || { echo "BLOCKED — createdb failed" >&2; echo "BLOCKED" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_read"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_read"
GATEWAY="http://127.0.0.1:$GWPORT"

# replica تنظیم نشده است ⇒ انتظار: همهٔ خواندن‌ها primary (همان تصمیم ردیف ۵۲)
PORT=$GWPORT HOST=127.0.0.1 PGURL="$RUNTIME_URL" GW_SECRET="$SECRET" \
  GW_QUOTA_MAX=100000000 GW_PULL_MAX=1000 GW_INSTANCE=rp-gw PAYESH_LOG=0 \
  PAYESH_PG_POOL_MAX=12 node server/gateway.js > "$GWLOG" 2>&1 &
GWPID=$!
for _ in $(seq 1 150); do curl -sf "$GATEWAY/healthz" > /dev/null && break; sleep 0.2; done
curl -sf "$GATEWAY/healthz" > /dev/null || {
  echo "BLOCKED — gateway did not start"; tail -5 "$GWLOG"; echo "BLOCKED" > "$OUT"; exit 3; }

{
  echo "# شاهد ردیف ۵۲ — replica فقط‌خواندنی و سیاست read-your-writes"
  echo "# branch: $BR   head: $HEAD   at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# postgres: $PGVER (بانک جدا: payesh_read)   node: $(node -v)"
  echo "# gateway: $GATEWAY (replica تنظیم نشده — پیش‌فرض تصمیم ردیف ۵۲)"
  echo "# بار: $DEVICES دستگاه × $ROUNDS دور؛ هر دور push و بلافاصله pull همان دستگاه"
  echo

  echo "## بخش ۱ — آزمون سیاست (RP-01..RP-09)"
  node tests/replica-52.js 2>&1 | tail -12
  T=${PIPESTATUS[0]}

  echo
  echo "## بخش ۲ — ناوردا روی Gateway واقعی: دستگاه نوشته‌های خودش را می‌بیند"
  PAYESH_GW_URL="$GATEWAY" PAYESH_PG_ADMIN_URL="$ADMIN_URL" PAYESH_TENANCY_SECRET="$SECRET" \
    node tools/read-policy-52.mjs --devices "$DEVICES" --rounds "$ROUNDS" | tee /tmp/rp52.json
  L=${PIPESTATUS[0]}

  echo
  echo "## بخش ۳ — سلامت سرویس پس از بار"
  echo "# /healthz → $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/healthz")"
  echo "# /readyz  → $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/readyz")"

  echo
  echo "## بخش ۴ — رگرسیون"
  npm test --silent 2>&1 | tail -3
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# policy_test_exit: $T"
  echo "# invariant_exit:   $L"
  echo "# regression_exit:  $R"
  echo "# NOTE: replica واقعی در این محیط وجود ندارد (provider/OWNER — ردیف ۵۶)."
  echo "#       آنچه سنجیده شد: مسیر تصمیم، برگشت کامل به primary، و ناوردای"
  echo "#       read-your-writes روی Gateway واقعی با PostgreSQL واقعی."
  if [ "$T" -eq 0 ] && [ "$L" -eq 0 ] && [ "$R" -eq 0 ]; then echo "# EXIT=0"; echo "READ-POLICY-52-EVIDENCE-OK";
  else echo "# EXIT=1"; echo "READ-POLICY-52-EVIDENCE-FAILED"; fi
} > "$OUT" 2>&1

sed -n '/بخش ۱/,$p' "$OUT" | tail -30
grep -q '^READ-POLICY-52-EVIDENCE-OK$' "$OUT"
