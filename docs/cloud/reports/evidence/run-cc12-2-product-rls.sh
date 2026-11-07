#!/usr/bin/env bash
# شاهد CC‑12‑2 — اجرای RLS از مسیر محصول روی PostgreSQL واقعی (فاز ۳ · D‑35)
# اجرا: bash docs/cloud/reports/evidence/run-cc12-2-product-rls.sh
# خروجی سبز: docs/cloud/reports/evidence/cc12-2-product-rls.txt ⇒ EXIT=0
# اگر PostgreSQL واقعی در دسترس نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
#
# محیط لازم (خارج از مخزن، اختیاری):
#   EMBEDDED_PG_HOME   مسیر بستهٔ باینری PostgreSQL
#                      (پیش‌فرض /tmp/pgtest/node_modules/@embedded-postgres/linux-x64)
#   CC122_PORT         پورت PostgreSQL (پیش‌فرض 5612)
#   CC122_APP_PORT     پورت سرور محصول (پیش‌فرض 5613)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
PGPORT_=${CC122_PORT:-5612}
APPPORT=${CC122_APP_PORT:-5613}
OUT=${CC122_OUT:-$D/cc12-2-product-rls.txt}
TESTS=$D/mission-05-tests-run.log

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
  await c.query("CREATE DATABASE payesh_cc122");
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || {
  echo "BLOCKED — createdb failed" >&2; echo "BLOCKED — createdb failed" > "$OUT"; exit 3; }

ADMIN_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_cc122"
RUNTIME_URL="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_cc122"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# شاهد CC‑12‑2 — اجرای RLS از مسیر محصول (فاز ۳ · D‑35)"
  echo "# تولید: bash docs/cloud/reports/evidence/run-cc12-2-product-rls.sh"
  echo "# بازتولید: CC122_OUT=<file> bash docs/cloud/reports/evidence/run-cc12-2-product-rls.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $HEAD"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo "# postgres version: $PGVER"
  echo "# postgres binary: $BIN (خارج از مخزن؛ وابستگی محصول نیست)"
  echo "# product_path: server/tenancy.js + server/index.js (/api/cloud/tenancy/records)"
  echo "# sha256(product-rls-path.cjs): $(sha256sum $D/product-rls-path.cjs | cut -d' ' -f1)"
  echo "# sha256(run-cc12-2-product-rls.sh): $(sha256sum $D/run-cc12-2-product-rls.sh | cut -d' ' -f1)"
  echo "# product_tree_sha256: $PRODUCT_SHA"
  echo
} > "$OUT"

set +e
PGURL_ADMIN="$ADMIN_URL" PGURL_RUNTIME="$RUNTIME_URL" TENANCY_SECRET="$SECRET" \
APP_PORT="$APPPORT" PAYESH_DATA="$APPDATA" \
  node "$D/product-rls-path.cjs" 2>&1 | tee -a "$OUT"
CODE=${PIPESTATUS[0]}
set -e

# ── آزمون‌های پایهٔ محصول: هیچ رگرسیونی مجاز نیست ───────────────────────────
set +e
bash "$D/run-tests-evidence.sh" > /tmp/cc122-base-tests.log 2>&1
BASECODE=$?
set -e
{
  echo
  echo "## آزمون پایهٔ محصول (رگرسیون)"
  echo "# command: bash docs/cloud/reports/evidence/run-tests-evidence.sh (npm test)"
  echo "# exit: $BASECODE"
  grep -E '^SUMMARY pass=|^EXIT=|^REGISTERED=|^pass=' /tmp/cc122-base-tests.log | tail -4
} >> "$OUT"

if [ "$CODE" = "0" ] && [ "$BASECODE" = "0" ]; then
  echo "CC12-2-RLS-PATH-OK (product_path=server/tenancy.js postgres=$PGVER)" >> "$OUT"
else
  echo "CC12-2-RLS-PATH-FAIL (rls_exit=$CODE base_tests_exit=$BASECODE)" >> "$OUT"
fi
echo >> "$OUT"
echo "EXIT=$CODE BASE_EXIT=$BASECODE" >> "$OUT"

echo "→ $OUT (exit=$CODE base=$BASECODE)"
[ "$CODE" = "0" ] && [ "$BASECODE" = "0" ] || { echo "CC12-2-FAIL: rls=$CODE base=$BASECODE" >&2; exit 1; }
exit 0
