#!/usr/bin/env bash
# شاهد ردیف ۵۴ — مهاجرت یکسان چند cell و انتقال مدرسه بین دیتابیس‌ها
# اجرا: bash docs/cloud/reports/evidence/run-54-cell-transfer.sh
# خروجی: docs/cloud/reports/evidence/cell-transfer-54.txt
# بدون PostgreSQL واقعی ⇒ exit 3 با برچسب BLOCKED.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

pkill -f "server/gateway.js" 2>/dev/null || true
sleep 1

D=docs/cloud/reports/evidence
PGBASE=${EMBEDDED_PG_HOME:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64}
BIN="$PGBASE/native/bin"; LIB="$PGBASE/native/lib"
PGPORT_=${CT_PGPORT:-5680}
GWPORT=${CT_GWPORT:-5681}
OUT=${CT_OUT:-$D/cell-transfer-54.txt}
TENANT=11111111-2222-4333-8444-555555555555

if [ ! -x "$BIN/initdb" ]; then
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE (no PostgreSQL binary)"
  echo "BLOCKED — ENVIRONMENT UNAVAILABLE" > "$OUT"; exit 3
fi

HEAD=$(git rev-parse --short HEAD); BR=$(git rev-parse --abbrev-ref HEAD)
PGVER=$("$BIN/postgres" --version 2>&1 | awk '{print $3}')
SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")
DATA=$(mktemp -d); GWLOG=$(mktemp); GWPID=""
export PAYESH_CELL_TRANSFER_ENABLED=1

cleanup() {
  [ -n "$GWPID" ] && kill "$GWPID" 2>/dev/null
  "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$DATA" "$GWLOG"
}
trap cleanup EXIT

export LD_LIBRARY_PATH="$LIB"
"$BIN/initdb" -D "$DATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null 2>&1 || {
  echo "BLOCKED — initdb failed"; echo "BLOCKED" > "$OUT"; exit 3; }
"$BIN/pg_ctl" -D "$DATA" -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=200" -l "$DATA/pg.log" start >/dev/null 2>&1 || {
  echo "BLOCKED — server did not start"; echo "BLOCKED" > "$OUT"; exit 3; }

node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.argv[1] }); await c.connect();
  await c.query("CREATE DATABASE cell_a"); await c.query("CREATE DATABASE cell_b"); await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
' "postgres://postgres@127.0.0.1:$PGPORT_/postgres" || { echo "BLOCKED — createdb failed"; echo "BLOCKED" > "$OUT"; exit 3; }

A_ADMIN="postgres://postgres@127.0.0.1:$PGPORT_/cell_a"
B_ADMIN="postgres://postgres@127.0.0.1:$PGPORT_/cell_b"
A_RT="postgres://payesh_runtime@127.0.0.1:$PGPORT_/cell_a"
GATEWAY="http://127.0.0.1:$GWPORT"

push_count() { # $1 = admin url، $2 = عنوان
  node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.argv[1] }); await c.connect();
      const t = await c.query("select (select count(*) from product_records where tenant_id=$1)::int rec, (select count(*) from product_change_feed where tenant_id=$1)::int feed", [process.argv[2]]);
      console.log(`${process.argv[3]} records=${t.rows[0].rec} feed=${t.rows[0].feed}`);
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
  ' "$1" "$TENANT" "$2"
}

