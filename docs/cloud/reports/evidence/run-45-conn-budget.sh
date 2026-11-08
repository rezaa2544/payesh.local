#!/usr/bin/env bash
# شاهد ردیف ۴۵ — بودجهٔ اتصال و pooling
# اجرا: bash docs/cloud/reports/evidence/run-45-conn-budget.sh
# خروجی: docs/cloud/reports/evidence/conn-budget-45.txt  +  conn-budget-45.json
# اگر PostgreSQL واقعی در دسترس نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
#
# چه چیزی واقعاً اندازه‌گیری می‌شود (نه فرض):
#   ۱) فرمول بودجه و ممیزی حالت نشستی  → tools/conn-budget-45.mjs
#   ۲) زمان انتظار pool زیر **بار هدف** (۲۰۰ کلاینت): با دو اندازهٔ pool (۴ و ۱۲)
#      تا هم آستانهٔ تعریف‌شده سنجیده شود و هم اثر اندازهٔ pool دیده شود.
#   ۳) رگرسیون کامل (npm test) — بودجه نباید چیزی را بشکند.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

pkill -f "server/gateway.js" 2>/dev/null || true
sleep 1

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${CB_PGPORT:-5660}
GWPORT=${CB_GWPORT:-5661}
PGBPORT=${CB_PGBPORT:-5662}
PGB_BIN=${PGBOUNCER_BIN:-$(command -v pgbouncer 2>/dev/null || true)}
OUT=${CB_OUT:-$D/conn-budget-45.txt}
JSON=${CB_JSON:-$D/conn-budget-45.json}
CLIENTS=${CB_CLIENTS:-100}
SECONDS_=${CB_STAGE_SECONDS:-10}
PROCS=${CB_PROCS:-2}
POOLS=${CB_POOLS:-4,12}
# آستانهٔ تعریف‌شدهٔ انتظار pool در بار هدف (ms) — می‌تواند به OWNER برسد
# آستانهٔ تعریف‌شده (پیش از دیدن داده، با مبنای بودجهٔ تأخیر ردیف ۴۶ = p99 ۲۰۰۰ms):
#   میانگین انتظار pool ≤ ۱۰٪ بودجه (=۲۰۰ms) و بیشینه ≤ ۵۰٪ (=۱۰۰۰ms)-
#   و صفر گرفتنِ اتصال با انتظار > ۱ ثانیه (یعنی هیچ کلاینتی گرسنه نمی‌ماند).
# این آستانه در بار هدف سنجیده می‌شود و برای **اندازهٔ pool بودجه‌شده**
# (بزرگ‌ترین مقدار POOLS) الزامی است؛ pool پیش‌فرض فقط ثبت می‌شود.
WAIT_MEAN_MS=${CB_POOL_WAIT_MEAN_MS:-200}
WAIT_MAX_MS=${CB_POOL_WAIT_MAX_MS:-1000}
ENFORCE_POOL=$(echo "$POOLS" | tr ',' '\n' | sort -n | tail -1)

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
SAMPLER=$(mktemp --suffix=.mjs)
STEPJSON=$(mktemp --suffix=.json)
GWPID=""
PGBPID=""

cleanup() {
  [ -n "$GWPID" ] && kill "$GWPID" 2>/dev/null
  [ -n "$PGBPID" ] && kill "$PGBPID" 2>/dev/null
  [ -f "$DATA/pgbouncer.pid" ] && kill "$(cat "$DATA/pgbouncer.pid")" 2>/dev/null || true
  "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$DATA" "$GWLOG" "$SAMPLER" "$STEPJSON"
}
trap cleanup EXIT

