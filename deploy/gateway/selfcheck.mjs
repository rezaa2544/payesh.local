#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 120 — end-to-end selfcheck of a running multi-tenant Gateway.

     node deploy/gateway/selfcheck.mjs https://api.example.ir
     node deploy/gateway/selfcheck.mjs https://api.example.ir \
          --school test-a --code <one-time code A> [--school2 test-b --code2 <code B>]

   Without codes: liveness, readiness (DB + transaction-local tenant
   context), fail-closed auth, platform API configured, HTTPS, no
   Cloudflare (D-09), latency.
   With codes (create one or two THROW-AWAY test schools in the owner panel
   first; each code is consumed by this check): the manager activates,
   writes one marker record, reads it back; school 2 must NOT see it;
   the marker is deleted at the end.

   S06 rule: https ⇒ PASS. http to a loopback address ⇒ WARN ("[S] local
   only — HTTPS NOT RUN"). http to anything else ⇒ FAIL.
   Output: one line per check + GATEWAY-SELFCHECK OK|FAILED. Exit 0/1 (2 usage).
   No token, code or secret is printed.
   ═══════════════════════════════════════════════════════════════════ */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function parseArgs(argv) {
  const o = { base: '', school: '', code: '', school2: '', code2: '', timeoutMs: 15000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--school') o.school = argv[++i] || '';
    else if (a === '--code') o.code = argv[++i] || '';
    else if (a === '--school2') o.school2 = argv[++i] || '';
    else if (a === '--code2') o.code2 = argv[++i] || '';
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]) || 15000;
    else if (!o.base && !a.startsWith('--')) o.base = a.replace(/\/+$/, '');
    else throw new Error('unknown argument: ' + a);
  }
  return o;
}

/** S06 verdict for a base URL: 'pass' | 'warn' | 'fail' */
export function transportVerdict(base) {
  const u = new URL(base);
  if (u.protocol === 'https:') return 'pass';
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return 'warn';
  return 'fail';
}

/** D-09: true when a response was served/proxied by Cloudflare */
export function isCloudflare(headers) {
  const server = String(headers.get('server') || '').toLowerCase();
  return headers.has('cf-ray') || headers.has('cf-cache-status') || server.includes('cloudflare');
}

