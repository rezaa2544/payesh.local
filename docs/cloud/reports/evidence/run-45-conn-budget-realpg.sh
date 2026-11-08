#!/usr/bin/env bash
# شاهد تکمیلی ردیف ۴۵ — اندازهٔگیری انتظار pool (PAYESH_PG_POOL_MAX) روی PostgreSQL واقعی محلی
# اجرا: bash docs/cloud/reports/evidence/run-45-conn-budget-realpg.sh
# محیط: PostgreSQL واقعی محلی طبق تصمیم O-20 (بند ۱: pgserver در dev/CI مجاز است).
# خروجی: استاندارد (برای ضمیمه به شاهد ردیف ۴۵) + فایل JSON هر پله.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
PGHOST_=${CB45_PGHOST:-127.0.0.1}
PGPORT_=${CB45_PGPORT:-65300}
PGUSER_=${CB45_PGUSER:-postgres}
PGDB=${CB45_PGDB:-payesh_cb}
GWPORT=${CB45_GWPORT:-5663}
CLIENTS=${CB45_CLIENTS:-100}
SECONDS_=${CB45_SECONDS:-10}
PROCS=${CB45_PROCS:-2}
POOLS=${CB45_POOLS:-4,12}
WAIT_MEAN_MS=${CB45_POOL_WAIT_MEAN_MS:-200}
WAIT_MAX_MS=${CB45_POOL_WAIT_MAX_MS:-1000}
ENFORCE_POOL=$(echo "$POOLS" | tr ',' '\n' | sort -n | tail -1)

PGADMIN="postgres://$PGUSER_@$PGHOST_:$PGPORT_/$PGDB"
GATEWAY="http://127.0.0.1:$GWPORT"
SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")

PGB="C:/Program Files/PostgreSQL/16/bin"
[ -x "$PGB/psql.exe" ] || PGB=""
if [ -z "$PGB" ]; then echo "BLOCKED — psql/createdb executable not found"; exit 3; fi

"$PGB/dropdb.exe" -h "$PGHOST_" -p "$PGPORT_" -U "$PGUSER_" --if-exists "$PGDB" 2>/dev/null || true
"$PGB/createdb.exe" -h "$PGHOST_" -p "$PGPORT_" -U "$PGUSER_" "$PGDB" >/dev/null 2>&1 || {
  echo "BLOCKED — createdb failed on $PGHOST_:$PGPORT_/$PGDB"; exit 3; }

node -e '
const { Client } = require("pg"); const tenancy = require("./server/tenancy.js");
(async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
  await tenancy.migrate(c); await c.end(); })().catch(e => { console.error(e.message); process.exit(1); });
' "$PGADMIN" || { echo "BLOCKED — schema migration failed on real PG"; exit 3; }

TMPD=$(mktemp -d)
SAMPLER="$TMPD/sampler.mjs"
# مسیرهای بومی برای پردازش‌های node (ترجمهٔ مسیر MSYS در این محیط غیرفعال است)
W_SAMPLER=$(cygpath -w "$SAMPLER")
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
GWLOG=$(mktemp)
STEPJSON="$TMPD/step.json"
W_STEP=$(cygpath -w "$STEPJSON")

start_gateway() { # $1 = pool max
  PORT=$GWPORT HOST=127.0.0.1 PGURL="$PGADMIN" GW_SECRET="$SECRET" \
    PAYESH_PG_POOL_MAX="$1" GW_QUOTA_MAX=100000000 GW_QUOTA_WINDOW_SEC=60 GW_PULL_MAX=1000 \
    GW_INSTANCE=cb45-gw PAYESH_LOG=0 node server/gateway.js >> "$GWLOG" 2>&1 &
  GWPID=$!
  for _ in $(seq 1 150); do curl -sf "$GATEWAY/healthz" > /dev/null && return 0; sleep 0.2; done
  return 1
}

echo "# PostgreSQL واقعی محلی (O-20): $PGHOST_:$PGPORT_/$PGDB (کاربر: $PGUSER_)"
echo "# gateway: $GATEWAY (فرایند جدا، pool از PAYESH_PG_POOL_MAX) · بار: $CLIENTS کلاینت × $SECONDS_ ثانیه × $PROCS فرایند"
echo "# آستانهٔ انتظار pool در بار هدف: میانگین ≤ ${WAIT_MEAN_MS}ms و بیشینه ≤ ${WAIT_MAX_MS}ms و صفر مورد > ۱s"
echo "# (الزام فقط روی اندازهٔ pool بودجه‌شده = $ENFORCE_POOL؛ pool پیش‌فرض فقط ثبت می‌شود)"

