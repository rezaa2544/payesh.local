// پشتیبانی — پیام و گزارش مشکل کاربران به مالک (ردیف ۱۵۲) — server/support.js در برابر صندوقچهٔ S3
// محلی با بازبینی واقعی SigV4 و یک پایگاه دادهٔ واقعی (SQLite)، و سرور واقعی HTTP.
//
//   SP-01  بردارهای قرارداد support v1 (همان بایت‌های پنل مالک Dart): نوع‌ها، پوشه‌ها، دسته‌ها، پاکت تیکت و پاسخ.
//   SP-02  تیکت تازه اول در پایگاه دادهٔ سرور، بعد مهرشده در صندوقچه (نوع payesh-support-ticket)؛ بدون رمز/توکن؛
//          فقط نامهٔ کاربر در پاکت؛ نام و شناسهٔ مدرسه همراه تیکت.
//   SP-03  صندوقچه در دسترس نیست ⇒ هیچ پیامی گم نمی‌شود: «در صف ارسال» می‌ماند، flush بعدی همه را می‌فرستد.
//   SP-04  پاسخ مالک (payesh-support-reply) ادغام می‌شود (ترتیب زمانی، وضعیت «پاسخ داده شد»)؛ پیام تازهٔ کاربر
//          تیکت را دوباره باز می‌کند و وضعیت قدیمی‌ترِ مالک آن را نمی‌بندد؛ پاسخ با کلید دیگر نادیده.
//   SP-05  اعتبارسنجی: موضوع/متن کوتاه، شناسهٔ نادرست، تیکت کاربر دیگر (not_found)، سقف پیام‌ها؛ بستن توسط کاربر.
//   SP-06  سرور واقعی (HTTP): کاربری که اشتراکش تمام شده (402 برای بقیه) باز هم به پشتیبانی دسترسی دارد؛
//          GET/POST /api/support، /message، /close؛ بدون نشست 401؛ خطای اعتبارسنجی 400.
// خط آخر: SUPPORT-152-OK checks=N | SUPPORT-152-FAIL failures=N
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const sp = require(path.join(ROOT, 'server', 'support.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));
const { pbkdf2Hash } = require(path.join(ROOT, 'server', 'util.js'));
const { startStub } = require('./lib/s3-stub');

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}

const tmpDirs = [];
function newStore(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp152-'));
  tmpDirs.push(dir);
  const store = openStore(path.join(dir, 'payesh.sqlite'));
  if (cfg) s3mem.usingMeta(store).set(Object.assign({}, cfg));
  return store;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function req(method, port, p, body, headers = {}) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {});
    const r = http.request({ method, host: '127.0.0.1', port, path: p, headers: h }, (rs) => {
      let t = ''; rs.setEncoding('utf8'); rs.on('data', (c) => { t += c; });
      rs.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } res({ status: rs.statusCode, body: t, json: j }); });
    });
    r.on('error', (e) => res({ status: 0, body: String(e.message), json: null }));
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
async function readKind(cfg, key, kind) {
  try { return sr.open(cfg.secret, kind, JSON.parse(await s3mem.get(cfg, cfg.prefix + key))); } catch (e) { return null; }
}
async function ownerReply(cfg, id, rev, plain) {
  await s3mem.put(cfg, cfg.prefix + sp.DIR.reply + id + '.json', JSON.stringify(sr.seal(cfg.secret, sp.K.reply, rev, JSON.stringify(plain))));
}

