'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۸۷ — رمزنگاری فیلدیِ دادهٔ حساس (AEAD، کلید از محیط)

   FC-01..05  واحد: keyring، رفت‌وبرگشت، AAD، دستکاری، جعل
   FC-06..10  SQLite (Store): متن ساده بیرون، مهرشده درون؛ dump فایل بدون
              متن ساده؛ حسابرسی؛ مهاجرت؛ چرخش کلید؛ fail-closed؛ required
   FC-11..12  سرتاسری HTTP: ورود با کد ملی کار می‌کند، فایل پایگاه داده خام
              (و WAL) هیچ کد ملی/متن یادداشتی ندارد
   FC-13      هیچ کلید واقعی در مخزن نیست
   FC-PG-1..5 PostgreSQL (اگر PAYESH_PG_ADMIN/RUNTIME باشد؛ FC87_REQUIRE_PG=1 ⇒ اجباری):
              jsonb و change-feed مهرشده، API متن ساده، چرخش، join روی فیلد مهرشده رد

   کلیدها در زمان اجرا تصادفی ساخته می‌شوند — هیچ کلیدی در مخزن نیست.
   اجرا: node --experimental-sqlite --disable-warning=ExperimentalWarning tests/field-crypto-87.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const fc = require(path.join(ROOT, 'server/field-crypto.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-fc87-'));

