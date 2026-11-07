#!/usr/bin/env bash
# شاهد ردیف ۳۸ — اسکوپ سمت سرور بر اساس نقش (معلم/ولی/دانش‌آموز بیرون از scope نه می‌خوانند نه می‌نویسند)
# اجرا: bash docs/cloud/reports/evidence/run-38-scope.sh
# خروجی سبز: docs/cloud/reports/evidence/scope-38.txt
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
PGPORT_=${SC_PGPORT:-5650}
GWPORT=${SC_GW_PORT:-5651}
OUT=${SC_OUT:-$D/scope-38.txt}

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
GWLOG="$DATA/gw.log"
cleanup() {
  pkill -f "server/gateway.js" 2>/dev/null || true
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
  await c.query("CREATE DATABASE payesh_scope38");
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || {
  echo "BLOCKED — createdb failed" >&2; echo "BLOCKED — createdb failed" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_scope38"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_scope38"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# شاهد ردیف ۳۸ — اسکوپ سمت سرور بر اساس نقش (نه فیلتر کلاینت)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# postgres: $PGVER (embedded-postgres — باینری بیرون از مخزن)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-38-scope.sh"
  echo "# gateway: :$GWPORT (یک نمونه، PostgreSQL واقعی)"
  echo

  PGURL="$ADMIN_URL" GW_SECRET="$SECRET" PORT="$GWPORT" HOST=127.0.0.1 \
  GW_QUOTA_MAX=100000 GW_QUOTA_WINDOW_SEC=60 GW_INSTANCE="gw-scope" \
    node server/gateway.js > "$GWLOG" 2>&1 &
  GWPID=$!
  for i in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:$GWPORT/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  if ! kill -0 "$GWPID" 2>/dev/null; then
    echo "FAIL — Gateway بالا نیامد؛ لاگ:"; tail -10 "$GWLOG"
    echo; echo "SCOPE-38-FAIL (gateway not up)"
    else
    echo "## اجرای آزمون واقعی (۱۶ بررسی — Gateway HTTP + لایهٔ tenancy بدون HTTP)"
    PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" GW_PORT="$GWPORT" \
      node --experimental-sqlite --disable-warning=ExperimentalWarning tests/scope-pg.js
    CODE=$?
    echo
    echo "## اندازه‌گیری مستقیم روی همان پایگاه‌داده (اسکوپ = شرط SQL سمت سرور)"
    PGURL_ADMIN="$ADMIN_URL" node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.PGURL_ADMIN });
      await c.connect();
      const q = await c.query("select collection, count(*)::int n from product_records where deleted_at is null group by collection order by collection");
      for (const r of q.rows) console.log("product " + r.collection + "=" + r.n);
      const f = await c.query("select count(*)::int n from product_change_feed");
      console.log("feed_rows=" + f.rows[0].n);
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
    ' || CODE=1
    echo
    echo "## تأیید منفی: ردیف‌های بیرون از اسکوپ در DB هستند ولی از مسیر نقش دیده نمی‌شوند"
    PGURL_ADMIN="$ADMIN_URL" node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.PGURL_ADMIN });
      await c.connect();
      const q = await c.query("select record_id from product_records where collection = $1 and deleted_at is null order by record_id", ["attendance"]);
      console.log("attendance_ids_in_db=" + q.rows.map(r => r.record_id).join(","));
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
    ' || CODE=1
    kill "$GWPID" 2>/dev/null || true
    sleep 1

    echo
    echo "## عدم رگرسیون ۱: Gateway ردیف ۳۷ (۱۹ بررسی) روی PostgreSQL تازه"
    GW_OUT="$DATA/gw37.txt" EMBEDDED_PG_HOME="$PGBASE" \
      bash docs/cloud/reports/evidence/run-37-gateway.sh > "$DATA/gw37.run.log" 2>&1
    GW37=$?
    grep -E "^(PASS|FAIL)  GW" "$DATA/gw37.txt" | tail -2 | cut -c1-150
    grep -c "^PASS  GW" "$DATA/gw37.txt" | sed 's/^/gw_passed=/'
    if ! grep -q "GATEWAY-37-OK" "$DATA/gw37.txt"; then
      echo "رگرسیون Gateway شکست خورد؛ ۱۵ خط آخر:"
      tail -15 "$DATA/gw37.run.log"
      CODE=1
    fi
    echo "(gw37_exit=$GW37)"

    echo
    echo "## عدم رگرسیون ۲: change-feed ردیف ۳۶ (۱۷ بررسی) روی PostgreSQL تازه"
    CF_OUT="$DATA/cf36.txt" EMBEDDED_PG_HOME="$PGBASE" \
      bash docs/cloud/reports/evidence/run-36-change-feed.sh > "$DATA/cf36.run.log" 2>&1
    CF36=$?
    grep -E "CHANGE-FEED-36-OK" "$DATA/cf36.txt" | tail -1
    if ! grep -q "CHANGE-FEED-36-OK" "$DATA/cf36.txt"; then
      echo "رگرسیون change-feed شکست خورد؛ ۱۵ خط آخر:"
      tail -15 "$DATA/cf36.run.log"
      CODE=1
    fi
    echo "(cf36_exit=$CF36)"

    if [ $CODE -eq 0 ]; then echo; echo "SCOPE-38-OK"; else echo; echo "SCOPE-38-FAIL (exit=$CODE)"; fi
  fi
} > "$OUT" 2>&1

if grep -q "SCOPE-38-OK" "$OUT"; then
  echo "→ $OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  grep -E "^FAIL " "$OUT" | head -10 >&2
  tail -6 "$OUT" >&2
  exit 1
fi
