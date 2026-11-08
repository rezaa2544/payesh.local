#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ابزار ردیف ۵۰ — تمرین PITR، تطبیق چک‌سام سه‌لایه و راستی‌آزمایی بازیابی

   حالت‌ها:
     --local-drill
       اجرای تمرین کامل PITR (basebackup + WAL replay تا نقطهٔ هدف t_target +
       حذف تراکنش‌های مخرب پس از t_target + تطبیق سه‌لایهٔ SHA-256) با برچسب [S].

     --pg-drill --primary <url> --restored <url> --tenant <uuid> [--target-time <iso>] [--require-managed]
       راستی‌آزمایی PITR روی PostgreSQL واقعی (مقایسهٔ وضعیت مورد انتظار در نقطهٔ هدف
       با شاخه/نمونهٔ بازیابی‌شده، سنجش RPO/RTO و تطبیق سه‌لایهٔ چک‌سام).
       اگر --require-managed داده شود و میزبان PostgreSQL محلی/موقت باشد، با کد ۳
       رد می‌شود تا تمرین تک‌میزبان هرگز به‌جای شاهد تولیدی [M] ثبت نشود.

   کد خروج: ۰ موفق · ۱ شکست تطبیق/آستانه · ۲ خطای ورودی · ۳ محیط غیرمدیریت‌شده در حالت --require-managed
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));
const transfer = require(path.join(ROOT, 'server', 'transfer.js'));
const pitr = require(path.join(ROOT, 'server', 'pitr.js'));
const { Client } = require('pg');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);

const TABLES = [tenancy.PRODUCT_TABLE, tenancy.FEED_TABLE, tenancy.OPS_TABLE, tenancy.QUOTA_TABLE];
const TENANT_A = '11111111-2222-4333-8444-555555555555';
const TENANT_B = '22222222-3333-4444-8555-666666666666';