const newKey = () => crypto.randomBytes(32).toString('base64');
const K1 = newKey();
const K2 = newKey();
const NID = '0499370899';            /* کد ملی معتبرِ آزمون */
const FNID = '0067749828';
const NOTE = 'FC87-NOTE-secret-counsel-' + crypto.randomBytes(6).toString('hex');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}${d === undefined ? '' : '  → ' + d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`); }
}
function throwsCode(fn, code) {
  try { fn(); } catch (e) { assert(e.code === code, `expected ${code}, got ${e.code || e.message}`); return e.code; }
  throw new Error(`expected ${code}, nothing thrown`);
}
function setKeys(spec) {
  if (spec == null) delete process.env.PAYESH_FIELD_KEYS; else process.env.PAYESH_FIELD_KEYS = spec;
  fc.reload();
}
/* «dump»ِ فایلی: همهٔ بایت‌های فایل پایگاه داده + WAL + SHM */
function fileDump(dbFile) {
  return [dbFile, dbFile + '-wal', dbFile + '-shm'].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f).toString('latin1')).join('\n');
}
function sqlDump(store) {
  const rows = [];
  for (const t of ['records', 'audit', 'meta', 'sync_log']) {
    try { for (const r of store.db.prepare(`SELECT * FROM ${t}`).all()) rows.push(JSON.stringify(r)); } catch (e) { /* */ }
  }
  return rows.join('\n');
}

(async () => {
  console.log(`# row 87 field crypto — node ${process.version}`);

  /* ───────────── واحد ───────────── */
  await check('FC-01', 'keyring: kid:base64(32B); first = active; bad/short/duplicate keys are rejected', () => {
    const kr = fc.parseKeyring(`k2:${K2},k1:${K1}`);
    assert(kr.active === 'k2' && kr.keys.size === 2, 'active/size');
    throwsCode(() => fc.parseKeyring('k1:' + Buffer.alloc(16).toString('base64')), 'bad_field_keys');
    throwsCode(() => fc.parseKeyring(`k1:${K1},k1:${K2}`), 'bad_field_keys');
    throwsCode(() => fc.parseKeyring(K1), 'bad_field_keys');
    throwsCode(() => fc.parseKeyring('bad kid!:' + K1), 'bad_field_keys');
    assert(fc.parseKeyring('').active === null, 'empty ⇒ disabled');
    return 'ok';
  });

  await check('FC-02', 'seal/open round-trip keeps type; random IV ⇒ two seals differ; no plaintext in ciphertext', () => {
    const kr = fc.parseKeyring(`k1:${K1}`);
    const a = fc.sealValue('users', 7, 'national_id', NID, kr);
    const b = fc.sealValue('users', 7, 'national_id', NID, kr);
    assert(a.startsWith('enc:f1:k1:') && a !== b, 'prefix / random iv');
    assert(!a.includes(NID), 'plaintext leaked');
    assert(fc.openValue('users', 7, 'national_id', a, kr) === NID, 'round trip');
    const o = { t: NOTE, n: 3, tags: ['x'] };
    assert(JSON.stringify(fc.openValue('counselor_notes', 1, 'body', fc.sealValue('counselor_notes', 1, 'body', o, kr), kr)) === JSON.stringify(o), 'object');
    return a.slice(0, 24) + '…';
  });

  await check('FC-03', 'AAD binds collection|id|field|kid: moving a sealed value to another row/field/collection fails', () => {
    const kr = fc.parseKeyring(`k1:${K1}`);
    const a = fc.sealValue('users', 7, 'national_id', NID, kr);
    throwsCode(() => fc.openValue('users', 8, 'national_id', a, kr), 'field_auth_failed');
    throwsCode(() => fc.openValue('users', 7, 'father_nid', a, kr), 'field_auth_failed');
    throwsCode(() => fc.openValue('counselor_notes', 7, 'national_id', a, kr), 'field_auth_failed');
    return '3/3 refused';
  });

  await check('FC-04', 'tampering (one flipped ciphertext byte / truncated tag) ⇒ field_auth_failed / field_corrupt', () => {
    const kr = fc.parseKeyring(`k1:${K1}`);
    const a = fc.sealValue('users', 7, 'national_id', NID, kr);
    const parts = a.split(':');
    const ct = Buffer.from(parts[4].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    ct[0] ^= 1;
    parts[4] = ct.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    throwsCode(() => fc.openValue('users', 7, 'national_id', parts.join(':'), kr), 'field_auth_failed');
    throwsCode(() => fc.openValue('users', 7, 'national_id', 'enc:f1:k1:AAAA:BB', kr), 'field_corrupt');
    return 'ok';
  });

  await check('FC-05', 'spoof: a client-sent "enc:f1:…" string in a non-sensitive field is dropped (cannot break reads)', () => {
    const kr = fc.parseKeyring(`k1:${K1}`);
    const s = fc.sealRecord('users', 9, { name: 'enc:f1:k1:AAAA:BBBB', national_id: NID }, kr);
    assert(s.name === '', 'spoofed value kept');
    assert(fc.isSealed(s.national_id), 'nid not sealed');
    assert(fc.openRecord('users', 9, s, kr).national_id === NID, 'open');
    return 'ok';
  });

  /* ───────────── SQLite Store ───────────── */
  const { openStore } = require(path.join(ROOT, 'server/db.js'));
  const auth = require(path.join(ROOT, 'server/auth.js'));
  const dbFile = path.join(TMP, 'unit.sqlite');

  setKeys(`k1:${K1}`);
  let store = openStore(dbFile);
  let uid, nid2, noteId;
  await check('FC-06', 'Store with key: get/all/byRef/changedSince return plaintext; records.data holds only ciphertext', () => {
    const u = store.insert('users', { name: 'دانش‌آموز آزمون', role: 'student', phone: '09121234567', national_id: NID, father_nid: FNID, class_id: 4 });
    uid = u.id;
    const n = store.insert('counselor_notes', { student_id: uid, counselor_id: 1, body: NOTE, title: 'جلسه', created_at: '2026-11-10' });
    noteId = n.id;
    store.update('users', uid, { name: 'دانش‌آموز ویرایش‌شده' });
    assert(store.get('users', uid).national_id === NID && store.get('users', uid).father_nid === FNID, 'get');
    assert(store.all('users').find(x => x.id === uid).national_id === NID, 'all');
    assert(store.byRef('users', 'ref1', 4)[0].national_id === NID, 'byRef (index column from plaintext)');
    assert(store.get('counselor_notes', noteId).body === NOTE && store.get('counselor_notes', noteId).student_id === uid, 'note');
    const ch = store.changedSince('users', '1970-01-01T00:00:00.000Z', 100);
    assert(JSON.parse(ch.find(r => r.id === uid).data).national_id === NID, 'changedSince (sync path)');
    const raw = JSON.parse(store.getRow('users', uid).data);
    assert(fc.isSealed(raw.national_id) && fc.isSealed(raw.father_nid), 'raw not sealed');
    assert(raw.phone === '09121234567' && raw.class_id === 4, 'non-sensitive fields stay plain');
    const rawN = JSON.parse(store.getRow('counselor_notes', noteId).data);
    assert(fc.isSealed(rawN.body) && fc.isSealed(rawN.title) && rawN.student_id === uid && rawN.counselor_id === 1, 'note raw');
    assert(auth.findUserByLogin(store, NID).id === uid, 'login lookup by national id still works');
    return `users.national_id=${raw.national_id.slice(0, 18)}…`;
  });

  await check('FC-07', 'NEGATIVE — DB dump (SQL rows of records/audit/meta + raw file/WAL bytes) has no plaintext national id or note', () => {
    store.audit({ user_id: 1, role: 'manager', collection: 'users', record_id: uid, action: 'update', before: { national_id: NID }, after: { national_id: NID, father_nid: FNID } });
    store.audit({ user_id: 1, role: 'counselor', collection: 'counselor_notes', record_id: noteId, action: 'create', after: { body: NOTE, student_id: uid } });
    const sql = sqlDump(store);
    const file = fileDump(dbFile);
    for (const needle of [NID, FNID, NOTE]) {
      assert(!sql.includes(needle), 'SQL dump leaks ' + needle);
      assert(!file.includes(needle), 'file bytes leak ' + needle);
    }
    assert(sql.includes('enc:f1:k1:'), 'ciphertext present');
    return `sql_bytes=${sql.length} file_bytes=${file.length} needles=3 found=0`;
  });

  await check('FC-08', 'rotation: k2 first + k1 behind ⇒ reads OK; rekey re-seals records+audit under k2 without bumping version; then k1 can be removed', () => {
    const v0 = store.versionOf('users', uid);
    store.close && store.close();
    setKeys(`k2:${K2},k1:${K1}`);
    store = openStore(dbFile);                         /* باز کردن ⇒ مهاجرت خودکار */
    assert(store.get('users', uid).national_id === NID, 'read after rotation');
    const again = store.rekeyFields();
    assert(again.records === 0 && again.audit === 0, 'second rekey must be a no-op: ' + JSON.stringify(again));
    const dump = sqlDump(store);
    assert(!dump.includes('enc:f1:k1:'), 'k1 ciphertext left after rekey');
    assert(dump.includes('enc:f1:k2:'), 'k2 ciphertext');
    assert(store.versionOf('users', uid) === v0, 'version bumped by rekey');
    store.close && store.close();
    setKeys(`k2:${K2}`);
    store = openStore(dbFile);
    assert(store.get('users', uid).national_id === NID && store.get('counselor_notes', noteId).body === NOTE, 'k1 removed, still readable');
    const a = store.db.prepare("SELECT before, after FROM audit WHERE collection='users' AND record_id=?").get(uid);
    assert(fc.openRecord('users', uid, JSON.parse(a.after)).father_nid === FNID, 'audit re-sealed & openable');
    return `version=${v0} kid=k2`;
  });

  await check('FC-09', 'fail-closed: a row still sealed under a key that is no longer configured ⇒ field_key_unavailable (never ciphertext or plaintext out)', () => {
    const f2 = path.join(TMP, 'stale.sqlite');
    setKeys(`k1:${K1}`);
    let s = openStore(f2);
    const id = s.insert('users', { name: 'x', role: 'student', national_id: NID }).id;
    s.close && s.close();
    setKeys(null);                                    /* بدون کلید */
    s = openStore(f2);
    throwsCode(() => s.get('users', id), 'field_key_unavailable');
    s.close && s.close();
    setKeys(`k2:${K2}`);                               /* کلید نادرست ⇒ مهاجرت خودکار هم fail-closed */
    throwsCode(() => openStore(f2), 'field_key_unavailable');
    setKeys(`k2:${K2}`);
    return 'no key ⇒ refused; wrong key ⇒ refused';
  });

  await check('FC-10', 'migration: a legacy plaintext DB is sealed on first open with a key; PAYESH_FIELD_CRYPTO=required without key refuses to start', () => {
    const f3 = path.join(TMP, 'legacy.sqlite');
    setKeys(null);
    let s = openStore(f3);
    const id = s.insert('users', { name: 'قدیمی', role: 'parent', national_id: NID }).id;
    s.insert('counselor_notes', { student_id: id, body: NOTE });
    assert(sqlDump(s).includes(NID), 'precondition: legacy is plaintext');
    s.close && s.close();
    setKeys(`k2:${K2}`);
    s = openStore(f3);
    assert(s.get('users', id).national_id === NID, 'readable');
    const d = sqlDump(s);
    assert(!d.includes(NID) && !d.includes(NOTE), 'migrated rows still plaintext');
    s.db.exec('VACUUM');
    s.close && s.close();
    const fb = fileDump(f3);
    assert(!fb.includes(NID) && !fb.includes(NOTE), 'file bytes after VACUUM still leak');
    process.env.PAYESH_FIELD_CRYPTO = 'required';
    setKeys(null);
    throwsCode(() => openStore(path.join(TMP, 'req.sqlite')), 'field_keys_required');
    delete process.env.PAYESH_FIELD_CRYPTO;
    setKeys(`k2:${K2}`);
    return 'ok';
  });
  try { store.close && store.close(); } catch (e) { /* */ }

  /* ───────────── سرتاسری HTTP ───────────── */
  const data = path.join(TMP, 'srv');
  const port = await new Promise((res) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: data, PAYESH_LOG: '0', PAYESH_FIELD_KEYS: `k2:${K2}`, PAYESH_FIELD_CRYPTO: 'required' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serr = '';
  child.stderr.on('data', (b) => { serr += b; });
  const base = 'http://127.0.0.1:' + port;
  const req = async (p, opts = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const r = await fetch(base + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/setup/state'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

  await check('FC-11', 'HTTP: setup → create student with national id → login with national id as username/password → sync pull returns it', async () => {
    const s = await req('/api/setup', { method: 'POST', body: { school_name: 'آزمون ۸۷', manager_name: 'مدیر', password: 'Modir-87-ok', phone: '09120000087' } });
    assert(s.data && s.data.ok, 'setup ' + JSON.stringify(s.data) + serr.slice(0, 300));
    const tok = s.data.session.token;
    const made = await req('/api/sync', { method: 'POST', token: tok, body: { ops: [
      { uid: 'fc87-1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز ۸۷', role: 'student', national_id: NID, father_nid: FNID } },
      { uid: 'fc87-2', collection: 'counselor_notes', type: 'put', data: { student_id: 1, body: NOTE } },
    ] } });
    assert(made.data && made.data.applied && made.data.applied.length >= 1, 'sync ' + JSON.stringify(made.data));
    const lg = await req('/api/auth/login', { method: 'POST', body: { phone: NID, password: NID } });
    assert(lg.data && lg.data.ok && lg.data.user.national_id === NID, 'login by national id: ' + JSON.stringify(lg.data));
    const pull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: tok });
    const got = JSON.stringify(pull.data || {});
    assert(got.includes(NID) && !got.includes('enc:f1:'), 'pull must be plaintext for the manager, never ciphertext: ' + got.slice(0, 200));
    return `applied=${made.data.applied.length} login=ok`;
  });

  await check('FC-12', 'NEGATIVE — after the HTTP flow the live server DB file (+WAL) contains no plaintext national id / father nid', async () => {
    const f = path.join(data, 'payesh.sqlite');
    assert(fs.existsSync(f), 'db file');
    const bytes = fileDump(f);
    for (const needle of [NID, FNID]) assert(!bytes.includes(needle), 'file leaks ' + needle);
    assert(bytes.includes('enc:f1:k2:'), 'ciphertext present');
    return `bytes=${bytes.length} found=0`;
  });
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));

  await check('FC-13', 'no field key committed: tracked files contain no PAYESH_FIELD_KEYS=<kid>:<32-byte base64>', () => {
    let files = [];
    try { files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch (e) { return 'SKIP (no git)'; }
    const re = /PAYESH_FIELD_KEYS\s*[=:]\s*["']?[A-Za-z0-9_-]{1,32}:[A-Za-z0-9+/]{43}=/;
    const hits = [];
    for (const f of files) {
      let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
      if (re.test(t)) hits.push(f);
    }
    assert(!hits.length, 'key material in ' + hits.join(','));
    return `files=${files.length} hits=0`;
  });

  await check('FC-14', 'rotation tool: tools/field-rekey-87.mjs re-seals a k1 DB under k2 (remaining_old_kid=0); --new-key prints a fresh 32-byte key', () => {
    const f4 = path.join(TMP, 'tool.sqlite');
    setKeys(`k1:${K1}`);
    const s = openStore(f4);
    s.insert('users', { name: 't', role: 'student', national_id: NID });
    s.close();
    const tool = path.join(ROOT, 'tools/field-rekey-87.mjs');
    const flags = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];
    const out = execFileSync(process.execPath, [...flags, tool, '--sqlite', f4], { encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_FIELD_KEYS: `k2:${K2},k1:${K1}` }) });
    assert(/remaining_old_kid=0/.test(out) && /FIELD-REKEY-87-OK/.test(out), out);
    assert(!out.includes(K1) && !out.includes(K2) && !out.includes(NID), 'tool printed secrets');
    const nk = execFileSync(process.execPath, [tool, '--new-key'], { encoding: 'utf8' }).trim();
    assert(Buffer.from(nk, 'base64').length === 32, 'new key size');
    setKeys(`k2:${K2}`);
    const s2 = openStore(f4);
    const raw = s2.db.prepare("SELECT data FROM records WHERE collection='users'").get().data;
    s2.close();
    assert(raw.includes('enc:f1:k2:') && !raw.includes('enc:f1:k1:'), 'not rotated');
    return out.trim().split('\n')[0];
  });

  /* ───────────── PostgreSQL ───────────── */
  const ADMIN = process.env.PAYESH_PG_ADMIN || '';
  const RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
  if (!ADMIN || !RUNTIME) {
    if (process.env.FC87_REQUIRE_PG === '1') { failed++; failures.push('FC-PG'); console.log('FAIL  FC-PG  PAYESH_PG_ADMIN/RUNTIME required (FC87_REQUIRE_PG=1)'); }
    else console.log('SKIP  FC-PG  PAYESH_PG_ADMIN/RUNTIME not set');
  } else {
    const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
    const { Client } = require('pg');
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await tenancy.migrate(admin);
    const pool = tenancy.createPool({ connectionString: RUNTIME });
    const T = crypto.randomUUID();
    const RID = 870000 + Math.floor(Math.random() * 9999);
    setKeys(`k1:${K1}`);
    const pgDump = async () => {
      const a = await admin.query('select data::text as t from product_records where tenant_id = $1', [T]);
      const b = await admin.query('select coalesce(data::text, \'\') as t, data_gz from product_change_feed where tenant_id = $1', [T]);
      return a.rows.map(r => r.t).concat(b.rows.map(r => r.t + (r.data_gz ? require('node:zlib').gunzipSync(r.data_gz).toString('utf8') : ''))).join('\n');
    };
    await check('FC-PG-1', 'Gateway path: upsertProduct ⇒ product_records.data + change feed hold ciphertext; getProduct/listProduct/listFeed return plaintext', async () => {
      await tenancy.upsertProduct(pool, T, { collection: 'users', id: RID, data: { name: 'pg', role: 'student', national_id: NID, father_nid: FNID } });
      await tenancy.upsertProduct(pool, T, { collection: 'counselor_notes', id: RID, data: { student_id: RID, body: NOTE } });
      const g = await tenancy.getProduct(pool, T, { collection: 'users', id: RID });
      assert(g.data.national_id === NID && g.data.father_nid === FNID, 'getProduct');
      const l = await tenancy.listProduct(pool, T, { collection: 'counselor_notes' });
      assert(l[0].data.body === NOTE && l[0].data.student_id === RID, 'listProduct');
      const f = await tenancy.listFeed(pool, T, { limit: 50 });
      const ff = JSON.stringify(f);
      assert(ff.includes(NID) && ff.includes(NOTE) && !ff.includes('enc:f1:'), 'listFeed plaintext');
      return 'ok';
    });
    await check('FC-PG-2', 'NEGATIVE — PostgreSQL dump of the tenant (product_records + change feed, as superuser, RLS bypassed) has no plaintext', async () => {
      const d = await pgDump();
      for (const needle of [NID, FNID, NOTE]) assert(!d.includes(needle), 'pg dump leaks ' + needle);
      assert(d.includes('enc:f1:k1:'), 'ciphertext');
      let pgd = 'pg_dump: n/a';
      try {
        const out = execFileSync('pg_dump', ['--data-only', '--table=product_records', '--table=product_change_feed', ADMIN], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 });
        for (const needle of [NID, FNID, NOTE]) assert(!out.includes(needle), 'pg_dump leaks ' + needle);
        pgd = `pg_dump bytes=${out.length} found=0`;
      } catch (e) { if (/leaks/.test(e.message)) throw e; }
      return `rows_bytes=${d.length} found=0; ${pgd}`;
    });
    await check('FC-PG-3', 'rotation on PostgreSQL: rekeyFields re-seals records + feed under k2 (k1 behind); then k1 removed and data still reads', async () => {
      setKeys(`k2:${K2},k1:${K1}`);
      const r = await tenancy.rekeyFields(pool, T);
      assert(r.records >= 2 && r.feed >= 2, 'rekey counts ' + JSON.stringify(r));
      const d = await pgDump();
      assert(!d.includes('enc:f1:k1:') && d.includes('enc:f1:k2:'), 'k1 left');
      setKeys(`k2:${K2}`);
      const g = await tenancy.getProduct(pool, T, { collection: 'users', id: RID });
      assert(g.data.national_id === NID, 'read after k1 removed');
      const again = await tenancy.rekeyFields(pool, T);
      assert(again.records === 0 && again.feed === 0, 'second rekey no-op');
      return JSON.stringify(r);
    });
    await check('FC-PG-4', 'fail-closed on PostgreSQL: without the key, reading a sealed row throws field_key_unavailable', async () => {
      setKeys(null);
      let code = null;
      try { await tenancy.getProduct(pool, T, { collection: 'users', id: RID }); } catch (e) { code = e.code; }
      setKeys(`k2:${K2}`);
      assert(code === 'field_key_unavailable', 'got ' + code);
      return code;
    });
    await check('FC-PG-5', 'joinProduct on a sealed field (national_id) is refused: sealed_join_key', async () => {
      let code = null;
      try { await tenancy.joinProduct(pool, T, { left: 'users', right: 'users', on: 'national_id' }); } catch (e) { code = e.code; }
      assert(code === 'sealed_join_key', 'got ' + code);
      return code;
    });
    try { await admin.query('delete from product_change_feed where tenant_id = $1', [T]); await admin.query('delete from product_records where tenant_id = $1', [T]); } catch (e) { /* */ }
    await pool.end().catch(() => {});
    await admin.end().catch(() => {});
  }

  /* ───────────── کنترل جهش: آزمون باید خرابی واقعی را بگیرد ─────────────
     هر جهش یک کپیِ server/ با یک تغییر کوچک می‌سازد و همین فایل را روی آن
     اجرا می‌کند؛ اگر آزمون باز هم سبز شود یعنی آزمون کور است ⇒ شکست. */
  if (process.env.FC87_NO_MUTANTS !== '1') {
    const MUTANTS = [
      ['MUT-1 sealRecord never seals', 'server/field-crypto.js', "  const sens = new Set(enabled(kr) ? sealedFieldsOf(collection, out) : []);", "  const sens = new Set(); void 0; /* mutant */"],
      ['MUT-2 AAD ignores record id', 'server/field-crypto.js', "return Buffer.from(`payesh/f1|${collection}|${Number(id)}|${field}|${kid}`, 'utf8');", "return Buffer.from(`payesh/f1|${collection}|0|${field}|${kid}`, 'utf8'); void 0; /* mutant */"],
      ['MUT-3 audit not sealed', 'server/db.js', "entry = Object.assign({}, entry, { before: seal(clean(entry.before)), after: seal(clean(entry.after)) });", "entry = Object.assign({}, entry, { before: clean(entry.before), after: clean(entry.after) }); void seal; /* mutant */"],
      ['MUT-4 rekey skips audit', 'server/db.js', "if (changed) { upA.run(b, f, a.id); out.audit++; }", "void upA; void b; void f; /* mutant */"],
      ['MUT-5 unknown kid falls back to active key', 'server/field-crypto.js', "  const key = kr.keys.get(kid);\n  if (!key)", "  const key = kr.keys.get(kid) || kr.keys.get(kr.active);\n  if (!key)"],
      ['MUT-6 PG feed stored unsealed', 'server/tenancy.js', "data == null ? null : JSON.stringify(fc.sealRecord(collection, recordId, data))]", "data == null ? null : JSON.stringify(data)] /* mutant */"],
    ].filter(m => !/ PG /.test(m[0]) || (ADMIN && RUNTIME));   /* جهش PG فقط وقتی PG هست */
    let killed = 0;
    for (const [name, rel, from, to] of [['MUT-0 baseline (no change) must stay green', 'server/field-crypto.js', "const PREFIX = 'enc:f1:';", "const PREFIX = 'enc:f1:';"], ...MUTANTS]) {
      const mroot = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-fc87m-'));
      for (const e of fs.readdirSync(ROOT)) {
        if (e === 'server' || e === 'tests' || e === 'tools' || e === '.git') continue;
        fs.symlinkSync(path.join(ROOT, e), path.join(mroot, e));
      }
      /* tools/ را واقعی می‌سازیم تا ابزار چرخش، server/ِ جهش‌یافته را ببیند (نه مخزن اصلی) */
      fs.mkdirSync(path.join(mroot, 'tools'));
      for (const f of fs.readdirSync(path.join(ROOT, 'tools'))) {
        if (f === 'field-rekey-87.mjs') fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(mroot, 'tools', f));
        else fs.symlinkSync(path.join(ROOT, 'tools', f), path.join(mroot, 'tools', f));
      }
      fs.mkdirSync(path.join(mroot, 'server'));
      for (const f of fs.readdirSync(path.join(ROOT, 'server'))) {
        const src = path.join(ROOT, 'server', f);
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(mroot, 'server', f));
        else fs.symlinkSync(src, path.join(mroot, 'server', f));
      }
      fs.mkdirSync(path.join(mroot, 'tests'));
      fs.copyFileSync(__filename, path.join(mroot, 'tests', path.basename(__filename)));
      const target = path.join(mroot, rel);
      const txt = fs.readFileSync(target, 'utf8');
      if (txt.split(from).length !== 2) { failed++; failures.push(name); console.log(`FAIL  ${name}  anchor not found exactly once`); continue; }
      fs.writeFileSync(target, txt.replace(from, to));
      let red = false;
      try {
        execFileSync(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', path.join(mroot, 'tests', path.basename(__filename))],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { FC87_NO_MUTANTS: '1' }), timeout: 120000 });
      } catch (e) { red = true; }
      try { fs.rmSync(mroot, { recursive: true, force: true }); } catch (e) { /* */ }
      if (name.startsWith('MUT-0')) {
        if (red) { failed++; failures.push(name); console.log(`FAIL  ${name}  baseline copy is red — mutant results would be meaningless`); }
        else console.log(`PASS  ${name}  green`);
        continue;
      }
      if (red) { killed++; console.log(`PASS  ${name}  killed`); }
      else { failed++; failures.push(name); console.log(`FAIL  ${name}  SURVIVED — tests are blind to this bug`); }
    }
    console.log(`mutants_killed=${killed}/${MUTANTS.length}`);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* */ }
  console.log(`\n# passed=${passed} failed=${failed}`);
  if (failed) { console.log('FIELD-CRYPTO-87-FAILED ' + failures.join(',')); process.exit(1); }
  console.log('FIELD-CRYPTO-87-OK');
})().catch((e) => { console.log('FIELD-CRYPTO-87-FAILED crash ' + ((e && e.stack) || e)); process.exit(1); });