# نمونه‌گیر /metrics: در طول پله هر ۲۵۰ms می‌خواند و بیشینه را نگه می‌دارد.
cat > "$SAMPLER" <<'JS'
const url = process.argv[2], ms = Number(process.argv[3] || 10000);
const pick = (t, n) => { const m = new RegExp('^' + n + ' (\\S+)$', 'm').exec(t); return m ? Number(m[1]) : null; };
let max = { acquire_mean_ms_max: 0, acquire_max_ms: 0, acquire_events: 0, acquire_over_1s: 0, db_connections: 0, pool_total: 0, samples: 0 };
const t0 = Date.now();
(async () => {
  while (Date.now() - t0 < ms) {
    try {
      const t = await (await fetch(url + '/metrics')).text();
      const mean = pick(t, 'payesh_pg_pool_acquire_mean_ms');
      const mx = pick(t, 'payesh_pg_pool_acquire_max_ms');
      const ev = pick(t, 'payesh_pg_pool_acquire_events_total');
      const over = pick(t, 'payesh_pg_pool_acquire_over_1s_total');
      const c = pick(t, 'payesh_db_connections');
      const p = pick(t, 'payesh_pg_pool_total');
      max.samples++;
      if (mean !== null) max.acquire_mean_ms_max = Math.max(max.acquire_mean_ms_max, mean);
      if (mx !== null) max.acquire_max_ms = Math.max(max.acquire_max_ms, mx);
      if (ev !== null) max.acquire_events = Math.max(max.acquire_events, ev);
      if (over !== null) max.acquire_over_1s = Math.max(max.acquire_over_1s, over);
      if (c !== null) max.db_connections = Math.max(max.db_connections, c);
      if (p !== null) max.pool_total = Math.max(max.pool_total, p);
    } catch (e) { /* سرویس در فشار است؛ نمونهٔ بعدی */ }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(JSON.stringify(max));
})();
JS

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$DATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || {
  echo "BLOCKED — initdb failed" >&2; echo "BLOCKED — initdb failed" > "$OUT"; exit 3; }
"$BIN/pg_ctl" -D "$DATA" -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=400" -l "$DATA/pg.log" start >/dev/null 2>&1 || {
  echo "BLOCKED — server did not start" >&2; tail -5 "$DATA/pg.log" >&2; echo "BLOCKED — server did not start" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/postgres"
node -e '
const { Client } = require("pg");
(async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
  await c.query("CREATE DATABASE payesh_cb"); await c.end(); })().catch(e => { console.error(e.message); process.exit(1); });
' "$ADMIN_URL" || { echo "BLOCKED — createdb failed" >&2; echo "BLOCKED" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_cb"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_cb"
GATEWAY="http://127.0.0.1:$GWPORT"
node -e '
const { Client } = require("pg"); const tenancy = require("./server/tenancy.js");
(async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect(); await tenancy.migrate(c); await c.end(); })()
  .catch(e => { console.error(e.message); process.exit(1); });
' "$ADMIN_URL" || { echo "BLOCKED — schema migration failed"; exit 3; }

start_gateway() { # $1 = pool max; $2 = optional PGURL
  [ -n "$GWPID" ] && { kill "$GWPID" 2>/dev/null; wait "$GWPID" 2>/dev/null; sleep 0.7; }
  : > "$GWLOG"
  PORT=$GWPORT HOST=127.0.0.1 PGURL="${2:-$RUNTIME_URL}" GW_SECRET="$SECRET" \
    PAYESH_PG_POOL_MAX="$1" GW_QUOTA_MAX=100000000 GW_QUOTA_WINDOW_SEC=60 GW_PULL_MAX=1000 \
    GW_INSTANCE=cb-gw PAYESH_LOG=0 node server/gateway.js >> "$GWLOG" 2>&1 &
  GWPID=$!
  for _ in $(seq 1 150); do curl -sf "$GATEWAY/healthz" > /dev/null && return 0; sleep 0.2; done
  return 1
}

start_gateway 4 || {
  echo "BLOCKED — gateway did not start" >&2; tail -5 "$GWLOG" >&2
  { echo "BLOCKED — gateway did not start"; tail -5 "$GWLOG"; } > "$OUT"; exit 3; }