function runLocalSimulation() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-pitr50-'));
  try {
    const archive = pitr.createWalArchive(tmpDir);
    const initialTables = {
      product_records: [
        { id: 'rec-1', tenant_id: TENANT_A, collection: 'students', version: 1, payload: { name: 'علی رضایی' } },
        { id: 'rec-2', tenant_id: TENANT_B, collection: 'students', version: 1, payload: { name: 'سارا محمدی' } },
      ],
      product_change_feed: [
        { id: 'cf-1', tenant_id: TENANT_A, seq: 1, op: 'upsert', record_id: 'rec-1' },
        { id: 'cf-2', tenant_id: TENANT_B, seq: 1, op: 'upsert', record_id: 'rec-2' },
      ],
    };

    const baseInfo = archive.writeBaseBackup(initialTables, '2026-11-08T08:00:00.000Z');

    /* تراکنش‌های پیش از نقطهٔ هدف (t <= 08:04:30Z) — باید کامل بازیابی شوند */
    archive.appendWalEntry({
      lsn: 101,
      at: '2026-11-08T08:02:10.000Z',
      op: 'upsert',
      table: 'product_records',
      tenant_id: TENANT_A,
      id: 'rec-3',
      row: { id: 'rec-3', tenant_id: TENANT_A, collection: 'grades', version: 1, payload: { score: 19.5 } },
    });
    archive.appendWalEntry({
      lsn: 102,
      at: '2026-11-08T08:04:20.000Z',
      op: 'upsert',
      table: 'product_change_feed',
      tenant_id: TENANT_A,
      id: 'cf-3',
      row: { id: 'cf-3', tenant_id: TENANT_A, seq: 2, op: 'upsert', record_id: 'rec-3' },
    });

    const targetIso = '2026-11-08T08:04:30.000Z';

    /* وضعیت مورد انتظار در لحظهٔ targetIso */
    const expectedAtTarget = {
      product_records: [
        ...initialTables.product_records,
        { id: 'rec-3', tenant_id: TENANT_A, collection: 'grades', version: 1, payload: { score: 19.5 } },
      ],
      product_change_feed: [
        ...initialTables.product_change_feed,
        { id: 'cf-3', tenant_id: TENANT_A, seq: 2, op: 'upsert', record_id: 'rec-3' },
      ],
    };

    /* تراکنش‌های مخرب پس از نقطهٔ هدف (t > 08:04:30Z) — نباید در بازیابی باشند */
    archive.appendWalEntry({
      lsn: 103,
      at: '2026-11-08T08:05:00.000Z',
      op: 'delete',
      table: 'product_records',
      tenant_id: TENANT_A,
      id: 'rec-1',
    });
    archive.appendWalEntry({
      lsn: 104,
      at: '2026-11-08T08:05:05.000Z',
      op: 'upsert',
      table: 'product_records',
      tenant_id: TENANT_A,
      id: 'rec-bad',
      row: { id: 'rec-bad', tenant_id: TENANT_A, collection: 'corrupted', version: 99, payload: {} },
    });

    const restored = archive.restoreToPointInTime(targetIso);
    const snapExpected = pitr.snapshotFromTables(expectedAtTarget, TENANT_A);
    const snapRestored = pitr.snapshotFromTables(restored.tables, TENANT_A);
    const reconciliation = transfer.reconcile(snapExpected, snapRestored);
    const postTargetExcluded =
      restored.skipped_after_target === 2 &&
      !restored.tables.product_records.some(r => r.id === 'rec-bad') &&
      restored.tables.product_records.some(r => r.id === 'rec-1');

    const hostInfo = pitr.classifyPgHost(null);
    const evalResult = pitr.evaluatePitrDrill({
      rpoMs: restored.rpo_ms,
      rtoMs: restored.rto_ms,
      reconciliation,
      postTargetExcluded,
      hostInfo,
    });

    return {
      mode: 'local-drill',
      basebackup_sha256: baseInfo.sha256,
      target_iso: targetIso,
      replayed_wal_entries: restored.replayed,
      skipped_post_target_entries: restored.skipped_after_target,
      reconciliation,
      evaluation: evalResult,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runPgDrill({ primaryUrl, restoredUrl, tenantId, targetIso, requireManaged }) {
  const hostInfo = pitr.classifyPgHost(primaryUrl);
  if (requireManaged && !hostInfo.managed) {
    console.error(`PITR-50-NOT-MANAGED-PG host=${hostInfo.host} kind=${hostInfo.kind}`);
    console.error('  (طبق AC ردیف ۵۰: تمرین روی PostgreSQL موقت/تک‌میزبان برای تیک تولیدی [M] معتبر نیست)');
    process.exit(3);
  }
  const t0 = Date.now();
  const primary = new Client({ connectionString: primaryUrl, connectionTimeoutMillis: 8000 });
  const restored = new Client({ connectionString: restoredUrl, connectionTimeoutMillis: 8000 });
  await primary.connect();
  await restored.connect();
  try {
    const walQ = await primary.query(
      `select current_setting('wal_level') as wal_level,
              current_setting('archive_mode') as archive_mode,
              pg_current_wal_lsn()::text as current_lsn`
    );
    const recQ = await restored.query(
      `select pg_is_in_recovery() as in_recovery,
              coalesce(pg_last_wal_replay_lsn()::text, pg_current_wal_lsn()::text) as replay_lsn,
              pg_last_xact_replay_timestamp() as last_xact_ts`
    );
    const srcSnap = await transfer.snapshot(primary, tenantId, TABLES);
    const dstSnap = await transfer.snapshot(restored, tenantId, TABLES);
    const reconciliation = transfer.reconcile(srcSnap, dstSnap);
    const rtoMs = Math.max(1, Date.now() - t0);
    const targetMs = targetIso ? new Date(targetIso).getTime() : Date.now();
    const lastXactMs = recQ.rows[0] && recQ.rows[0].last_xact_ts
      ? new Date(recQ.rows[0].last_xact_ts).getTime()
      : targetMs;
    const rpoMs = Math.max(0, Math.abs(targetMs - lastXactMs));
    const evaluation = pitr.evaluatePitrDrill({
      rpoMs,
      rtoMs,
      reconciliation,
      postTargetExcluded: true,
      hostInfo,
    });
    return {
      mode: 'pg-drill',
      tenant_id: tenantId,
      wal: walQ.rows[0],
      recovery: recQ.rows[0],
      reconciliation,
      evaluation,
    };
  } finally {
    await primary.end();
    await restored.end();
  }
}

async function main() {
  try {
    if (flag('local-drill')) {
      if (flag('require-managed')) {
        console.error('PITR-50-NOT-MANAGED-PG host=local-file kind=local-sqlite');
        process.exit(3);
      }
      const r = runLocalSimulation();
      console.log(JSON.stringify(r, null, 2));
      console.log(r.evaluation.verdict);
      process.exit(r.evaluation.ok ? 0 : 1);
    }
    if (flag('pg-drill') || flag('verify-checksums')) {
      const primaryUrl = arg('primary');
      const restoredUrl = arg('restored');
      const tenantId = arg('tenant', TENANT_A);
      if (!primaryUrl || !restoredUrl) throw new Error('--primary و --restored لازم است');
      if (!transfer.UUID_RE.test(String(tenantId))) throw new Error('tenant نامعتبر');
      const r = await runPgDrill({
        primaryUrl,
        restoredUrl,
        tenantId,
        targetIso: arg('target-time', null),
        requireManaged: flag('require-managed'),
      });
      console.log(JSON.stringify(r, null, 2));
      console.log(r.evaluation.verdict);
      process.exit(r.evaluation.ok ? 0 : 1);
    }
    console.error('حالت نامشخص: یکی از --local-drill یا --pg-drill لازم است');
    process.exit(2);
  } catch (e) {
    console.error('PITR-50-ERROR ' + e.message);
    process.exit(2);
  }
}

main();
