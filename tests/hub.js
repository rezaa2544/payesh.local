'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون Hub ابری بدون Cloudflare:
   Worker را داخل Node اجرا می‌کنیم و D1 را با node:sqlite جعل می‌کنیم.
   اجرا: node --experimental-sqlite tests/hub.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-hub-'));
let passed = 0, failed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); })
    .catch(e => { failed++; console.log('  ✗ ' + name + '\n     ' + e.message); });
}

/* ── D1 جعلی روی node:sqlite ─────────────────────────────────────── */
function makeD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { try { return stmt.get(...args) ?? null; } catch (e) { return null; } },
        async all() { try { return { results: stmt.all(...args) }; } catch (e) { return { results: [] }; } },
        async run() { try { const r = stmt.run(...args); return { success: true, meta: { changes: r.changes } }; } catch (e) { return { success: false, error: e.message }; } },
      };
      return api;
    },
  };
}

(async () => {
  console.log('\nHub ابری — آزمون\n');

  const db = new DatabaseSync(path.join(TMP, 'hub.sqlite'));
  db.exec(fs.readFileSync(path.join(ROOT, 'hub/schema.sql'), 'utf8'));

  const worker = (await import('../hub/worker.js')).default;
  const SCHOOL_KEY = 'test-school-key-123';
  const env = { DB: makeD1(db), SCHOOL_KEY };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = new Request('http://hub.local' + req.url, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const out = await worker.fetch(r, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const HUB_URL = 'http://127.0.0.1:' + server.address().port;

  /* ── ذخیره‌گاه مدرسه ── */
  const { openStore } = require(ROOT + '/server/db');
  const store = openStore(path.join(TMP, 'school.sqlite'));
  const cfg = require(ROOT + '/server/config');
  const hub = require(ROOT + '/server/hub');

  const cls = store.insert('classes', { name: 'دهم شبکه', grade: 'دهم' });
  const subject = store.insert('subjects', { name: 'ریاضی', code: 'MATH' });
  const student = store.insert('users', { name: 'سارا احمدی', role: 'student', class_id: cls.id, active: true, school_id: 1 });
  const parent = store.insert('users', { name: 'ولی احمدی', role: 'parent', active: true, school_id: 1 });
  store.insert('parent_links', { parent_id: parent.id, student_id: student.id, relation: 'father' });
  store.insert('attendance', { student_id: student.id, class_id: cls.id, date: '2026-10-29', status: 'present' });
  store.insert('attendance', { student_id: student.id, class_id: cls.id, date: '2026-10-30', status: 'absent' });
  store.insert('grades', { student_id: student.id, class_id: cls.id, subject_id: subject.id, term: 'نوبت اول', score: 18, status: 'approved' });
  store.insert('announcements', { title: 'امتحان هفتهٔ آینده', body: 'متن', date: '2026-10-30', severity: 'info' });

  cfg.setMeta(store, 'hub_key', SCHOOL_KEY);   /* همان کلیدی که در Worker تنظیم شده */
  cfg.setMeta(store, 'hub_url', HUB_URL);
  cfg.setMeta(store, 'hub_enabled', true);

  await test('Hub بدون کلید مدرسه، دسترسی نمی‌دهد', async () => {
    const res = await fetch(HUB_URL + '/v1/push', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.strictEqual(res.status, 403);
    const bad = await fetch(HUB_URL + '/v1/outbox', { headers: { authorization: 'Bearer wrong' } });
    assert.strictEqual(bad.status, 403);
  });

  await test('ارسال نمای خانواده از مدرسه به Hub', async () => {
    const r = await hub.push(store, { force: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sent, 1);
    const health = await (await fetch(HUB_URL + '/v1/health')).json();
    assert.strictEqual(health.students, 1);
  });

  await test('بار دوم فقط تغییرات فرستاده می‌شود', async () => {
    const r = await hub.push(store);
    assert.strictEqual(r.sent, 0, 'بدون تغییر، هیچ ردی فرستاده نمی‌شود');
    store.insert('attendance', { student_id: student.id, class_id: cls.id, date: '2026-10-31', status: 'late' });
    const r2 = await hub.push(store);
    assert.strictEqual(r2.sent, 1, 'با تغییر، فقط همان دانش‌آموز');
  });

  await test('ولی فقط خلاصهٔ فرزند خودش را می‌بیند', async () => {
    const token = hub.familyToken(store, student.id);
    const res = await fetch(HUB_URL + '/v1/family', { headers: { authorization: 'Bearer ' + token } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.student_id, student.id);
    assert.strictEqual(data.payload.name, 'سارا احمدی');
    assert.strictEqual(data.payload.grades[0].score, 18);
    assert.ok(data.payload.attendance.total >= 3);
    assert.ok(!JSON.stringify(data.payload).includes('national_id'), 'کد ملی فرستاده نمی‌شود');

    const wrong = await fetch(HUB_URL + '/v1/family', { headers: { authorization: 'Bearer 0000' } });
    assert.strictEqual(wrong.status, 404);
  });

  await test('درخواست مرخصی شبانه در Hub می‌ماند و مدرسه آن را می‌کشد', async () => {
    const token = hub.familyToken(store, student.id);
    const post = await fetch(HUB_URL + '/v1/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ uid: 'hub-leave-1', kind: 'leave', payload: { date: '2026-11-01', reason: 'مراجعه به پزشک' } }),
    });
    assert.strictEqual((await post.json()).queued, true);

    /* ارسال تکراری با همان uid نباید ردیف تازه بسازد */
    await fetch(HUB_URL + '/v1/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ uid: 'hub-leave-1', kind: 'leave', payload: { date: '2026-11-01', reason: 'مراجعه به پزشک' } }),
    });
    const pending = await (await fetch(HUB_URL + '/v1/health')).json();
    assert.strictEqual(pending.outbox_pending, 1);

    const d1 = await hub.drain(store);
    assert.strictEqual(d1.fetched, 1);
    assert.strictEqual(d1.applied, 1);

    const leaves = store.all('leaves').filter(l => Number(l.student_id) === Number(student.id));
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].reason, 'مراجعه به پزشک');
    assert.strictEqual(leaves[0].status, 'pending');
    assert.strictEqual(leaves[0].source, 'hub');

    /* صف خالی و کشیدن دوباره چیزی اضافه نمی‌کند */
    const again = await hub.drain(store);
    assert.strictEqual(again.fetched, 0);
    assert.strictEqual(store.all('leaves').length, 1);
  });

  await test('همگام‌سازی کامل (push + drain) بدون خطا', async () => {
    const r = await hub.sync(store, { force: true });
    assert.strictEqual(r.push.ok, true);
    assert.strictEqual(r.drain.ok, true);
  });

  server.close();
  try { store.close(); } catch (e) { /* noop */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} موفق · ${failed} ناموفق\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
