'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پشتیبان‌گیری مدیریت‌شده / PITR و تمرین بازیابی — ردیف ۵۰
                                                          (PITR-50)

   هدف‌های مصوب ردیف ۵۰:
     • RPO <= ۵ دقیقه (۳۰۰٬۰۰۰ میلی‌ثانیه)
     • RTO <= ۲ ساعت (۷٬۲۰۰٬۰۰۰ میلی‌ثانیه)
     • تأیید یکپارچگی سه‌لایه (تعداد ردیف، SHA-256 محتوا، seq/version)
     • تفکیک صریح و غیرقابل‌جعل میان:
         [S] تمرین روی دیتابیس محلی / PostgreSQL تک‌میزبان موقت
         [M] تمرین روی پلن مدیریت‌شدهٔ واقعی (Neon / Supabase / RDS / ...)
       تا هرگز تمرین محلی به‌جای شاهد تولیدی [M] جا زده نشود.
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const transfer = require('./transfer');

const RPO_TARGET_MS = 5 * 60 * 1000;       // ۵ دقیقه
const RTO_TARGET_MS = 2 * 60 * 60 * 1000;  // ۲ ساعت

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'postgres', 'db']);
const MANAGED_HOST_RE = /\.(neon\.tech|supabase\.co|supabase\.com|rds\.amazonaws\.com|aivencloud\.com|digitalocean\.com|arvancloud\.ir)$/i;

function classifyPgHost(urlStr, env = process.env) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { kind: 'local-sqlite', managed: false, tag: '[S]', host: 'local-file' };
  }
  try {
    const u = new URL(urlStr);
    const host = String(u.hostname || '').toLowerCase();
    if (!host || LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.startsWith('127.')) {
      return { kind: 'single-host-ephemeral', managed: false, tag: '[S]', host };
    }
    const isKnownManaged = MANAGED_HOST_RE.test(host) || String(env.PAYESH_PG_MANAGED || '') === '1';
    return {
      kind: isKnownManaged ? 'managed-provider' : 'remote-self-hosted',
      managed: isKnownManaged,
      tag: isKnownManaged ? '[M]' : '[S]',
      host,
    };
  } catch (e) {
    return { kind: 'invalid-url', managed: false, tag: '[S]', host: '' };
  }
}

/* ارزیابی نهایی تمرین PITR در برابر معیارهای پذیرش ردیف ۵۰ */
function evaluatePitrDrill({
  rpoMs,
  rtoMs,
  reconciliation,
  postTargetExcluded = true,
  hostInfo = { managed: false, tag: '[S]', kind: 'local-sqlite' },
}) {
  const rpoOk = typeof rpoMs === 'number' && rpoMs >= 0 && rpoMs <= RPO_TARGET_MS;
  const rtoOk = typeof rtoMs === 'number' && rtoMs >= 0 && rtoMs <= RTO_TARGET_MS;
  const reconOk = !!(reconciliation && reconciliation.ok);
  const exclOk = postTargetExcluded === true;
  const drillOk = rpoOk && rtoOk && reconOk && exclOk;
  const productionValid = drillOk && hostInfo.managed === true;

  return {
    ok: drillOk,
    production_valid: productionValid,
    tag: hostInfo.tag || (hostInfo.managed ? '[M]' : '[S]'),
    environment_kind: hostInfo.kind,
    rpo_ms: rpoMs,
    rpo_target_ms: RPO_TARGET_MS,
    rpo_ok: rpoOk,
    rto_ms: rtoMs,
    rto_target_ms: RTO_TARGET_MS,
    rto_ok: rtoOk,
    reconciliation_ok: reconOk,
    post_target_excluded: exclOk,
    verdict: !drillOk
      ? 'PITR-50-FAILED'
      : (productionValid ? 'PITR-50-MANAGED-OK' : 'PITR-50-SIMULATED-OK'),
  };
}

function canonicalizeRow(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  for (const k of Object.keys(r).sort()) {
    const v = r[k];
    out[k] = (v && typeof v === 'object') ? JSON.stringify(v, Object.keys(v).sort()) : v;
  }
  return out;
}

