#!/usr/bin/env bash
# شاهد ردیف ۳۷ — Gateway نازک و بی‌حالت (دو نمونه، RLS، سقف‌ها، سهمیه، healthz/readyz)
# اجرا: bash docs/cloud/reports/evidence/run-37-gateway.sh
# خروجی سبز: docs/cloud/reports/evidence/gateway-37.txt
# اگر PostgreSQL واقعی در دسترس نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

export LC_ALL=C.UTF-8

# نمونه‌های سرگردانِ اجراهای قبلی (با SECRET قدیمی) اگر پورت‌ها را بگیرند، آزمون را
# به‌اشتباه قرمز می‌کنند؛ فقط فرایندهای همین مخزن بسته می‌شوند.
pkill -f "server/gateway.js" 2>/dev/null || true
sleep 1

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${GW_PGPORT:-5640}
GW1=${GW1_PORT:-5641}
GW2=${GW2_PORT:-5642}
GWQ=${GW3_PORT:-5643}
OUT=${GW_OUT:-$D/gateway-37.txt}

if [ ! -x "$BIN/initdb" ]; then
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE (no PostgreSQL binary: $BIN/initdb)"
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE" > "$OUT"
  exit 3
fi

HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
PGVER=$("$BIN/postgres" --version 2>&1 | awk '{print $3}')
NODE=$(node -v)

DATA=$(mktemp -d)
cleanup() {
  "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$DATA"
}
trap cleanup EXIT

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$DATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || {
  echo "BLOCKED — initdb failed" >&2; echo "BLOCKED — initdb failed" > "$OUT"; exit 3; }
"$BIN/pg_ctl" -D "$DATA" -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/pg.log" start >/dev/null 2>&1 || {
  echo "BLOCKED — server did not start" >&2; tail -5 "$DATA/pg.log" >&2; echo "BLOCKED — server did not start" > "$OUT"; exit 3; }

node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.argv[1] });
  await c.connect();
  await c.query("CREATE DATABASE payesh_gw37");
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || {
  echo "BLOCKED — createdb failed" >&2; echo "BLOCKED — createdb failed" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_gw37"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_gw37"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# شاهد ردیف ۳۷ — Gateway نازک و بی‌حالت (دو نمونهٔ واقعی + PostgreSQL واقعی)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# postgres: $PGVER (embedded-postgres — باینری بیرون از مخزن)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-37-gateway.sh"
  echo "# instances: gw1=:$GW1 gw2=:$GW2 quota=:$GWQ (+ یک نمونهٔ بی‌DB برای تفکیک liveness/readiness)"
  echo
  PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" \
  GW1_PORT="$GW1" GW2_PORT="$GW2" GW3_PORT="$GWQ" \
    node --experimental-sqlite --disable-warning=ExperimentalWarning tests/gateway-pg.js
  CODE=$?
  echo
  echo "## اندازه‌گیری مستقیم: سهمیه و idempotency در دیتابیس (نه در حافظهٔ نمونه)"
  PGURL_ADMIN="$ADMIN_URL" node -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.PGURL_ADMIN });
    await c.connect();
    const q = await c.query("select count(*)::int n, count(distinct tenant_id)::int t from gateway_quota");
    console.log("quota_rows=" + q.rows[0].n + " tenants=" + q.rows[0].t);
    const o = await c.query("select count(*)::int n from product_ops");
    console.log("idempotency_keys=" + o.rows[0].n);
    const f = await c.query("select count(*)::int n from product_change_feed");
    console.log("feed_rows=" + f.rows[0].n);
    const p = await c.query("select relname, relrowsecurity r, relforcerowsecurity f from pg_class where relname in ($1,$2) order by relname", ["product_ops","gateway_quota"]);
    for (const row of p.rows) console.log("table " + row.relname + ": rls=" + row.r + " force=" + row.f);
    await c.end();
  })().catch(e => { console.error(e.message); process.exit(1); });
  ' || CODE=1
  echo
  echo "## عدم رگرسیون: change-feed (۳۶) و tenancy/RLS (۲۶) روی همین سرور، پایگاه‌دادهٔ تازه"
  node -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.argv[1] });
    await c.connect();
    await c.query("CREATE DATABASE payesh_gw37_reg");
    await c.end();
  })().catch(e => { console.error(e.message); process.exit(1); });
  ' "postgres://postgres@127.0.0.1:$PGPORT_/postgres"
  
  REG_ADMIN="postgres://postgres@127.0.0.1:$PGPORT_/payesh_gw37_reg"
  REG_RUNTIME="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_gw37_reg"
  REGDATA=$(mktemp -d)
  PGURL_ADMIN="$REG_ADMIN" PGURL_RUNTIME="$REG_RUNTIME" TENANCY_SECRET="$SECRET" \
  APP_PORT="$((GWQ + 10))" PAYESH_DATA="$REGDATA" \
    node --experimental-sqlite --disable-warning=ExperimentalWarning tests/tenancy-pg.js > "$DATA/f05.log" 2>&1
  F05CODE=$?
  grep -E "F05-PG|^FAIL " "$DATA/f05.log" | tail -4
  if ! grep -q "F05-PG-OK" "$DATA/f05.log"; then
    echo "رگرسیون tenancy شکست خورد؛ ۲۰ خط آخر:"
    tail -20 "$DATA/f05.log"
    CODE=1
  fi
  rm -rf "$REGDATA"
  echo "(f05_exit=$F05CODE)"
  echo
  if [ $CODE -eq 0 ]; then echo "GATEWAY-37-OK"; else echo "GATEWAY-37-FAIL (exit=$CODE)"; fi
} > "$OUT" 2>&1

if grep -q "GATEWAY-37-OK" "$OUT"; then
  echo "→ $OUT"
  tail -2 "$OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  grep -E "^FAIL " "$OUT" | head -10 >&2
  tail -6 "$OUT" >&2
  exit 1
fi
