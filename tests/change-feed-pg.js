'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ردیف ۳۶ — change-feed هر مدرسه در PostgreSQL
   seq صعودی · ایندکس مکان‌نما · retention · RLS · بدون تکرار/جاافتادگی

   اجرا (با PostgreSQL واقعی):
     bash docs/cloud/reports/evidence/run-36-change-feed.sh
   متغیرهای محیط (همان قرارداد CC‑12‑2): PGURL_ADMIN، PGURL_RUNTIME، TENANCY_SECRET، APP_PORT، PAYESH_DATA
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));

const ADMIN_URL = process.env.PGURL_ADMIN || '';
const RUNTIME_URL = process.env.PGURL_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const PORT = Number(process.env.APP_PORT || 0);
const DATA = process.env.PAYESH_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-cf36-'));
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const FEED = '/api/cloud/tenancy/product/feed';

if (!ADMIN_URL || !RUNTIME_URL || !SECRET) {
  console.log('BLOCKED — ENVIRONMENT UNAVAILABLE (PGURL_ADMIN/PGURL_RUNTIME/TENANCY_SECRET لازم است)');
  process.exit(3);
}

let passed = 0, failed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id + ' — ' + ((e && e.message) || e)); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 240)}`); }
}
function tokenFor(tid, role = 'manager') {
  return tenancy.signToken({ tid, role, uid: `u-${tid.slice(0, 4)}`, did: `d-${tid.slice(0, 4)}`, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
}
async function http(p, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch('http://127.0.0.1:' + PORT + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

(async () => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const mig = await tenancy.migrate(admin);

  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_TENANCY_PG: RUNTIME_URL, PAYESH_TENANCY_SECRET: SECRET,
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_AUTO_BACKUP: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health'); const j = await r.json(); if (j && j.ok) break; } catch (e) { /* retry */ }
    await sleep(250);
  }

  const A = tokenFor(TENANT_A);
  const A_READER = tokenFor(TENANT_A, 'teacher');
  const B = tokenFor(TENANT_B);
  const P = '/api/cloud/tenancy/product';

  try {
    await check('CF-01', 'مهاجرت: جدول feed با RLS اجباری، سیاست، دو ایندکس و توالی ساخته شد', async () => {
      const t = await admin.query(`select relrowsecurity as rls, relforcerowsecurity as force
                                     from pg_class where relname = 'product_change_feed'`);
      assert(t.rows.length === 1, 'جدول ساخته نشد');
      assert(t.rows[0].rls === true && t.rows[0].force === true, 'RLS/force فعال نیست');
      const pol = await admin.query(`select polname from pg_policy where polrelid = 'product_change_feed'::regclass`);
      assert(pol.rows.some((r) => /isolation/.test(r.polname)), 'سیاست جداسازی نیست');
      const idx = await admin.query(`select indexname from pg_indexes where tablename = 'product_change_feed'`);
      const names = idx.rows.map((r) => r.indexname);
      assert(names.includes('product_change_feed_cursor_idx'), 'ایندکس مکان‌نما نیست: ' + names.join(','));
      assert(names.includes('product_change_feed_retention_idx'), 'ایندکس retention نیست');
      return `statements=${mig.statements} indexes=${names.length}`;
    });

    await check('CF-02', 'درج از مسیر محصول ⇒ یک ردیف feed با op=put و همان نسخه', async () => {
      const w = await http(P, { method: 'POST', token: A, body: { collection: 'classes', id: 100, data: { name: 'دهم الف', grade: 10 } } });
      assert(w.status === 201, 'درج: ' + JSON.stringify(w.data).slice(0, 160));
      const f = await http(FEED + '?since_seq=0', { token: A });
      assert(f.status === 200 && f.data.ok, 'خواندن feed: ' + JSON.stringify(f.data).slice(0, 160));
      const row = f.data.rows.find((r) => r.collection === 'classes' && r.id === 100);
      assert(row && row.op === 'put', 'ردیف feed نیست');
      assert(row.version === w.data.row.version, 'نسخهٔ feed با داده نمی‌خواند');
      assert(row.data && row.data.name === 'دهم الف', 'دادهٔ درون feed ناقص است');
      return `seq=${row.seq} version=${row.version}`;
    });

    await check('CF-03', '۲۵ نوشتن پشت‌سرهم: seq اکیداً صعودی و بی‌هم‌مهر (نقص W‑04 در سطح DB)', async () => {
      for (let i = 0; i < 25; i++) {
        const r = await http(P, { method: 'POST', token: A, body: { collection: 'announcements', id: 500 + i, data: { title: 'n' + i } } });
        assert(r.status === 201, 'نوشتن ' + i + ' ناموفق');
      }
      const all = [];
      let since = 0, guard = 0;
      for (;;) {
        const f = await http(FEED + `?since_seq=${since}&limit=1000`, { token: A });
        all.push(...f.data.rows);
        if (!f.data.more) break;
        since = f.data.next_seq;
        if (guard++ > 20) throw new Error('حلقهٔ صفحه‌بندی بی‌پایان');
      }
      const seqs = all.map((r) => r.seq);
      for (let i = 1; i < seqs.length; i++) assert(seqs[i] > seqs[i - 1], 'seq صعودی نیست در ' + i);
      assert(new Set(seqs).size === seqs.length, 'seq تکراری دارد');
      return `rows=${seqs.length} unique=${new Set(seqs).size} span=${seqs[0]}..${seqs[seqs.length - 1]}`;
    });

    await check('CF-04', 'حذف ⇒ tombstone با op=del و data=null (کلاینت آفلاین حذف را می‌بیند)', async () => {
      const d = await http(P + '/classes/100', { method: 'DELETE', token: A });
      assert(d.status === 200, 'حذف: ' + JSON.stringify(d.data).slice(0, 160));
      const f = await http(FEED + '?since_seq=0&collection=classes&limit=1000', { token: A });
      const tomb = f.data.rows.filter((r) => r.id === 100 && r.op === 'del');
      assert(tomb.length === 1, 'tombstone ساخته نشد');
      assert(tomb[0].data === null, 'دادهٔ tombstone باید null باشد');
      return `seq=${tomb[0].seq} version=${tomb[0].version}`;
    });

    await check('CF-05', 'صفحه‌بندی با limit=7: هر ردیف دقیقاً یک‌بار (بدون تکرار/جاافتادگی)', async () => {
      const full = await http(FEED + '?since_seq=0&limit=1000', { token: A });
      const expected = full.data.rows.map((r) => r.seq);
      const got = [];
      let since = 0, guard = 0;
      for (;;) {
        const f = await http(FEED + `?since_seq=${since}&limit=7`, { token: A });
        assert(f.status === 200, 'صفحه ناموفق');
        got.push(...f.data.rows.map((r) => r.seq));
        if (!f.data.more) break;
        assert(f.data.next_seq >= since, 'next_seq عقب رفت');
        since = f.data.next_seq;
        if (guard++ > 200) throw new Error('حلقهٔ بی‌پایان');
      }
      assert(JSON.stringify(got) === JSON.stringify(expected), `مجموعهٔ صفحه‌ای با کامل نمی‌خواند (${got.length}≠${expected.length})`);
      return `pages=${guard} rows=${got.length}`;
    });

    await check('CF-06', 'next_seq/more: پایان صفحه‌بندی، next_seq = آخرین seq', async () => {
      const full = await http(FEED + '?since_seq=0&limit=1000', { token: A });
      const last = full.data.rows[full.data.rows.length - 1].seq;
      const tail = await http(FEED + `?since_seq=${last}`, { token: A });
      assert(tail.status === 200 && tail.data.rows.length === 0 && tail.data.more === false, 'بعد از آخرین seq نباید ردیفی بیاید');
      assert(tail.data.next_seq === last, 'next_seq باید همان last بماند');
      return `last=${last}`;
    });

    await check('CF-07', 'RLS: feed مستأجر B هیچ ردیفی از A را نشان نمی‌دهد', async () => {
      await http(P, { method: 'POST', token: B, body: { collection: 'classes', id: 700, data: { name: 'کلاس ب' } } });
      const fa = await http(FEED + '?since_seq=0&limit=1000', { token: A });
      const fb = await http(FEED + '?since_seq=0&limit=1000', { token: B });
      assert(fb.data.rows.every((r) => r.id !== 100 && !(r.collection === 'classes' && r.id === 700 && r.op === 'del')), 'ردیف مشترک دیده شد');
      assert(fb.data.rows.length === 1 && fb.data.rows[0].id === 700, 'feed مستأجر B باید فقط ردیف خودش را داشته باشد');
      assert(fa.data.rows.some((r) => r.id === 100), 'feed مستأجر A کامل نیست');
      return `A=${fa.data.count} B=${fb.data.count}`;
    });

    await check('CF-08', 'fail-closed: نقش runtime بدون زمینهٔ مستأجر ⇒ صفر ردیف (نه همهٔ ردیف‌ها)', async () => {
      const rt = new Client({ connectionString: RUNTIME_URL });
      await rt.connect();
      const q = await rt.query('select count(*)::int as n from product_change_feed');
      await rt.end();
      assert(q.rows[0].n === 0, 'بدون زمینهٔ مستأجر باید صفر باشد، شد: ' + q.rows[0].n);
      return 'rows=0';
    });

    await check('CF-09', 'ایندکس مکان‌نما واقعاً استفاده می‌شود (EXPLAIN)', async () => {
      await admin.query('begin');
      await admin.query('set local role payesh_owner');
      const plan = await admin.query(
        `explain select seq from product_change_feed
          where tenant_id = '${TENANT_A}' and seq > 0 order by seq asc limit 8`
      );
      await admin.query('rollback');
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      assert(/Index Scan|Index Only Scan/.test(text), 'برنامهٔ اجرا ایندکس‌اسکن نیست: ' + text.slice(0, 200));
      assert(/product_change_feed_cursor_idx/.test(text), 'ایندکس مکان‌نما در برنامه نیست');
      return text.split('\n')[0].trim().slice(0, 90);
    });

    await check('CF-10', 'retention: فقط ردیف‌های قدیمی‌تر از پنجره حذف می‌شوند و مستأجر دیگر دست‌نخورده می‌ماند', async () => {
      /* ۳ ردیف قدیمی برای A و ۲ ردیف قدیمی برای B (با اتصال مدیر و زمینهٔ صریح) */
      for (const [tid, ids] of [[TENANT_A, [900, 901, 902]], [TENANT_B, [910, 911]]]) {
        await admin.query('begin');
        await admin.query("select set_config('app.tenant_id', $1, true)", [tid]);
        for (const id of ids) {
          await admin.query(
            `insert into product_change_feed (tenant_id, collection, record_id, op, version, data, at)
             values ($1, 'legacy', $2, 'put', 1, '{}'::jsonb, now() - interval '40 days')`, [tid, id]);
        }
        await admin.query('commit');
      }
      const beforeA = (await http(FEED + '?since_seq=0&limit=1000', { token: A })).data.count;
      const pr = await http(FEED + '/prune', { method: 'POST', token: A, body: { keep_days: 7 } });
      assert(pr.status === 200 && pr.data.ok, 'prune: ' + JSON.stringify(pr.data).slice(0, 160));
      assert(pr.data.deleted === 3, 'باید ۳ ردیف قدیمی A حذف شود، شد: ' + pr.data.deleted);
      const afterA = await http(FEED + '?since_seq=0&limit=1000', { token: A });
      assert(afterA.data.count === beforeA - 3, 'تعداد A باید ۳ کمتر شود');
      assert(!afterA.data.rows.some((r) => r.collection === 'legacy'), 'ردیف قدیمی مانده');
      const b = await http(FEED + '?since_seq=0&limit=1000', { token: B });
      assert(b.data.rows.filter((r) => r.collection === 'legacy').length === 2, 'retention مستأجر A نباید B را پاک کند');
      return `deleted=3 remainingA=${afterA.data.count} legacyB=2`;
    });

    await check('CF-11', 'prune فقط با نقش مدیر: دبیر ⇒ 403 (fail-closed)', async () => {
      const r = await http(FEED + '/prune', { method: 'POST', token: A_READER, body: { keep_days: 1 } });
      assert(r.status === 403 && r.data.error === 'forbidden', 'پاسخ: ' + r.status + ' ' + JSON.stringify(r.data));
      return 'status=403';
    });

    await check('CF-12', 'پنجرهٔ نگه‌داری نامعتبر رد می‌شود (کنترل منفی 0/400)', async () => {
      const z = await http(FEED + '/prune', { method: 'POST', token: A, body: { keep_days: 0 } });
      const big = await http(FEED + '/prune', { method: 'POST', token: A, body: { keep_days: 4000 } });
      assert(z.status === 400 && z.data.error === 'bad_keep_days', 'keep_days=0 باید ۴۰۰ بدهد');
      assert(big.status === 400 && big.data.error === 'bad_keep_days', 'keep_days=4000 باید ۴۰۰ بدهد');
      return 'both=400';
    });

    await check('CF-13', 'OCC کهنه ⇒ 409 و هیچ ردیف feed تازه‌ای (داده و feed همیشه هم‌گام)', async () => {
      const w = await http(P, { method: 'POST', token: A, body: { collection: 'subjects', id: 300, data: { name: 'ریاضی' } } });
      const n1 = (await http(FEED + '?since_seq=0&limit=1000', { token: A })).data.count;
      const c = await http(P, { method: 'POST', token: A, body: { collection: 'subjects', id: 300, data: { name: 'ریاضی۲' }, base_version: w.data.row.version + 5 } });
      assert(c.status === 409, 'باید ۴۰۹ باشد');
      const n2 = (await http(FEED + '?since_seq=0&limit=1000', { token: A })).data.count;
      assert(n1 === n2, 'تعارض نباید feed بسازد: ' + n1 + '→' + n2);
      return `feed=${n2}`;
    });

    await check('CF-14', '۳۰۰ نوشتن: همه seq یکتا و صعودی + نرخ واقعی نوشتن feed', async () => {
      const t0 = Date.now();
      const seqs = [];
      for (let i = 0; i < 300; i++) {
        const r = await http(P, { method: 'POST', token: A, body: { collection: 'grades', id: 1000 + i, data: { score: i % 20 } } });
        assert(r.status === 201, 'نوشتن ' + i + ' ناموفق');
      }
      const ms = Date.now() - t0;
      let since = 0, guard = 0;
      for (;;) {
        const f = await http(FEED + `?since_seq=${since}&limit=1000`, { token: A });
        seqs.push(...f.data.rows.map((r) => r.seq));
        if (!f.data.more) break;
        since = f.data.next_seq;
        if (guard++ > 50) throw new Error('حلقهٔ بی‌پایان');
      }
      for (let i = 1; i < seqs.length; i++) assert(seqs[i] > seqs[i - 1], 'seq صعودی نیست');
      assert(new Set(seqs).size === seqs.length, 'seq تکراری دارد');
      const rate = Math.round((300 / ms) * 1000);
      return `writes=300 feed_rows=${seqs.length} ${ms}ms ≈${rate} write/s`;
    });

    await check('CF-15', 'فشرده‌سازی: ردیف‌های قدیمی gzip می‌شوند، حجم کم می‌شود و مقدار داده دست‌نخورده می‌ماند', async () => {
      /* یک ردیف قدیمی با payload حجیم برای A می‌سازیم */
      const big = { note: 'متن تکراری برای فشرده‌سازی '.repeat(40), scores: Array.from({ length: 40 }, (_, i) => i) };
      await admin.query('begin');
      await admin.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
      await admin.query(
        `insert into product_change_feed (tenant_id, collection, record_id, op, version, data, at)
         values ($1, 'grades', 4242, 'put', 1, $2::jsonb, now() - interval '20 days')`, [TENANT_A, JSON.stringify(big)]);
      await admin.query('commit');
      const beforeRow = (await http(FEED + '?since_seq=0&limit=1000', { token: A })).data.rows.find((r) => r.id === 4242 && r.collection === 'grades');
      assert(beforeRow && beforeRow.data && beforeRow.data.scores.length === 40, 'ردیف قدیمی خوانده نشد');

      const c1 = await http(FEED + '/compress', { method: 'POST', token: A, body: { hot_days: 7 } });
      assert(c1.status === 200 && c1.data.ok, 'compress: ' + JSON.stringify(c1.data).slice(0, 200));
      assert(c1.data.compressed >= 1, 'هیچ ردیفی فشرده نشد');
      assert(c1.data.ratio !== null && c1.data.ratio < 0.6, 'نسبت فشرده‌سازی ضعیف: ' + c1.data.ratio);
      assert(c1.data.saved_bytes > 0, 'بایتی ذخیره نشد');

      const afterRow = (await http(FEED + '?since_seq=0&limit=1000', { token: A })).data.rows.find((r) => r.id === 4242 && r.collection === 'grades');
      assert(JSON.stringify(afterRow.data) === JSON.stringify(beforeRow.data), 'پس از فشرده‌سازی مقدار داده تغییر کرد');
      const phys = await admin.query(`select data is null as json_null, data_gz is not null as has_gz from product_change_feed where record_id = 4242 and collection = 'grades'`);
      assert(phys.rows[0].json_null === true && phys.rows[0].has_gz === true, 'ردیف واقعاً فشرده نشده');

      const c2 = await http(FEED + '/compress', { method: 'POST', token: A, body: { hot_days: 7 } });
      assert(c2.status === 200 && c2.data.compressed === 0, 'فشرده‌سازی باید idempotent باشد');
      return `compressed=${c1.data.compressed} ratio=${c1.data.ratio} saved=${c1.data.saved_bytes}B idempotent=yes`;
    });

    await check('CF-16', 'فشرده‌سازی فقط با مدیر و پنجرهٔ معتبر (403 / 400)', async () => {
      const t = await http(FEED + '/compress', { method: 'POST', token: A_READER, body: { hot_days: 7 } });
      assert(t.status === 403 && t.data.error === 'forbidden', 'دبیر باید ۴۰۳ بگیرد');
      const z = await http(FEED + '/compress', { method: 'POST', token: A, body: { hot_days: 0 } });
      const b = await http(FEED + '/compress', { method: 'POST', token: A, body: { hot_days: 999 } });
      assert(z.status === 400 && z.data.error === 'bad_hot_days', 'hot_days=0 باید ۴۰۰ بدهد');
      assert(b.status === 400 && b.data.error === 'bad_hot_days', 'hot_days=999 باید ۴۰۰ بدهد');
      return 'teacher=403 hot0=400 hot999=400';
    });

    await check('CF-15b', 'آمار feed (بدون افشای داده) و مسیر stats سالم است', async () => {
      const s = await http(FEED + '/stats', { token: A });
      assert(s.status === 200 && s.data.ok, 'stats: ' + JSON.stringify(s.data).slice(0, 160));
      assert(s.data.feed.count > 0 && s.data.feed.max_seq > 0, 'آمار ناقص');
      assert(!('rows' in s.data.feed) && !('data' in s.data.feed), 'stats نباید داده ردیف‌ها را بدهد');
      return `count=${s.data.feed.count} max_seq=${s.data.feed.max_seq}`;
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
    try { await admin.end(); } catch (e) { /* noop */ }
    try { await tenancy.close(); } catch (e) { /* noop */ }
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log('\n' + passed + ' موفق · ' + failed + ' ناموفق');
  if (failed) { console.log('شکست‌ها:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error('CHANGE-FEED-ERROR', e); process.exit(2); });
