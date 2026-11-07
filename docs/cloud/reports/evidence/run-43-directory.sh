#!/usr/bin/env bash
# شاهد ردیف ۴۳ — دایرکتوری مرکزی و مسیردهی مدرسه→cell (توکن حاوی cell، کش TTL، stale، تک‌cell)
# اجرا: bash docs/cloud/reports/evidence/run-43-directory.sh
# خروجی سبز: docs/cloud/reports/evidence/directory-43.txt
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
PGPORT_=${DR_PGPORT:-5670}
GW1=${DR_GW1_PORT:-5661}
GW2=${DR_GW2_PORT:-5662}
GW3=${DR_GW3_PORT:-5663}
OUT=${DR_OUT:-$D/directory-43.txt}

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
  for (const db of ["payesh_dir43", "payesh_cell1", "payesh_cell2"]) await c.query("CREATE DATABASE " + db);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || {
  echo "BLOCKED — createdb failed" >&2; echo "BLOCKED — createdb failed" > "$OUT"; exit 3; }

CELL1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
CELL2=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2
DIR_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_dir43"
C1_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_cell1"
C2_URL="postgres://postgres@127.0.0.1:$PGPORT_/payesh_cell2"
C1_RT="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_cell1"
C2_RT="postgres://payesh_runtime@127.0.0.1:$PGPORT_/payesh_cell2"
SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")