(async () => {
  const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/support-vectors.json'), 'utf8'));

  await check('SP-01 بردارهای قرارداد support v1', async () => {
    assert.strictEqual(V.salt, sr.SALT);
    assert.deepStrictEqual(V.kinds, sp.K);
    assert.deepStrictEqual(V.dirs, sp.DIR);
    assert.deepStrictEqual(V.categories, sp.CATEGORIES);
    assert.deepStrictEqual(V.statuses, sp.STATUSES);
    assert.strictEqual(V.id_re, sp.ID_RE.source);
    for (const [name, c] of Object.entries(V.cases)) {
      const env = sr.seal(V.secret, V.kinds[name], V.rev, c.plaintext, Buffer.from(V.nonce_hex, 'hex'));
      assert.deepStrictEqual(env, c.envelope, name);
      assert.deepStrictEqual(sr.open(V.secret, V.kinds[name], c.envelope).plain, JSON.parse(c.plaintext));
      const other = name === 'ticket' ? V.kinds.reply : V.kinds.ticket;
      assert.throws(() => sr.open(V.secret, other, Object.assign({}, c.envelope, { kind: other })));
    }
  });

  const S = await startStub({ accessKey: 'ak-s', secret: 'sk-support-1', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  const user = { id: 7, name: 'زهرا کریمی', role: 'teacher', password_hash: 'x', phone: '09120000007' };
  try {
    await check('SP-02 تیکت تازه: پایگاه دادهٔ سرور + پاکت مهرشده در صندوقچه', async () => {
      const store = newStore(cfg);
      store.insert('schools', { name: 'دبستان نمونه', created_at: new Date().toISOString() }, { id: 1 });
      store.setMeta('schools:bound', { school_id: 's-0042', at: new Date().toISOString() });
      const r = await sp.create(store, user, { category: 'bug', subject: '  حضور و غیاب   ذخیره نمی‌شود ', text: 'بعد از ثبت، صفحه خالی می‌شود.' });
      assert.strictEqual(r.ok, true); assert.strictEqual(r.reported, true);
      assert.match(r.ticket.id, sp.ID_RE);
      assert.strictEqual(r.ticket.subject, 'حضور و غیاب ذخیره نمی‌شود');
      assert.strictEqual(r.ticket.status, 'open'); assert.strictEqual(r.ticket.pending, false);
      const env = await readKind(cfg, sp.DIR.ticket + r.ticket.id + '.json', sp.K.ticket);
      assert.ok(env, 'sealed ticket in the bucket');
      assert.strictEqual(env.plain.school_id, 's-0042'); assert.strictEqual(env.plain.school, 'دبستان نمونه');
      assert.strictEqual(env.plain.role, 'teacher'); assert.strictEqual(env.plain.name, 'زهرا کریمی');
      assert.strictEqual(env.plain.messages.length, 1); assert.strictEqual(env.plain.messages[0].from, 'user');
      const raw = JSON.stringify(env.plain);
      assert.ok(!raw.includes('password') && !raw.includes('09120000007'), 'no secrets/phone');
      assert.strictEqual(store.getMeta(sp.META).length, 1);
      store.close();
    });

    await check('SP-03 صندوقچه در دسترس نیست ⇒ در صف ارسال، بعد ارسال کامل (هیچ پیامی گم نمی‌شود)', async () => {
      const dead = Object.assign({}, cfg, { endpoint: 'http://127.0.0.1:1' });
      const store = newStore(s3mem.normalize(dead));
      const a = await sp.create(store, user, { category: 'payment', subject: 'پرداخت ثبت نشد', text: 'مبلغ کسر شد.' });
      assert.strictEqual(a.reported, false); assert.strictEqual(a.ticket.pending, true);
      const b = await sp.message(store, user, a.ticket.id, { text: 'کد پیگیری 123456' });
      assert.strictEqual(b.reported, false);
      const c = await sp.create(store, user, { category: 'question', subject: 'سؤال دوم', text: 'متن' });
      assert.strictEqual(c.ticket.pending, true);
      const l = await sp.list(store, user);
      assert.strictEqual(l.online, false); assert.strictEqual(l.tickets.length, 2);
      assert.ok(l.tickets.every(t => t.pending));
      /* بازگشت اتصال ⇒ همه با همهٔ پیام‌ها فرستاده می‌شوند */
      s3mem.usingMeta(store).set(Object.assign({}, cfg));
      assert.strictEqual(await sp.flush(store), 2);
      const ea = await readKind(cfg, sp.DIR.ticket + a.ticket.id + '.json', sp.K.ticket);
      assert.strictEqual(ea.plain.messages.length, 2); assert.strictEqual(ea.plain.messages[1].text, 'کد پیگیری 123456');
      assert.ok(await readKind(cfg, sp.DIR.ticket + c.ticket.id + '.json', sp.K.ticket));
      assert.ok((await sp.list(store, user)).tickets.every(t => !t.pending));
      assert.strictEqual(await sp.flush(store), 0);
      store.close();
    });

    await check('SP-04 پاسخ مالک ادغام می‌شود؛ پیام تازهٔ کاربر دوباره باز می‌کند', async () => {
      const store = newStore(cfg);
      const a = await sp.create(store, user, { category: 'bug', subject: 'خطای گزارش', text: 'گزارش باز نمی‌شود' });
      const id = a.ticket.id;
      await sleep(5);
      const t1 = new Date().toISOString();
      await ownerReply(cfg, id, 1, { v: 1, id, status: 'answered', updated_at: t1, messages: [{ at: t1, from: 'owner', text: 'لطفاً نسخه را به‌روز کنید.' }] });
      let l = await sp.list(store, user);
      assert.strictEqual(l.online, true);
      let t = l.tickets.find(x => x.id === id);
      assert.strictEqual(t.status, 'answered');
      assert.deepStrictEqual(t.messages.map(m => m.from), ['user', 'owner']);
      assert.strictEqual(t.messages[1].text, 'لطفاً نسخه را به‌روز کنید.');
      /* پاکت تیکت فقط نامهٔ کاربر را دارد (پاسخ مالک دوباره در پاکت کاربر نوشته نمی‌شود) */
      await sleep(5);
      await sp.message(store, user, id, { text: 'به‌روز کردم، هنوز هست.' });
      const env = await readKind(cfg, sp.DIR.ticket + id + '.json', sp.K.ticket);
      assert.deepStrictEqual(env.plain.messages.map(m => m.from), ['user', 'user']);
      l = await sp.list(store, user);
      t = l.tickets.find(x => x.id === id);
      assert.strictEqual(t.status, 'open', 'older owner status does not override a newer user message');
      assert.deepStrictEqual(t.messages.map(m => m.from), ['user', 'owner', 'user']);
      await sleep(5);
      const t2 = new Date().toISOString();
      await ownerReply(cfg, id, 2, { v: 1, id, status: 'closed', updated_at: t2, messages: [{ at: t1, from: 'owner', text: 'لطفاً نسخه را به‌روز کنید.' }, { at: t2, from: 'owner', text: 'رفع شد در نسخهٔ بعد.' }] });
      t = (await sp.list(store, user)).tickets.find(x => x.id === id);
      assert.strictEqual(t.status, 'closed'); assert.strictEqual(t.messages.length, 4);
      /* پاسخ مهرشده با کلید دیگر ⇒ نادیده (نه خطا) */
      const b = await sp.create(store, user, { category: 'other', subject: 'تیکت دوم', text: 'متن' });
      await s3mem.put(cfg, cfg.prefix + sp.DIR.reply + b.ticket.id + '.json', JSON.stringify(sr.seal('other-secret', sp.K.reply, 1, JSON.stringify({ v: 1, id: b.ticket.id, status: 'closed', messages: [{ at: t2, from: 'owner', text: 'جعلی' }] }))));
      t = (await sp.list(store, user)).tickets.find(x => x.id === b.ticket.id);
      assert.strictEqual(t.status, 'open'); assert.strictEqual(t.messages.length, 1);
      store.close();
    });

    await check('SP-05 اعتبارسنجی، مالکیت تیکت، سقف پیام، بستن', async () => {
      const store = newStore(null);
      const code = async (fn) => { try { await fn(); return 'ok'; } catch (e) { assert.ok(e instanceof sp.SupportError, String(e)); return e.code; } };
      assert.strictEqual(await code(() => sp.create(store, user, { subject: 'اب', text: 'متن کافی' })), 'bad_subject');
      assert.strictEqual(await code(() => sp.create(store, user, { subject: 'موضوع درست', text: ' ' })), 'bad_text');
      const a = await sp.create(store, user, { category: 'nonsense', subject: 'موضوع درست', text: 'متن' });
      assert.strictEqual(a.ticket.category, 'other'); assert.strictEqual(a.reported, false, 'no database ⇒ queued');
      const other = { id: 8, name: 'دیگری', role: 'student' };
      assert.strictEqual(await code(() => sp.message(store, other, a.ticket.id, { text: 'سلام' })), 'not_found');
      assert.strictEqual(await code(() => sp.message(store, user, 'TKT-zz', { text: 'سلام' })), 'bad_id');
      assert.strictEqual((await sp.list(store, other)).tickets.length, 0, 'users only see their own tickets');
      for (let i = 1; i < sp.LIMITS.messages; i++) await sp.message(store, user, a.ticket.id, { text: 'پیام ' + i });
      assert.strictEqual(await code(() => sp.message(store, user, a.ticket.id, { text: 'یکی بیشتر' })), 'too_many_messages');
      const c = await sp.close(store, user, a.ticket.id);
      assert.strictEqual(c.ticket.status, 'closed');
      const long = await sp.create(store, user, { subject: 'x'.repeat(300), text: 'y'.repeat(5000) });
      assert.strictEqual(long.ticket.subject.length, sp.LIMITS.subject[1]);
      assert.strictEqual(long.ticket.messages[0].text.length, sp.LIMITS.text[1]);
      store.close();
    });

    await check('SP-06 سرور واقعی (HTTP): پشتیبانی پیش از دروازهٔ اشتراک؛ 401 بدون نشست؛ 400 برای ورودی نادرست', async () => {
      /* مالک: مدیر «اشتراکی» بدون اشتراک ⇒ 402 برای بقیهٔ امکانات */
      const reg = { v: 1, schools: [{ id: 's-0060', name: 'هنرستان پشتیبانی', level: 'ابتدایی', active: true, manager: { username: 'sup.mgr', name: 'مدیر', phone: '', password_hash: pbkdf2Hash('Sup-Pass-1'), rev: 1 } }], settings: { roles: { manager: 'required' } }, domain: '', grants: [], decisions: {}, rejected: [] };
      await s3mem.put(cfg, cfg.prefix + sr.DIR.registry, JSON.stringify(sr.seal(cfg.secret, sr.K.registry, 2000, JSON.stringify(reg))));
      const port = await freePort();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp152srv-'));
      tmpDirs.push(dir);
      const pre = openStore(path.join(dir, 'payesh.sqlite'));
      s3mem.usingMeta(pre).set(Object.assign({}, cfg));
      pre.close();
      const env = Object.assign({}, process.env, {
        PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
        PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_HEADLESS: '1',
      });
      const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
      try {
        let up = false;
        for (let i = 0; i < 200 && !up; i++) { up = (await req('GET', port, '/api/health')).status === 200; if (!up) await sleep(100); }
        assert.ok(up, 'server up\n' + log);
        assert.strictEqual((await req('GET', port, '/api/support')).status, 401);
        assert.strictEqual((await req('POST', port, '/api/support', { subject: 'بدون نشست', text: 'متن' })).status, 401);
        const lg = await req('POST', port, '/api/auth/login', { phone: 'sup.mgr', password: 'Sup-Pass-1', platform: 'android' });
        assert.strictEqual(lg.status, 200, lg.body + '\n' + log.slice(-800));
        const H = { authorization: 'Bearer ' + lg.json.session.token };
        assert.strictEqual((await req('GET', port, '/api/bootstrap', null, H)).status, 402, 'paywalled');
        const empty = await req('GET', port, '/api/support', null, H);
        assert.strictEqual(empty.status, 200, empty.body); assert.deepStrictEqual(empty.json.tickets, []);
        assert.deepStrictEqual(empty.json.categories, sp.CATEGORIES);
        const bad = await req('POST', port, '/api/support', { subject: 'x', text: 'متن' }, H);
        assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.error, 'bad_subject');
        const cr = await req('POST', port, '/api/support', { category: 'payment', subject: 'پرداخت و اشتراک', text: 'اشتراکم تمام شده، پرداخت کردم ولی فعال نشد.' }, H);
        assert.strictEqual(cr.status, 200, cr.body); assert.strictEqual(cr.json.reported, true);
        const id = cr.json.ticket.id;
        const env1 = await readKind(cfg, sp.DIR.ticket + id + '.json', sp.K.ticket);
        assert.strictEqual(env1.plain.school_id, 's-0060'); assert.strictEqual(env1.plain.role, 'manager');
        const ms = await req('POST', port, '/api/support/message', { id, text: 'کد پیگیری 778899' }, H);
        assert.strictEqual(ms.status, 200); assert.strictEqual(ms.json.ticket.messages.length, 2);
        assert.strictEqual((await req('POST', port, '/api/support/message', { id: 'TKT-00000000', text: 'سلام' }, H)).status, 404);
        const t1 = new Date().toISOString();
        await ownerReply(cfg, id, 1, { v: 1, id, status: 'answered', updated_at: t1, messages: [{ at: t1, from: 'owner', text: 'تأیید شد.' }] });
        const ls = await req('GET', port, '/api/support', null, H);
        assert.strictEqual(ls.json.tickets[0].status, 'answered'); assert.strictEqual(ls.json.tickets[0].messages.at(-1).text, 'تأیید شد.');
        const cl = await req('POST', port, '/api/support/close', { id }, H);
        assert.strictEqual(cl.status, 200); assert.strictEqual(cl.json.ticket.status, 'closed');
      } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.once('exit', r));
      }
    });
  } finally {
    await S.close();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  }

  if (failures.length) { console.log('SUPPORT-152-FAIL failures=' + failures.length); process.exit(1); }
  console.log('SUPPORT-152-OK checks=' + checks);
  process.exit(0);
})().catch((e) => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('SUPPORT-152-FAIL failures=1'); process.exit(1); });