/* خلاصهٔ وضعیت (counts + checksums + seqs) روی آرایه‌ای از رکوردهای جدول‌ها */
function snapshotFromTables(tablesMap, tenantId = null) {
  const counts = {};
  const checksums = {};
  const seqs = {};
  for (const [tableName, rows] of Object.entries(tablesMap || {})) {
    const filtered = (Array.isArray(rows) ? rows : []).filter(
      r => !tenantId || !r.tenant_id || r.tenant_id === tenantId
    );
    counts[tableName] = filtered.length;
    checksums[tableName] = transfer.stableChecksum(filtered.map(canonicalizeRow));
    for (const r of filtered) {
      const key = `${tableName}:${r.id}`;
      if (r.seq !== undefined) seqs[key] = Number(r.seq);
      else if (r.version !== undefined) seqs[key] = Number(r.version);
    }
  }
  return { counts, checksums, seqs };
}

/* ── موتور تمرین محلی PITR (basebackup + WAL append-log replay) ──────
   این مسیر منطق واقعی بازیابی به نقطهٔ زمانی (t <= targetIso)، حذف تراکنش‌های
   پس از نقطهٔ هدف، و تطبیق سه‌لایهٔ چک‌سام را بدون نیاز به شبکه در CI می‌سنجد. */
function createWalArchive(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const baseFile = path.join(dir, 'basebackup.json');
  const walFile = path.join(dir, 'wal.jsonl');

  function writeBaseBackup(tablesMap, takenAtIso) {
    const payload = {
      taken_at: takenAtIso || new Date().toISOString(),
      tables: JSON.parse(JSON.stringify(tablesMap || {})),
    };
    const raw = JSON.stringify(payload);
    payload.sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    fs.writeFileSync(baseFile, JSON.stringify(payload, null, 2), 'utf8');
    return { file: baseFile, sha256: payload.sha256, taken_at: payload.taken_at };
  }

  function appendWalEntry(entry) {
    const rec = {
      lsn: entry.lsn,
      at: entry.at,
      op: entry.op, // 'upsert' | 'delete'
      table: entry.table,
      tenant_id: entry.tenant_id || null,
      row: entry.row || null,
      id: entry.id != null ? entry.id : (entry.row && entry.row.id),
    };
    const body = JSON.stringify(rec);
    rec.crc_sha256 = crypto.createHash('sha256').update(body).digest('hex');
    fs.appendFileSync(walFile, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  function restoreToPointInTime(targetIso) {
    const t0 = Date.now();
    const targetMs = new Date(targetIso).getTime();
    if (Number.isNaN(targetMs)) throw new Error('target_iso نامعتبر: ' + targetIso);
    const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    const checkRaw = JSON.stringify({ taken_at: base.taken_at, tables: base.tables });
    const checkSha = crypto.createHash('sha256').update(checkRaw).digest('hex');
    if (checkSha !== base.sha256) throw new Error('basebackup_checksum_corrupted');

    const tables = JSON.parse(JSON.stringify(base.tables || {}));
    const lines = fs.existsSync(walFile)
      ? fs.readFileSync(walFile, 'utf8').split('\n').filter(Boolean)
      : [];

    let replayed = 0;
    let skippedAfterTarget = 0;
    let lastReplayedAtMs = new Date(base.taken_at).getTime();

    for (const line of lines) {
      const rec = JSON.parse(line);
      const { crc_sha256, ...rest } = rec;
      const expectedCrc = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
      if (crc_sha256 !== expectedCrc) throw new Error(`wal_crc_mismatch:lsn=${rec.lsn}`);

      const recMs = new Date(rec.at).getTime();
      if (recMs > targetMs) {
        skippedAfterTarget++;
        continue;
      }
      if (!tables[rec.table]) tables[rec.table] = [];
      const arr = tables[rec.table];
      const idx = arr.findIndex(r => String(r.id) === String(rec.id));
      if (rec.op === 'upsert') {
        if (idx >= 0) arr[idx] = rec.row;
        else arr.push(rec.row);
      } else if (rec.op === 'delete') {
        if (idx >= 0) arr.splice(idx, 1);
      }
      replayed++;
      if (recMs > lastReplayedAtMs) lastReplayedAtMs = recMs;
    }

    const rtoMs = Math.max(1, Date.now() - t0);
    const rpoMs = Math.max(0, targetMs - lastReplayedAtMs);
    return {
      tables,
      replayed,
      skipped_after_target: skippedAfterTarget,
      last_replayed_at: new Date(lastReplayedAtMs).toISOString(),
      target_iso: targetIso,
      rpo_ms: rpoMs,
      rto_ms: rtoMs,
    };
  }

  return { writeBaseBackup, appendWalEntry, restoreToPointInTime, baseFile, walFile };
}

module.exports = {
  RPO_TARGET_MS,
  RTO_TARGET_MS,
  classifyPgHost,
  evaluatePitrDrill,
  snapshotFromTables,
  createWalArchive,
};