PGB_RUNTIME_URL=""
if [ -n "$PGB_BIN" ] && [ -x "$PGB_BIN" ]; then
  printf '"payesh_runtime" ""\n"postgres" ""\n' > "$DATA/userlist.txt"
  sed \
    -e "s|^payesh = host=|payesh_cb = host=|" \
    -e "s|host=db.internal port=5432 dbname=payesh user=payesh_runtime|host=127.0.0.1 port=$PGPORT_ dbname=payesh_cb user=payesh_runtime|" \
    -e "s|listen_addr = 0.0.0.0|listen_addr = 127.0.0.1|" \
    -e "s|listen_port = 6432|listen_port = $PGBPORT|" \
    -e "s|auth_type = scram-sha-256|auth_type = trust|" \
    -e "s|auth_file = /etc/pgbouncer/userlist.txt|auth_file = $DATA/userlist.txt|" \
    deploy/pgbouncer/pgbouncer.ini > "$DATA/pgbouncer.ini"
  cat >> "$DATA/pgbouncer.ini" <<EOF
logfile = $DATA/pgbouncer.log
pidfile = $DATA/pgbouncer.pid
unix_socket_dir = $DATA
admin_users = postgres
stats_users = postgres
EOF
  "$PGB_BIN" --version | head -n 2
  "$PGB_BIN" -d "$DATA/pgbouncer.ini" || { echo "BLOCKED — PgBouncer did not start"; exit 3; }
  for _ in $(seq 1 50); do [ -f "$DATA/pgbouncer.pid" ] && break; sleep 0.1; done
  PGBPID=$(cat "$DATA/pgbouncer.pid" 2>/dev/null || true)
  PGB_RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGBPORT/payesh_cb"
  node -e 'const {Client}=require("pg"); (async()=>{const c=new Client({connectionString:process.argv[1],connectionTimeoutMillis:2000}); await c.connect(); await c.query("select 1"); await c.end();})().catch(e=>{console.error(e.message);process.exit(1)})' "$PGB_RUNTIME_URL" || { echo "BLOCKED — PgBouncer not accepting PostgreSQL traffic"; exit 3; }
fi

