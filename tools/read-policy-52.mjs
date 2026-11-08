#!/usr/bin/env node
/* ردیف ۵۲ — اثبات عملی ناوردای read-your-writes روی Gateway واقعی.
   هر دستگاه: push → بلافاصله pull؛ باید ردیف خودش را ببیند.
   همچنین مقصد خواندن (read_from) در هر پاسخ ثبت می‌شود.

   اجرا: PAYESH_GW_URL=... PAYESH_PG_ADMIN_URL=... PAYESH_TENANCY_SECRET=... \
         node tools/read-policy-52.mjs --devices 40 --rounds 5 */
'use strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tenancy = require(path.join(__dirname, '..', 'server', 'tenancy.js'));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const GW = process.env.PAYESH_GW_URL || 'http://127.0.0.1:5671';
const SECRET = process.env.PAYESH_TENANCY_SECRET || '';
const ADMIN_URL = process.env.PAYESH_PG_ADMIN_URL || '';
const DEVICES = Number(arg('devices', 40));
const ROUNDS = Number(arg('rounds', 5));
const TENANT = '11111111-2222-4333-8444-555555555555';

function tokenFor(deviceId) {
  return tenancy.signToken({
    tid: TENANT, role: 'manager', uid: 'rp-u-' + deviceId,
    did: deviceId, iat: Date.now(), exp: Date.now() + 3600_000,
  }, SECRET);
}

async function post(url, token, deviceId, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'x-device-id': deviceId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let d = null; try { d = await r.json(); } catch (e) { /* بدنهٔ خالی */ }
  return { status: r.status, body: d };
}

/* یک خواندن به‌ازای هر دستگاه: باید رکوردی که خودش همین حالا نوشته را ببیند */
async function readOwn(token, deviceId, recordId) {
  const r = await fetch(`${GW}/api/gw/v1/pull?since_seq=0&limit=200`, {
    headers: { authorization: 'Bearer ' + token, 'x-device-id': deviceId },
    signal: AbortSignal.timeout(20000),
  });
  let d = null; try { d = await r.json(); } catch (e) { /* بدنهٔ خالی */ }
  const rows = (d && Array.isArray(d.rows)) ? d.rows : [];
  return {
    status: r.status,
    readFrom: d && d.read_from, readReason: d && d.read_reason,
    sawOwn: rows.some(x => Number(x.id) === Number(recordId)),
    rows: rows.length,
    nextSeq: d && d.next_seq,
  };
}

(async () => {
  if (!SECRET || SECRET.length < 16) { console.error('BLOCKED: secret'); process.exit(3); }
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await tenancy.migrate(admin);
  /* جدول tenants وجود ندارد: مستأجر همان uuid در RLS است (tenancy.SCHEMA_SQL) */
  await admin.end();

  let pushes = 0, pulls = 0, stale = 0, errors = 0;
  const targets = {};
  const t0 = Date.now();
  const seq = [];
  for (let round = 0; round < ROUNDS; round++) {
    await Promise.all(Array.from({ length: DEVICES }, async (_v, i) => {
      const deviceId = `rp-dev-${i}`;
      const token = tokenFor(deviceId);
      const recordId = 700000 + i * 100 + round;
      const p = await post(`${GW}/api/gw/v1/push`, token, deviceId, {
        ops: [{ uid: `rp-${i}-${round}`, collection: 'attendance', id: recordId, type: 'put', data: { round, device: i } }],
      });
      pushes++;
      if (p.status !== 200) { errors++; return; }
      const r = await readOwn(token, deviceId, recordId);
      pulls++;
      if (r.status !== 200) { errors++; return; }
      targets[r.readFrom || 'null'] = (targets[r.readFrom || 'null'] || 0) + 1;
      seq.push(r.nextSeq);
      if (!r.sawOwn) stale++;
    }));
  }
  const ms = Date.now() - t0;
  const out = {
    at: new Date().toISOString(), gateway: GW, devices: DEVICES, rounds: ROUNDS,
    pushes, pulls, stale_reads: stale, errors, duration_ms: ms,
    read_targets: targets, next_seq_max: Math.max(...seq.filter(Number.isFinite), 0),
    replica_configured: !!process.env.PAYESH_GW_HAS_REPLICA,
  };
  console.log(JSON.stringify(out));
  const ok = stale === 0 && errors === 0 && pushes === DEVICES * ROUNDS;
  console.log(ok ? 'READ-POLICY-52-OK' : 'READ-POLICY-52-FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