{
  echo "# شاهد ردیف ۴۳ — دایرکتوری مرکزی و مسیردهی مدرسه→cell"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# postgres: $PGVER (embedded-postgres — باینری بیرون از مخزن)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-43-directory.sh"
  echo "# topology: directory=payesh_dir43 · cell1=payesh_cell1(:$GW1) · cell2=payesh_cell2(:$GW2) · legacy(:$GW3 بدون GW_CELL)"
  echo

  echo "## مهاجرت‌ها: دیتابیس مرکزی + دو cell"
  DIR_URL="$DIR_URL" C1_URL="$C1_URL" C2_URL="$C2_URL" node -e '
  const directory = require("./server/directory");
  const tenancy = require("./server/tenancy");
  const { Client } = require("pg");
  (async () => {
    const d = new Client({ connectionString: process.env.DIR_URL }); await d.connect();
    const m = await directory.migrate(d);
    console.log("directory migrate: statements=" + m.statements);
    await d.end();
    for (const [name, url] of [["cell1", process.env.C1_URL], ["cell2", process.env.C2_URL]]) {
      const c = new Client({ connectionString: url }); await c.connect();
      const t = await tenancy.migrate(c);
      console.log(name + " tenancy migrate: statements=" + t.statements);
      await c.end();
    }
  })().catch(e => { console.error("migrate error: " + e.message); process.exit(1); });
  ' || { echo "FAIL — migration"; }

  echo
  echo "## سه Gateway: cell1 مقید، cell2 مقید، و یکی بدون GW_CELL (شروع تک‌cell)"
  PGURL="$C1_URL" GW_SECRET="$SECRET" PORT="$GW1" HOST=127.0.0.1 GW_CELL="$CELL1" \
  GW_QUOTA_MAX=100000 GW_INSTANCE="gw-cell1" node server/gateway.js > "$DATA/gw1.log" 2>&1 &
  PGURL="$C2_URL" GW_SECRET="$SECRET" PORT="$GW2" HOST=127.0.0.1 GW_CELL="$CELL2" \
  GW_QUOTA_MAX=100000 GW_INSTANCE="gw-cell2" node server/gateway.js > "$DATA/gw2.log" 2>&1 &
  PGURL="$C1_URL" GW_SECRET="$SECRET" PORT="$GW3" HOST=127.0.0.1 \
  GW_QUOTA_MAX=100000 GW_INSTANCE="gw-legacy" node server/gateway.js > "$DATA/gw3.log" 2>&1 &
  for i in $(seq 1 60); do
    a=$(curl -sf "http://127.0.0.1:$GW1/healthz" >/dev/null 2>&1 && echo 1 || echo 0)
    b=$(curl -sf "http://127.0.0.1:$GW2/healthz" >/dev/null 2>&1 && echo 1 || echo 0)
    c=$(curl -sf "http://127.0.0.1:$GW3/healthz" >/dev/null 2>&1 && echo 1 || echo 0)
    [ "$a$b$c" = "111" ] && break
    sleep 0.3
  done
  if [ "$a$b$c" != "111" ]; then
    echo "FAIL — نمونه‌ها بالا نیامدند (cell1=$a cell2=$b legacy=$c)"
    tail -8 "$DATA/gw1.log" "$DATA/gw2.log" "$DATA/gw3.log"
  else
    echo "## اجرای آزمون واقعی (۱۶ بررسی — دایرکتوری، کش TTL، stale، اتصال توکن به cell)"
    DIR_URL="$DIR_URL" CELL1_URL="$C1_URL" CELL2_URL="$C2_URL" CELL1_RUNTIME="$C1_RT" CELL2_RUNTIME="$C2_RT" \
    TENANCY_SECRET="$SECRET" GW1_PORT="$GW1" GW2_PORT="$GW2" GW3_PORT="$GW3" \
      node --experimental-sqlite --disable-warning=ExperimentalWarning tests/directory-pg.js
    CODE=$?
    echo
    echo "## اندازه‌گیری مستقیم: جدول مسیردهی در دیتابیس مرکزی"
    DIR_URL="$DIR_URL" node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DIR_URL });
      await c.connect();
      const cells = await c.query("select cell_id, name, status from directory_cells order by name");
      for (const r of cells.rows) console.log("cell " + r.name + " " + r.cell_id + " status=" + r.status);
      const routes = await c.query("select school_code, cell_id from school_routes order by school_code");
      for (const r of routes.rows) console.log("route " + r.school_code + " -> " + r.cell_id.slice(-2));
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
    ' || CODE=1
    pkill -f "server/gateway.js" 2>/dev/null || true
    sleep 1

    echo
    echo "## عدم رگرسیون ۱: اسکوپ سمت سرور (ردیف ۳۸) — ۱۶ بررسی + رگرسیون‌های خودش"
    SC_OUT="$DATA/sc38.txt" EMBEDDED_PG_HOME="$PGBASE" \
      bash docs/cloud/reports/evidence/run-38-scope.sh > "$DATA/sc38.run.log" 2>&1
    SC38=$?
    grep -E "SCOPE-38-OK|^FAIL " "$DATA/sc38.txt" | tail -2
    if ! grep -q "SCOPE-38-OK" "$DATA/sc38.txt"; then
      echo "رگرسیون ۳۸ شکست خورد؛ ۱۵ خط آخر:"; tail -15 "$DATA/sc38.run.log"; CODE=1
    fi
    echo "(sc38_exit=$SC38)"

    echo
    echo "## عدم رگرسیون ۲: Gateway (ردیف ۳۷) — ۱۹ بررسی"
    GW_OUT="$DATA/gw37.txt" EMBEDDED_PG_HOME="$PGBASE" \
      bash docs/cloud/reports/evidence/run-37-gateway.sh > "$DATA/gw37.run.log" 2>&1
    GW37=$?
    grep -c "^PASS  GW" "$DATA/gw37.txt" | sed 's/^/gw_passed=/'
    if ! grep -q "GATEWAY-37-OK" "$DATA/gw37.txt"; then
      echo "رگرسیون ۳۷ شکست خورد؛ ۱۵ خط آخر:"; tail -15 "$DATA/gw37.run.log"; CODE=1
    fi
    echo "(gw37_exit=$GW37)"

    if [ $CODE -eq 0 ]; then echo; echo "DIRECTORY-43-OK"; else echo; echo "DIRECTORY-43-FAIL (exit=$CODE)"; fi
  fi
} > "$OUT" 2>&1

if grep -q "DIRECTORY-43-OK" "$OUT"; then
  echo "→ $OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  grep -E "^FAIL " "$OUT" | head -10 >&2
  tail -8 "$OUT" >&2
  exit 1
fi
