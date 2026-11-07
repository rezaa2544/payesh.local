#!/usr/bin/env bash
# شاهد ردیف ۴۱ — حل تعارض: ادغام فیلدی با زمان سرور + قواعد دامنه
# اجرا: bash docs/cloud/reports/evidence/run-41-conflict.sh
# خروجی سبز: docs/cloud/reports/evidence/conflict-41.txt  (پایان: CONFLICT-41-OK)
# هیچ سرویس بیرونی لازم نیست؛ SQLite محلی درون‌فرآیندی + کد واقعی محصول (server/sync.js).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${CF41_OUT:-$D/conflict-41.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
NODE=$(node -v)
VER=$(node -e "process.stdout.write(require('./package.json').version)")
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

{
  echo "# شاهد ردیف ۴۱ — حل تعارض نسخهٔ ۱ (field-level LWW با زمان سرور + قواعد دامنه)"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-41-conflict.sh"
  echo "# rules: auto↔ادغام · manual↔تعارض انسانی · نامعلوم=manual · برنده=زمان دریافت سرور"
  echo

  echo "## بخش ۱ — آزمون سیاست تعارض + مسیر push واقعی (CF-01..CF-16)"
  node $FLAGS tests/convergence-41.js
  A=$?

  echo
  echo "## بخش ۲ — شاهد خام: همان جدول تصمیم روی سرور واقعی (بدون بازنویسی، بدون گم‌شدن)"
  node $FLAGS -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const { openStore } = require("./server/db");
    const sync = require("./server/sync");
    const conv = sync.convergence;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf41-raw-"));
    const store = openStore(path.join(tmp, "raw.sqlite"));
    const u = store.insert("users", { name: "مدیر شاهد", role: "manager", active: true });
    const actor = { user: u, role: "manager", device: null };
    const push = (ops) => sync.push(store, actor, { ops });

    // ۱) حضور: دو دستگاه هم‌زمان فیلد حساس را عوض می‌کنند ⇒ تعارض، مقدار سرور دست‌نخورده
    const at = push([{ uid: "raw-seed-att", collection: "attendance", type: "put",
      data: { student_id: 5, class_id: 1, date: "2026-11-07", status: "present" } }]).applied;
    const atId = at[0].id, atV = at[0].version;
    // نسخه را یک قدم جلو می‌بریم تا هر دو op زیر «کهنه» باشند (سناریوی واقعی دو دستگاه آفلاین)
    push([{ uid: "raw-bump", collection: "attendance", type: "put", id: atId, base_version: atV,
      data: { note: "ثبت اولیه" } }]);
    const vAfterBump = store.get("attendance", atId)._version;
    const a1 = push([{ uid: "raw-att-a", collection: "attendance", type: "put", id: atId, base_version: atV,
      data: { status: "absent" } }]);
    const a2 = push([{ uid: "raw-att-b", collection: "attendance", type: "put", id: atId, base_version: atV,
      data: { status: "late", note: "تأخیر ۱۰ دقیقه" } }]);
    const attRow = store.get("attendance", atId);
    const attConf = store.all("conflicts").filter(c => c.collection === "attendance" && c.record_id === Number(atId));
    console.log("bump_version              " + vAfterBump + "  (انتظار: 2)");
    console.log("attendance_conflicts      " + (a1.conflicts.length + a2.conflicts.length) + "  (انتظار: 2)");
    console.log("attendance_server_value   " + attRow.status + "  (انتظار: present — بدون بازنویسی)");
    console.log("attendance_version        " + attRow._version + "  (انتظار: 2 — با تعارض بالا نمی‌رود)");
    console.log("conflict_fields_recorded  " + JSON.stringify(attConf[0].fields));
    console.log("conflict_both_versions    local=" + JSON.stringify(attConf[0].local.status) +
                " server=" + JSON.stringify(attConf[0].server.status));
    console.log("conflict_policy_clock     " + attConf[0].policy.clock);
    console.log("conflict_status           " + attConf.map(c => c.status).join(","));

    // ۲) ادغام امن: فیلدهای جدا و غیرحساس روی همان ردیف ⇒ zero-conflict merge + audit
    const m = push([
      { uid: "raw-merge-note", collection: "attendance", type: "put", id: atId, base_version: atV,
        data: { arrival_time: "08:05" } },
      { uid: "raw-merge-excuse", collection: "attendance", type: "put", id: atId, base_version: atV,
        data: { excuse_note: "گواهی پزشکی" } }
    ]);
    const attAfter = store.get("attendance", atId);
    const merges = store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action=\x27conflict_auto_merge\x27").get().n;
    console.log("merge_conflicts           " + m.conflicts.length + "  (انتظار: 0)");
    console.log("merge_applied             " + m.applied.length + "  (انتظار: 2)");
    console.log("merge_arrival_kept        " + JSON.stringify(attAfter.arrival_time));
    console.log("merge_excuse_kept         " + JSON.stringify(attAfter.excuse_note));
    console.log("merge_audit_rows          " + merges + "  (انتظار: ≥2)");
    console.log("merge_status_untouched    " + attAfter.status + "  (انتظار: present)");

    // ۳) تراز: ۱۰۰ ارسال کهنه هم‌زمان ⇒ ۱۰۰ ردیف تعارض، صفر گم‌شده
    const before = store.db.prepare("SELECT COUNT(*) n FROM records WHERE collection=\x27conflicts\x27").get().n;
    const staleOps = Array.from({ length: 100 }, (_, i) => ({ uid: "raw-stale-" + i, collection: "attendance",
      type: "put", id: atId, base_version: atV, data: { status: i % 2 ? "absent" : "late" } }));
    const r1 = push(staleOps.slice(0, 50));
    const r2 = push(staleOps.slice(50));
    const after = store.db.prepare("SELECT COUNT(*) n FROM records WHERE collection=\x27conflicts\x27").get().n;
    const applied = r1.applied.length + r2.applied.length;
    console.log("stale_ops_in              " + staleOps.length);
    console.log("stale_applied             " + applied + "  (انتظار: 0 — همه باید تعارض شوند)");
    console.log("stale_conflicts_rows      " + (after - before) + "  (انتظار: 100)");
    console.log("stale_balance_ok          " + (applied + (after - before) === staleOps.length));
    console.log("stale_server_value_kept   " + store.get("attendance", atId).status + "  (انتظار: present)");

    // ۴) حذف در برابر ویرایش
    const delRes = push([{ uid: "raw-del", collection: "attendance", type: "del", id: atId, base_version: atV }]);
    const delConf = store.all("conflicts").filter(c => c.kind === "delete_vs_edit");
    console.log("delete_vs_edit_kind       " + (delConf[0] ? delConf[0].kind : "none"));
    console.log("delete_not_applied        " + (delRes.applied.length === 0));
    console.log("row_still_alive           " + Boolean(store.get("attendance", atId)));

    // ۵) پوشش سیاست: هر کالکشن سیاست دارد؛ کالکشن بدون قاعدهٔ صریح = ادغام خاموش نمی‌کند
    const t = conv.table();
    const keys = Object.keys(t);
    const failClosed = keys.filter(k => t[k].merge === "none" && t[k].auto.length === 0).length;
    console.log("policy_collections        " + keys.length);
    console.log("policy_fail_closed        " + failClosed + "  (کالکشن‌های بدون ادغام خودکار)");

    store.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    const ok = attRow.status === "present" && attConf.length === 2 && a1.conflicts.length === 1 &&
      a2.conflicts.length === 1 && m.conflicts.length === 0 && m.applied.length === 2 &&
      applied === 0 && (after - before) === 100 && delRes.applied.length === 0;
    if (!ok) { console.log("RAW-PROBE-MISMATCH"); process.exit(1); }
  '
  RAW=$?

  echo "## بخش ۳ — سیم‌کشی محصول (کد واقعی، نه نمونهٔ ۱۹)"
  echo "convergence_required_in_sync: $(grep -c "require('./convergence')" server/sync.js)"
  echo "decide_calls_in_sync:        $(grep -c 'convergence.decide' server/sync.js)"
  echo "conflict_auto_merge_audit:   $(grep -c 'conflict_auto_merge' server/sync.js)"
  echo "delete_vs_edit_guard:        $(grep -c 'delete_vs_edit' server/sync.js)"
  echo "policy_doc_lines:            $(wc -l < docs/cloud/41-conflict-policy.md)"
  for k in server_time_only attendance grades delete_vs_edit; do
    echo "doc_mentions_$k: $(grep -c "$k" docs/cloud/41-conflict-policy.md)"
  done
  W=0

  echo
  echo "## بخش ۴ — رگرسیون: دروازهٔ موجود دست‌نخورده و سبز"
  npm test --silent 2>&1 | tail -4
  R=${PIPESTATUS[0]}

  echo
  echo "# ===== SUMMARY ====="
  echo "# checks_exit: $A"
  echo "# raw_probe_exit: $RAW"
  echo "# regression_exit: $R"
  if [ "$A" -eq 0 ] && [ "$RAW" -eq 0 ] && [ "$R" -eq 0 ]; then
    echo "# EXIT=0"
    echo "CONFLICT-41-OK"
  else
    echo "# EXIT=1"
    echo "CONFLICT-41-FAIL"
  fi
} > "$OUT" 2>&1

tail -26 "$OUT"
grep -q '^CONFLICT-41-OK$' "$OUT"