{
  echo "# شاهد ردیف ۵۴ — مهاجرت یکسان چند cell + انتقال مدرسه با توقف نوشتن، تطبیق سه‌لایه و rollback"
  echo "# branch: $BR   head: $HEAD   at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# postgres: $PGVER — دو دیتابیس مستقل: cell_a / cell_b (کاربر اجرایی: payesh_runtime)"
  echo "# فعال‌سازی: PAYESH_CELL_TRANSFER_ENABLED=1 (شرط ردیف ۵۴)"
  echo

  echo "## بخش ۱ — آزمون منطق (بدون دیتابیس): CT-01..CT-10"
  node tests/cell-transfer-54.js 2>&1 | tail -12
  T=${PIPESTATUS[0]}

  echo
  echo "## بخش ۲ — migration یکسان روی هر دو cell (و تکرارپذیر بودن)"
  node tools/cell-transfer-54.mjs --cells "$A_ADMIN,$B_ADMIN"
  M=${PIPESTATUS[0]}

  echo
  echo "## بخش ۳ — Gateway روی cell_a؛ نوشتن قبل از توقف"
  PORT=$GWPORT HOST=127.0.0.1 PGURL="$A_RT" GW_SECRET="$SECRET" PAYESH_CELL_TRANSFER_ENABLED=1 \
    GW_QUOTA_MAX=100000000 GW_INSTANCE=ct-gw PAYESH_LOG=0 node server/gateway.js > "$GWLOG" 2>&1 &
  GWPID=$!
  for _ in $(seq 1 150); do curl -sf "$GATEWAY/healthz" >/dev/null && break; sleep 0.2; done

  node -e '
    const tenancy = require("./server/tenancy.js");
    const tok = tenancy.signToken({ tid: process.argv[1], role: "manager", uid: "ct-u", did: "ct-dev",
      iat: Date.now(), exp: Date.now() + 3600_000 }, process.argv[2]);
    const ops = [1,2,3,4,5].map(n => ({ uid: "ct-" + n, collection: "attendance", id: 900000 + n, type: "put", data: { n } }));
    fetch(process.argv[3] + "/api/gw/v1/push", { method: "POST",
      headers: { authorization: "Bearer " + tok, "x-device-id": "ct-dev", "content-type": "application/json" },
      body: JSON.stringify({ ops }) })
      .then(r => r.text().then(t => console.log("push_before_freeze status=" + r.status + " body=" + t.slice(0, 160))));
  ' "$TENANT" "$SECRET" "$GATEWAY"
  sleep 1
  push_count "$A_ADMIN" "cell_a (قبل)"

  echo
  echo "## بخش ۴ — توقف نوشتن و اثبات ۴۰۹ روی همان Gateway"
  node tools/cell-transfer-54.mjs --freeze --tenant "$TENANT" --from "$A_ADMIN" --reason school-transfer
  F=${PIPESTATUS[0]}
  node tools/cell-transfer-54.mjs --status --tenant "$TENANT" --from "$A_ADMIN"
  node -e '
    const tenancy = require("./server/tenancy.js");
    const tok = tenancy.signToken({ tid: process.argv[1], role: "manager", uid: "ct-u", did: "ct-dev",
      iat: Date.now(), exp: Date.now() + 3600_000 }, process.argv[2]);
    fetch(process.argv[3] + "/api/gw/v1/push", { method: "POST",
      headers: { authorization: "Bearer " + tok, "x-device-id": "ct-dev", "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ uid: "ct-frozen", collection: "attendance", id: 900099, type: "put", data: { x: 1 } }] }) })
      .then(r => r.text().then(t => {
        console.log("push_while_frozen status=" + r.status + " body=" + t.slice(0, 160));
        process.exit(r.status === 409 ? 0 : 1);
      }));
  ' "$TENANT" "$SECRET" "$GATEWAY"
  W=$?

  echo
  echo "## بخش ۵ — انتقال مدرسه cell_a → cell_b با تطبیق سه‌لایه"
  node tools/cell-transfer-54.mjs --transfer --tenant "$TENANT" --from "$A_ADMIN" --to "$B_ADMIN" | tee /tmp/ct54.json
  X=${PIPESTATUS[0]}
  BATCH=$(grep -o '"batch_id": *"[^"]*"' /tmp/ct54.json | head -1 | sed 's/.*"\([0-9a-f-]*\)"/\1/')
  push_count "$B_ADMIN" "cell_b (پس از انتقال)"

  echo
  echo "## بخش ۶ — rollback همان batch"
  if [ -n "$BATCH" ]; then
    node tools/cell-transfer-54.mjs --rollback --batch "$BATCH" --to "$B_ADMIN"
    R=${PIPESTATUS[0]}
  else
    echo "بدون batch_id — rollback انجام نشد"; R=1
  fi
  push_count "$B_ADMIN" "cell_b (پس از rollback)"

  echo
  echo "## بخش ۷ — رگرسیون"
  node tools/cell-transfer-54.mjs --unfreeze --tenant "$TENANT" --from "$A_ADMIN" >/dev/null 2>&1
  npm test --silent 2>&1 | tail -3
  G=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# unit_exit:      $T"
  echo "# migrate_exit:   $M"
  echo "# freeze_exit:    $F"
  echo "# frozen_push_exit: $W   (۰ = پاسخ ۴۰۹ همان‌طور که باید)"
  echo "# transfer_exit:  $X"
  echo "# rollback_exit:  $R"
  echo "# regression_exit: $G"
  echo "# NOTE: دو cell روی یک PostgreSQL محلی‌اند؛ «cell» در این ردیف یعنی دیتابیس مستقل."
  echo "#       اجرای چند میزبان/provider واقعی + بار = OWNER (ردیف ۴۶/۵۶)."
  if [ "$T" -eq 0 ] && [ "$M" -eq 0 ] && [ "$F" -eq 0 ] && [ "$W" -eq 0 ] && [ "$X" -eq 0 ] && [ "$R" -eq 0 ] && [ "$G" -eq 0 ]; then
    echo "# EXIT=0"; echo "CELL-TRANSFER-54-EVIDENCE-OK"
  else echo "# EXIT=1"; echo "CELL-TRANSFER-54-EVIDENCE-FAILED"; fi
} > "$OUT" 2>&1

sed -n '/بخش ۲/,$p' "$OUT" | head -60
grep -q '^CELL-TRANSFER-54-EVIDENCE-OK$' "$OUT"