B=0
for PM in $(echo "$POOLS" | tr ',' ' '); do
  start_gateway "$PM" || { echo "# gateway با pool=$PM بالا نیامد"; B=1; continue; }
  node "$W_SAMPLER" "$GATEWAY" "$((SECONDS_ * 1000))" > "$STEPJSON" &
  SPID=$!
  PAYESH_PG_ADMIN_URL="$PGADMIN" PAYESH_PG_APP_URL="$PGADMIN" PAYESH_TENANCY_SECRET="$SECRET" \
    PAYESH_GW_URL="$GATEWAY" node tools/fleet-load-46.mjs \
      --clients "$CLIENTS" --seconds "$SECONDS_" --procs "$PROCS" --json-out "$D/cb45-pool-$PM.json" >/dev/null 2>&1
  R=$?; wait "$SPID" 2>/dev/null
  SAMP=$(cat "$STEPJSON" 2>/dev/null)
  [ "$R" -ne 0 ] && B=1
  node -e '
    const fs = require("fs");
    const step = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}");
    const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const st = (j.stages && j.stages[0]) || {};
    const pull = st.pull || {}, push = st.push || {};
    console.log(`POOL max=${process.argv[4]} rps=${st.rps_total} pull_p95=${(pull.p95||0).toFixed(0)}ms pull_p99=${(pull.p99||0).toFixed(0)}ms push_p99=${(push.p99||0).toFixed(0)}ms err=${((st.error_rate || 0) * 100).toFixed(2)}% acquire_mean_max=${step.acquire_mean_ms_max}ms acquire_max=${step.acquire_max_ms}ms over_1s=${step.acquire_over_1s} events=${step.acquire_events} db_conn_max=${step.db_connections} pool_total=${step.pool_total} samples=${step.samples}`);
  ' "$W_STEP" "$D/cb45-pool-$PM.json" "$WAIT_MEAN_MS" "$PM" || B=1
  node -e '
    const s = JSON.parse(process.argv[1] || "{}");
    const meanSlo = Number(process.argv[2]), maxSlo = Number(process.argv[3]);
    const pool = process.argv[4], enforced = process.argv[5];
    if (pool !== enforced) {
      const w = (s.acquire_mean_ms_max || 0) > meanSlo || (s.acquire_max_ms || 0) > maxSlo || (s.acquire_over_1s || 0) > 0;
      console.log(`# POOL max=${pool} (پیش‌فرض کد): ${w ? "آستانه نقض شد (ثبت شد، الزام نیست)" : "در آستانه"}`);
      process.exit(0);
    }
    const bad = [];
    if ((s.acquire_mean_ms_max || 0) > meanSlo) bad.push("mean=" + s.acquire_mean_ms_max + "ms > " + meanSlo);
    if ((s.acquire_max_ms || 0) > maxSlo) bad.push("max=" + s.acquire_max_ms + "ms > " + maxSlo);
    if ((s.acquire_over_1s || 0) > 0) bad.push("over_1s=" + s.acquire_over_1s);
    if (bad.length) { console.error("POOL-WAIT-SLO-BREACH " + bad.join(" ")); process.exit(1); }
  ' "$SAMP" "$WAIT_MEAN_MS" "$WAIT_MAX_MS" "$PM" "$ENFORCE_POOL" || B=1
  # توقف gateway بین پله‌ها
  [ -n "$GWPID" ] && { taskkill //F //PID "$GWPID" >/dev/null 2>&1 || kill "$GWPID" 2>/dev/null || true; }
  sleep 1
done

echo "# /healthz بعد از توقف gateway: $(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/healthz" 2>/dev/null || echo 000)"
rm -rf "$TMPD" "$GWLOG" "$D"/cb45-pool-*.json
if [ "$B" -eq 0 ]; then echo "CONN-BUDGET-45-REALPG-OK"; else echo "CONN-BUDGET-45-REALPG-FAILED"; fi
exit $B
