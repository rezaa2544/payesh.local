#!/usr/bin/env bash
# شاهد ردیف ۲۶ (F‑05) — tenant model + RLS بدنهٔ محصول روی PostgreSQL واقعی
# اجرا: bash docs/cloud/reports/evidence/run-f05-product-tenancy.sh
# خروجی سبز: docs/cloud/reports/evidence/f05-product-tenancy.txt
# اگر PostgreSQL واقعی نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${F05_PORT:-5620}
APPPORT=${F05_APP_PORT:-5621}
OUT=${F05_OUT:-$D/f05-product-tenancy.txt}

if [ ! -x "$BIN/initdb" ]; then
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE (no PostgreSQL binary: $BIN/initdb)"
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE" > "$OUT"
  exit 3
fi

HEAD=$(git rev-parse HEAD)
PRODUCT_SHA=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
PGVER=$("$BIN/postgres" --version 2>&1 | awk '{print $3}')

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
  await c.query("CREATE DATABASE payesh_f05");
  await c.query("CREATE ROLE payesh_runtime LOGIN");
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || {
  echo "BLOCKED — createdb failed" >&2; echo "BLOCKED — createdb failed" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_f05"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_f05"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# شاهد ردیف ۲۶ (F‑05) — tenancy/RLS بدنهٔ محصول روی PostgreSQL واقعی"
  echo "# تولید: bash docs/cloud/reports/evidence/run-f05-product-tenancy.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $HEAD"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo "# postgres version: $PGVER (باینری بیرون از مخزن؛ وابستگی محصول نیست)"
  echo "# product_path: server/tenancy.js + server/index.js (/api/cloud/tenancy/product/*)"
  echo "# migration: scripts/tenancy-migrate-product.js"
  echo "# product_tree_sha256: $PRODUCT_SHA"
  echo
} > "$OUT"

set +e
PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" \
APP_PORT="$APPPORT" PAYESH_DATA="$APPDATA" \
  node --experimental-sqlite --disable-warning=ExperimentalWarning "$D/../../../../tests/tenancy-pg.js" 2>&1 | tee -a "$OUT"
CODE=${PIPESTATUS[0]}
set -e

set +e
bash "$D/run-tests-evidence.sh" > /tmp/f05-base-tests.log 2>&1
BASECODE=$?
set -e
{
  echo
  echo "## آزمون پایهٔ محصول (رگرسیون)"
  echo "# command: bash docs/cloud/reports/evidence/run-tests-evidence.sh (npm test)"
  echo "# exit: $BASECODE"
  grep -E '^SUMMARY pass=|^EXIT=|^REGISTERED=' /tmp/f05-base-tests.log | tail -3
} >> "$OUT"

if [ "$CODE" = "0" ] && [ "$BASECODE" = "0" ]; then
  echo "F05-RLS-OK (product_body=26_collections postgres=$PGVER)" >> "$OUT"
else
  echo "F05-RLS-FAIL (pg_exit=$CODE base_exit=$BASECODE)" >> "$OUT"
fi
echo "EXIT=$CODE BASE_EXIT=$BASECODE" >> "$OUT"

echo "→ $OUT (exit=$CODE base=$BASECODE)"
[ "$CODE" = "0" ] && [ "$BASECODE" = "0" ] || { echo "F05-FAIL: pg=$CODE base=$BASECODE" >&2; exit 1; }
exit 0