export async function run(opts, { log = console.log } = {}) {
  const res = { pass: 0, fail: 0, warn: 0, skip: 0, lines: [] };
  const line = (kind, id, msg) => {
    res[kind.toLowerCase()]++;
    const l = `${kind.padEnd(4)}  ${id}  ${msg}`;
    res.lines.push(l); log(l);
  };
  const cf = { seen: false };
  async function call(method, p, { token, body, device } = {}) {
    const headers = { 'user-agent': 'PayeshGatewaySelfCheck/120', accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    if (device) headers['x-device-id'] = device;
    const t0 = Date.now();
    const r = await fetch(opts.base + p, { method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'manual' });
    if (isCloudflare(r.headers)) cf.seen = true;
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, data, ms: Date.now() - t0 };
  }
  async function pullAll(token, device) {
    const rows = [];
    let since = 0;
    for (let page = 0; page < 200; page++) {
      const r = await call('GET', '/api/gw/v1/pull?limit=500&since_seq=' + since, { token, device });
      if (r.status !== 200 || !r.data || !Array.isArray(r.data.rows)) throw new Error('pull ' + r.status + ' ' + ((r.data && r.data.error) || ''));
      rows.push(...r.data.rows);
      if (!r.data.more) return rows;
      since = r.data.next_seq;
    }
    throw new Error('pull did not finish in 200 pages');
  }
  const step = async (id, desc, fn) => {
    try { await fn(); } catch (e) { line('FAIL', id, `${desc} → ${String((e && e.message) || e).slice(0, 160)}`); }
  };

  const tv = transportVerdict(opts.base);
  if (tv === 'pass') line('PASS', 'S06', 'HTTPS');
  else if (tv === 'warn') line('WARN', 'S06', 'http روی loopback — فقط [S] محلی؛ HTTPS اجرا نشد (NOT RUN)');
  else line('FAIL', 'S06', 'نشانی عمومی بدون HTTPS — روی میزبان واقعی فقط https://');

  let health = null;
  await step('S01', 'healthz', async () => {
    health = await call('GET', '/healthz');
    if (health.status !== 200 || !health.data || health.data.ok !== true) throw new Error('status ' + health.status);
    line('PASS', 'S01', `/healthz زنده (${health.ms}ms, instance ${String(health.data.instance || '?').slice(0, 24)})`);
  });
  await step('S02', 'readyz', async () => {
    const r = await call('GET', '/readyz');
    const d = r.data || {};
    if (r.status !== 200 || d.ok !== true) throw new Error(`status ${r.status} ${d.error || ''}`.trim());
    if (d.tenant_scoped !== true || d.leaked_after_commit !== false) throw new Error('tenant context is not transaction-local');
    line('PASS', 'S02', '/readyz آماده: DB وصل، زمینهٔ مستأجر فقط درون تراکنش');
  });
  await step('S03', 'unauthenticated pull', async () => {
    const r = await call('GET', '/api/gw/v1/pull?since_seq=0');
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
    line('PASS', 'S03', 'pull بدون توکن ⇒ 401');
  });
  await step('S04', 'forged token', async () => {
    const forged = 'v1.' + Buffer.from(JSON.stringify({ v: 1, tid: crypto.randomUUID(), role: 'manager', uid: 1, exp: Date.now() + 60000 })).toString('base64url') + '.' + crypto.randomBytes(32).toString('base64url');
    const r = await call('GET', '/api/gw/v1/pull?since_seq=0', { token: forged, device: 'selfcheck-forged' });
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
    line('PASS', 'S04', 'توکن جعلی ⇒ 401');
  });
  await step('S05', 'platform API', async () => {
    const r = await call('GET', '/api/platform/v1/dashboard');
    if (r.status === 503) throw new Error('API پنل مالک پیکربندی نشده (503 not_configured)');
    if (r.status !== 401) throw new Error('expected 401 without token, got ' + r.status);
    line('PASS', 'S05', 'API پنل مالک پیکربندی شده و بدون توکن ⇒ 401');
  });
  if (health && health.ms > 1500) line('WARN', 'S08', `پاسخ کند (${health.ms}ms)`);
  else if (health) line('PASS', 'S08', `زمان پاسخ ${health.ms}ms`);

  if (!opts.school || !opts.code) {
    line('SKIP', 'S09', 'فعال‌سازی/نوشتن/خواندن اجرا نشد (--school/--code نداده‌اید)');
  } else {
    const devA = 'selfcheck-' + crypto.randomBytes(4).toString('hex');
    const markerId = 900000000 + crypto.randomInt(0, 99999999);
    const marker = 'payesh-selfcheck-' + crypto.randomBytes(6).toString('hex');
    let tokA = null;
    await step('S09', 'activation', async () => {
      const r = await call('POST', '/api/gw/v1/session/activate', { body: { school: opts.school, code: opts.code, device_id: devA } });
      if (r.status !== 200 || !r.data || !r.data.token) throw new Error(`status ${r.status} ${(r.data && r.data.error) || ''}`.trim());
      if (r.data.role !== 'manager') throw new Error('expected manager role, got ' + r.data.role);
      tokA = r.data.token;
      line('PASS', 'S09', 'مدیر مدرسهٔ ۱ با کد یک‌بارمصرف فعال شد');
    });
    if (tokA) {
      let wrote = false;
      await step('S10', 'write + read back', async () => {
        const p = await call('POST', '/api/gw/v1/push', { token: tokA, device: devA, body: { ops: [
          { uid: marker, collection: 'announcements', id: markerId, type: 'put', data: { title: marker }, base_version: 0 }] } });
        if (p.status !== 200 || !p.data || !Array.isArray(p.data.applied) || p.data.applied.length !== 1) throw new Error('push ' + p.status);
        wrote = true;
        const rows = await pullAll(tokA, devA);
        if (!rows.some(r => r.collection === 'announcements' && Number(r.id ?? r.record_id) === markerId)) throw new Error('marker not read back');
        line('PASS', 'S10', 'نوشتن یک رکورد نشانه و خواندن دوباره');
      });
      if (!opts.school2 || !opts.code2) {
        line('SKIP', 'S11', 'جداسازی دو مدرسه اجرا نشد (--school2/--code2 نداده‌اید)');
      } else {
        await step('S11', 'isolation', async () => {
          const devB = 'selfcheck-' + crypto.randomBytes(4).toString('hex');
          const r = await call('POST', '/api/gw/v1/session/activate', { body: { school: opts.school2, code: opts.code2, device_id: devB } });
          if (r.status !== 200 || !r.data || !r.data.token) throw new Error(`activation 2: status ${r.status}`);
          const rows = await pullAll(r.data.token, devB);
          const leaked = rows.filter(x => JSON.stringify(x).includes(marker));
          if (leaked.length) throw new Error(`مدرسهٔ ۲ رکورد نشانهٔ مدرسهٔ ۱ را دید (${leaked.length} ردیف) — نشت`);
          line('PASS', 'S11', `مدرسهٔ ۲ هیچ ردیفی از مدرسهٔ ۱ نمی‌بیند (${rows.length} ردیف خودش)`);
        });
      }
      if (wrote) {
        await step('S12', 'cleanup', async () => {
          const d = await call('POST', '/api/gw/v1/push', { token: tokA, device: devA, body: { ops: [
            { uid: marker + '-del', collection: 'announcements', id: markerId, type: 'del' }] } });
          if (d.status !== 200) throw new Error('delete ' + d.status);
          line('PASS', 'S12', 'رکورد نشانه حذف شد');
        });
      }
    }
  }
  if (cf.seen) line('FAIL', 'S07', 'پاسخ از Cloudflare عبور کرده (cf-ray / server: cloudflare) — ممنوع طبق D-09');
  else line('PASS', 'S07', 'نشانه‌ای از Cloudflare در پاسخ‌ها نیست (D-09)');

  const summary = `GATEWAY-SELFCHECK ${res.fail ? 'FAILED' : 'OK'} pass=${res.pass} fail=${res.fail} warn=${res.warn} skip=${res.skip}`;
  log(summary);
  return Object.assign(res, { ok: res.fail === 0, summary });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); new URL(opts.base); }
  catch (e) {
    console.error('استفاده: node deploy/gateway/selfcheck.mjs https://<نشانی> [--school S --code C [--school2 S2 --code2 C2]]');
    process.exit(2);
  }
  const r = await run(opts);
  process.exit(r.ok ? 0 : 1);
}
