#!/usr/bin/env bash
# شاهد ردیف ۴۰ — صف عملیات آفلاین پایدار روی دستگاه
# اجرا: bash docs/cloud/reports/evidence/run-40-outbox.sh
# خروجی سبز: docs/cloud/reports/evidence/outbox-40.txt  (پایان: OUTBOX-40-OK)
# هیچ سرویس بیرونی لازم نیست؛ IndexedDB استاندارد (fake-indexeddb) + سرور واقعی درون‌فرآیندی.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${OB40_OUT:-$D/outbox-40.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
NODE=$(node -v)
VER=$(node -e "process.stdout.write(require('./package.json').version)")
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

{
  echo "# شاهد ردیف ۴۰ — صف عملیات آفلاین پایدار روی دستگاه"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-40-outbox.sh"
  echo "# rules: capacity=5000 · lease=30s · maxAttempts=6 · backoff=1s×2^n (سقف 5m) · حذف فقط بعد از تصمیم سرور"
  echo

  echo "## بخش ۱ — آزمون صندوقچه + سرور واقعی (OB-01..OB-15)"
  node $FLAGS tests/outbox-40.js
  A=$?

  echo
  echo "## بخش ۲ — شاهد خام: چرخهٔ واقعی crash → restart → ارسال دوباره روی سرور تولیدی"
  node $FLAGS -e '
    require("fake-indexeddb/auto");
    const fs = require("fs"), os = require("os"), path = require("path");
    const { openStore } = require("./server/db");
    const sync = require("./server/sync");
    const outbox = require("./client/outbox-web");
    (async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ob40-raw-"));
      const store = openStore(path.join(tmp, "raw.sqlite"));
      const u = store.insert("users", { name: "مدیر شاهد", role: "manager", active: true });
      const actor = { user: u, role: "manager", device: null };
      const ob1 = await outbox.open("payesh_ob40_raw", { leaseMs: 5000 });
      for (let i = 1; i <= 3; i++) {
        await ob1.enqueue({ uid: "raw-op-" + i, collection: "attendance", type: "put", id: 900 + i,
          data: { student_id: 5, class_id: 1, status: "present" }, base_version: 0, at: new Date().toISOString() });
      }
      const batch = await ob1.claim(10, 1000);
      console.log("ops_enqueued          3");
      console.log("claimed_before_crash  " + batch.length + " (state=" + batch[0].state + ", lease_until=" + batch[0].lease_until + ")");
      const first = sync.push(store, actor, { ops: batch.map(outbox.toWire) });
      console.log("first_push_applied    " + first.applied.length + " (duplicate=false)");
      ob1.close();                                   /* ← crash قبل از ack */
      const ob2 = await outbox.open("payesh_ob40_raw", { leaseMs: 5000 });
      console.log("after_restart_list    " + JSON.stringify((await ob2.list({ state: "inflight" })).map(r => r.k)));
      const rec = await ob2.recover(1000 + 5000 + 1);
      console.log("recovered_after_lease " + rec.recovered);
      const res = await ob2.drain({ send: (ops) => sync.push(store, actor, { ops, idempotency_key: "raw-batch-1" }), now: 7000 });
      console.log("resend_applied        " + res.applied);
      const rows = store.db.prepare("SELECT COUNT(*) n FROM records WHERE collection=\x27attendance\x27").get().n;
      console.log("server_rows_total     " + rows + "  (انتظار: ۳ — بدون اعمال دوباره)");
      const st = await ob2.stats();
      console.log("queue_after_drain     total=" + st.total + " pending=" + st.pending + " blocked=" + st.blocked);
      console.log("queue_capacity        " + st.capacity + " full=" + st.full);
      ob2.close(); store.db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      if (rows !== 3) { console.log("RAW-PROBE-MISMATCH"); process.exit(1); }
    })().catch(e => { console.log("raw probe error: " + e.message); process.exit(1); });
  '
  RAW=$?

  echo
  echo "## بخش ۳ — هیچ حذف خاموشی در کد برنامه نمانده است"
  if grep -n "slice(-500)" client/app.js; then
    echo "SILENT-TRUNCATION-STILL-PRESENT"
    TR=1
  else
    echo "no_silent_truncation  client/app.js: هیچ برشِ صف نیست"
    TR=0
  fi
  echo "outbox_script_tag: $(grep -c 'outbox-web.js' client/index.html) در client/index.html"

  echo
  echo "# ===== SUMMARY ====="
  echo "# checks_exit: $A"
  echo "# raw_probe_exit: $RAW"
  echo "# truncation_scan_exit: $TR"
  if [ "$A" -eq 0 ] && [ "$RAW" -eq 0 ] && [ "$TR" -eq 0 ]; then
    echo "# EXIT=0"
    echo "OUTBOX-40-OK"
  else
    echo "# EXIT=1"
    echo "OUTBOX-40-FAIL"
  fi
} > "$OUT" 2>&1

tail -22 "$OUT"
grep -q '^OUTBOX-40-OK$' "$OUT"