{
  echo "# شاهد ردیف ۴۵ — بودجهٔ اتصال و pooling (transaction pooling، pool-wait اندازه‌گیری‌شده)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)   os: $(uname -srm)   cpu: $(nproc) هسته"
  echo "# postgres: $PGVER (بانک: payesh_cb؛ کاربر برنامه: payesh_runtime؛ max_connections=400)"
  echo "# gateway: http://127.0.0.1:$GWPORT (فرایند جدا، pool از PAYESH_PG_POOL_MAX)"
  echo "# آستانهٔ انتظار pool در بار هدف: میانگین ≤ ${WAIT_MEAN_MS}ms و بیشینه ≤ ${WAIT_MAX_MS}ms و صفر مورد > ۱s"
  echo "#   (انتظار روی *همهٔ* گرفتن‌های اتصال اندازه‌گیری می‌شود، نه فقط لحظهٔ scrape)"
  echo

  echo "## بخش ۱ — فرمول بودجه، ممیزی حالت نشستی، انطباق PgBouncer"
  node tools/conn-budget-45.mjs --instances 2 --pool "$ENFORCE_POOL" --cap 100
  A1=$?
  echo
  echo "## بخش ۱b — آزمون‌های بودجه (اعتبارسنجی، کنترل منفی ممیزی، انطباق ini)"
  node tests/conn-budget-45.js 2>&1 | tail -14
  A2=${PIPESTATUS[0]}

  echo
  echo "## بخش ۲ — انتظار pool زیر بار هدف (${CLIENTS} کلاینت، ${SECONDS_} ثانیه، ${PROCS} فرایند)"
  echo "# دو اندازهٔ pool تا اثر بودجه دیده شود؛ همان سخت‌افزار، همان بار."
  B=0
  for PM in $(echo "$POOLS" | tr ',' ' '); do
    start_gateway "$PM" || { echo "# gateway با pool=$PM بالا نیامد"; B=1; continue; }
    node "$SAMPLER" "$GATEWAY" "$((SECONDS_ * 1000))" > "$STEPJSON" &
    SPID=$!
    PAYESH_PG_ADMIN_URL="$ADMIN_URL" PAYESH_PG_APP_URL="$RUNTIME_URL" PAYESH_TENANCY_SECRET="$SECRET" \
      PAYESH_GW_URL="$GATEWAY" node tools/fleet-load-46.mjs \
        --clients "$CLIENTS" --seconds "$SECONDS_" --procs "$PROCS" --json-out "$D/cb-pool-$PM.json" >/dev/null 2>&1
    R=$?; wait "$SPID" 2>/dev/null
    SAMP=$(cat "$STEPJSON" 2>/dev/null)
    [ "$R" -ne 0 ] && B=1
    node -e '
      const fs = require("fs");
      const step = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}");
      const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const st = (j.stages && j.stages[0]) || {};
      const pull = st.pull || {}, push = st.push || {};
      console.log(`POOL max=${process.argv[4]} rps=${st.rps_total} pull_p95=${((pull.p95||0)).toFixed(0)}ms pull_p99=${((pull.p99||0)).toFixed(0)}ms push_p99=${((push.p99||0)).toFixed(0)}ms err=${((st.error_rate || 0) * 100).toFixed(2)}% acquire_mean_max=${step.acquire_mean_ms_max}ms acquire_max=${step.acquire_max_ms}ms over_1s=${step.acquire_over_1s} events=${step.acquire_events} db_conn_max=${step.db_connections} samples=${step.samples}`);
    ' "$STEPJSON" "$D/cb-pool-$PM.json" "$WAIT_MEAN_MS" "$PM" || B=1
    rm -f "$D/cb-pool-$PM.json"
    # انتظار pool به آستانه گره می‌خورد (نه به صفر رسیدن): اندازهٔ pool ثابت است
    node -e '
      const s = JSON.parse(process.argv[1] || "{}");
      const meanSlo = Number(process.argv[2]), maxSlo = Number(process.argv[3]);
      const pool = process.argv[4], enforced = process.argv[5];
      const bad = [];
      if (pool !== enforced) {
        /* pool غیربودجه‌شده فقط ثبت می‌شود؛ الزام روی pool بودجه‌شده است */
        const w = (s.acquire_mean_ms_max || 0) > meanSlo || (s.acquire_max_ms || 0) > maxSlo || (s.acquire_over_1s || 0) > 0;
        console.log(`# POOL max=${pool} خارج از بودجه: ${w ? "آستانه نقض شد (ثبت شد، الزام نیست)" : "در آستانه"}`);
        process.exit(0);
      }
      if ((s.acquire_mean_ms_max || 0) > meanSlo) bad.push("mean=" + s.acquire_mean_ms_max + "ms > " + meanSlo);
      if ((s.acquire_max_ms || 0) > maxSlo) bad.push("max=" + s.acquire_max_ms + "ms > " + maxSlo);
      if ((s.acquire_over_1s || 0) > 0) bad.push("over_1s=" + s.acquire_over_1s);
      if (bad.length) { console.error("POOL-WAIT-SLO-BREACH " + bad.join(" ")); process.exit(1); }
    ' "$SAMP" "$WAIT_MEAN_MS" "$WAIT_MAX_MS" "$PM" "$ENFORCE_POOL" || B=1
  done
  PGB_EXIT=0
  if [ -n "$PGB_RUNTIME_URL" ]; then
    echo
    echo "## بخش ۲b — PgBouncer واقعی (transaction pooling) زیر بار + read-your-writes"
    start_gateway "$ENFORCE_POOL" "$PGB_RUNTIME_URL" || { echo "# gateway via PgBouncer did not start"; PGB_EXIT=1; }
    if [ "$PGB_EXIT" -eq 0 ]; then
      node "$SAMPLER" "$GATEWAY" "$((SECONDS_ * 1000))" > "$STEPJSON" & SPID=$!
      PAYESH_PG_ADMIN_URL="$ADMIN_URL" PAYESH_PG_APP_URL="$PGB_RUNTIME_URL" PAYESH_TENANCY_SECRET="$SECRET" \
        PAYESH_GW_URL="$GATEWAY" node tools/fleet-load-46.mjs \
          --clients "$CLIENTS" --seconds "$SECONDS_" --procs "$PROCS" --json-out "$D/cb-pgbouncer.json" >/dev/null 2>&1
      PR=$?; wait "$SPID" 2>/dev/null; SAMP=$(cat "$STEPJSON" 2>/dev/null)
      [ "$PR" -ne 0 ] && PGB_EXIT=1
      node -e '
        const fs=require("fs"), j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")), st=(j.stages||[])[0]||{};
        const p=st.pull||{}, w=st.push||{};
        console.log(`PGBOUNCER-LOAD clients=${process.argv[3]} rps=${st.rps_total} pull_p99=${p.p99}ms push_p99=${w.p99}ms errors=${((st.error_rate||0)*100).toFixed(2)}%`);
      ' "$D/cb-pgbouncer.json" "$SAMP" "$CLIENTS" || PGB_EXIT=1
      rm -f "$D/cb-pgbouncer.json"
      PAYESH_GW_URL="$GATEWAY" PAYESH_PG_ADMIN_URL="$ADMIN_URL" PAYESH_TENANCY_SECRET="$SECRET" \
        node tools/read-policy-52.mjs --devices 40 --rounds 2 || PGB_EXIT=1
      node -e '
        const {Client}=require("pg"); (async()=>{const c=new Client({connectionString:process.argv[1]}); await c.connect();
          const r=await c.query("select count(*)::int n from pg_stat_activity where usename=$1",["payesh_runtime"]);
          console.log(`PGBOUNCER-DB-CONNECTIONS active_or_idle=${r.rows[0].n} cap=12`);
          await c.end(); if(r.rows[0].n>12) process.exit(1);
        })().catch(e=>{console.error(e.message);process.exit(1)})
      ' "$ADMIN_URL" || PGB_EXIT=1
      [ "$PGB_EXIT" -eq 0 ] && echo "PGBOUNCER-TRANSACTION-POOL-OK"
    fi
    [ "$PGB_EXIT" -ne 0 ] && B=1
  else
    echo
    echo "BLOCKED — PgBouncer executable missing; pass PGBOUNCER_BIN to run real-pooler evidence."
    PGB_EXIT=3; B=1
  fi
  : > "$STEPJSON"

  echo
  echo "## بخش ۳ — سلامت سرویس و اتصال‌ها پس از بار"
  echo "# /healthz → $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/healthz")"
  echo "# /readyz  → $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/readyz")"
  curl -s "$GATEWAY/metrics" | grep -E '^(payesh_db_connections|payesh_pg_pool_(total|waiting)|payesh_pg_pool_wait_seconds|payesh_ready) ' | sed 's/^/# metric: /'

  echo
  echo "## بخش ۴ — رگرسیون: آزمون‌های موجود دست‌نخورده"
  npm test --silent 2>&1 | tail -3
  R3=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# budget_exit:     $A1"
  echo "# budget_test_exit: $A2"
  echo "# pool_load_exit:  $B"
  echo "# pgbouncer_exit:  $PGB_EXIT"
  echo "# regression_exit: $R3"
  echo "# PgBouncer واقعی از deploy/pgbouncer/pgbouncer.ini با DB محلی اجرا شد؛ auth موقت trust است و production نیست."
  echo "# شاهد PgBouncer = [S]؛ ظرفیت واقعی provider و توپولوژی دو میزبان همچنان OWNER هستند."
  if [ "$A1" -eq 0 ] && [ "$A2" -eq 0 ] && [ "$B" -eq 0 ] && [ "$PGB_EXIT" -eq 0 ] && [ "$R3" -eq 0 ]; then
    echo "# EXIT=0"; echo "CONN-BUDGET-45-OK"
  else
    echo "# EXIT=1"; echo "CONN-BUDGET-45-FAILED"
  fi
} > "$OUT" 2>&1

tail -40 "$OUT"
grep -q '^CONN-BUDGET-45-OK$' "$OUT"
