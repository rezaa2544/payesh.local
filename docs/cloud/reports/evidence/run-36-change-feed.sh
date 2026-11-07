#!/usr/bin/env bash
# شاهد ردیف ۳۶ — change-feed هر مدرسه در PostgreSQL (seq صعودی، ایندکس، retention)
# اجرا: bash docs/cloud/reports/evidence/run-36-change-feed.sh
# خروجی سبز: docs/cloud/reports/evidence/change-feed-36.txt
# اگر PostgreSQL واقعی در دسترس نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${CF_PORT:-5630}
APPPORT=${CF_APP_PORT:-5631}
OUT=${CF_OUT:-$D/change-feed-36.txt}

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
APPDATA=$(mktemp -d)
cleanup() {
  "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$DATA" "$APPDATA"
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
  await c.query("CREATE DATABASE payesh_cf36");
  await c.query("CREATE DATABASE payesh_f05");
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || {
  echo "BLOCKED — createdb failed" >&2; echo "BLOCKED — createdb failed" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_cf36"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_cf36"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# شاهد ردیف ۳۶ — change-feed هر مدرسه در PostgreSQL (seq صعودی، ایندکس مکان‌نما، retention)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# postgres: $PGVER  (embedded-postgres — باینری بیرون از مخزن)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-36-change-feed.sh"
  echo
  echo "## اجرای آزمون واقعی (۱۵ بررسی، مسیر محصول از HTTP + بررسی مستقیم DB)"
  PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" \
  APP_PORT="$APPPORT" PAYESH_DATA="$APPDATA" \
    node --experimental-sqlite --disable-warning=ExperimentalWarning tests/change-feed-pg.js
  CODE=$?
  echo
  echo "## اندازه‌گیری مستقیم روی همان پایگاه‌داده"
  PGURL_ADMIN="$ADMIN_URL" node -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.PGURL_ADMIN });
    await c.connect();
    const t = await c.query("select count(*)::int n, count(distinct seq)::int u from product_change_feed");
    console.log("feed_rows=" + t.rows[0].n + " distinct_seq=" + t.rows[0].u);
    const s = await c.query("select last_value from product_change_feed_seq_seq");
    console.log("sequence_last_value=" + s.rows[0].last_value);
    const i = await c.query("select indexname, indexdef from pg_indexes where tablename=$1 order by indexname", ["product_change_feed"]);
    for (const r of i.rows) console.log("index: " + r.indexname + " — " + r.indexdef.replace(/^CREATE /, ""));
    const p = await c.query("select relrowsecurity r, relforcerowsecurity f from pg_class where relname=$1", ["product_change_feed"]);
    console.log("rls=" + p.rows[0].r + " force=" + p.rows[0].f);
    await c.end();
  })().catch(e => { console.error(e.message); process.exit(1); });
  ' || CODE=1
  echo
  echo "## عدم رگرسیون: آزمون tenancy/RLS ردیف ۲۶ روی همان سرور PostgreSQL، پایگاه‌دادهٔ تازه"
  mkdir -p "$APPDATA/f05"
  PGURL_ADMIN="postgres://postgres@127.0.0.1:$PGPORT_/payesh_f05" \
  PGURL_RUNTIME="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_f05" TENANCY_SECRET="$SECRET" \
  APP_PORT="$((APPPORT + 1))" PAYESH_DATA="$APPDATA/f05/data" \
    node --experimental-sqlite --disable-warning=ExperimentalWarning tests/tenancy-pg.js > "$APPDATA/f05.log" 2>&1
  F05CODE=$?
  grep -E "F05-PG|FAIL " "$APPDATA/f05.log" | tail -8
  echo "(exit=$F05CODE)"
  echo
  if [ $CODE -eq 0 ] && [ "${F05CODE:-1}" -eq 0 ]; then echo "CHANGE-FEED-36-OK"; else echo "CHANGE-FEED-36-FAIL (exit=$CODE f05=${F05CODE:-?})"; fi
} > "$OUT" 2>&1

if grep -q "CHANGE-FEED-36-OK" "$OUT"; then
  echo "→ $OUT"
  tail -2 "$OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  tail -20 "$OUT" >&2
  exit 1
fi
