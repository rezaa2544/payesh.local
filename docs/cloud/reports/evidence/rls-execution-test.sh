#!/usr/bin/env bash
# آزمون اجرایی RLS (A-02) روی PostgreSQL واقعی — FAIL-CLOSED
# اجرا: bash docs/cloud/reports/evidence/rls-execution-test.sh
# خروجی: docs/cloud/reports/evidence/mission-a-rls-execution.txt
#         (قابل تغییر با RLS_TEST_OUT — شاهد تاریخی بازنویسی نمی‌شود)
#
# محیط لازم (خارج از مخزن، اختیاری):
#   EMBEDDED_PG_HOME     مسیر بستهٔ باینری PostgreSQL (پیش‌فرض /tmp/pgtest/node_modules/@embedded-postgres/linux-x64)
#   PG_NODE_MODULES      مسیر node_modules دارای کتابخانهٔ pg (پیش‌فرض /tmp/pgtest/node_modules)
#   RLS_TEST_PORT        پورت (پیش‌فرض 5599)
# اگر PostgreSQL در دسترس نباشد ⇒ exit 3 با برچسب BLOCKED (نه PASS).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"
LIB="$PGBASE/native/lib"
NODEMODS=${PG_NODE_MODULES:-/tmp/pgtest/node_modules}
PORT=${RLS_TEST_PORT:-5599}
OUT=${RLS_TEST_OUT:-docs/cloud/reports/evidence/mission-a-rls-execution.txt}

if [ ! -x "$BIN/initdb" ] || [ ! -d "$NODEMODS/pg" ]; then
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE (no PostgreSQL binary / no pg client)"
  echo "  expected binary: $BIN/initdb"
  echo "  expected client: $NODEMODS/pg"
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE" > "$OUT"
  exit 3
fi

DATA=$(mktemp -d)
cleanup() { "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1; rm -rf "$DATA"; }
trap cleanup EXIT

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$DATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || {
  echo "BLOCKED — initdb failed" >&2; exit 3; }
"$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/pg.log" start >/dev/null 2>&1 || {
  echo "BLOCKED — server did not start" >&2; tail -5 "$DATA/pg.log" >&2; exit 3; }

{
  echo "# آزمون اجرایی RLS روی PostgreSQL واقعی (A-02 · شرط CC-12-1 ردیف ۱۲)"
  echo "# تولید: bash docs/cloud/reports/evidence/rls-execution-test.sh"
  echo "# بازتولید: RLS_TEST_OUT=<file> bash docs/cloud/reports/evidence/rls-execution-test.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo "# postgres version: $("$BIN/postgres" --version 2>&1 | awk '{print $3}')"
  echo "# postgres --version: $("$BIN/postgres" --version 2>&1)"
  echo "# postgres binary: $BIN (خارج از مخزن؛ وابستگی محصول نیست)"
  echo "# sha256(rls-execution-test.sh): $(sha256sum docs/cloud/reports/evidence/rls-execution-test.sh | cut -d' ' -f1)"
  echo "# sha256(rls-execution-test.cjs): $(sha256sum docs/cloud/reports/evidence/rls-execution-test.cjs | cut -d' ' -f1)"
  echo "# product_tree_sha256: $(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d' ' -f1)"
  echo
} > "$OUT"

set +e
RLS_TEST_PORT="$PORT" NODE_PATH="$NODEMODS" node docs/cloud/reports/evidence/rls-execution-test.cjs 2>&1 | tee -a "$OUT"
CODE=${PIPESTATUS[0]}
set -e

echo >> "$OUT"
echo "EXIT=$CODE" >> "$OUT"
echo "→ $OUT (exit=$CODE)"
[ "$CODE" = "0" ] || { echo "RLS-TEST-FAIL: exit $CODE" >&2; }
exit "$CODE"
