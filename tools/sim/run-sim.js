#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 173 — the driver of the Docker simulation (tools/sim/docker-compose.sim.yml).

   It plays the two things that are not servers:
     • the OWNER PANEL — every write is the Node twin of the Dart owner code
       (apps/payesh/owner/lib/src/schools/school_registry.dart, local/cloud_control.dart,
       local/connect_bundle.dart): the same envelopes (server/school-registry.js seal,
       server/connect.js sealText, server/cloud-control.js sealText — byte-equal to Dart by
       the shared vectors in docs/cloud/contracts/), the same object keys, the same
       pbkdf2$150000$<salt>$<hash> manager hash, rev = max(now, rev + 1);
     • the APPS — the same HTTP calls and the same server choice as the school app
       (packages/payesh_sync lan_access.dart + app session_controller.dart _loginElsewhere:
       local server first, then the server named by «school_hosted_elsewhere», then the
       address-only list of the central server).
   Everything else is the real thing: the repository Docker image with production timings,
   a SigV4-checking bucket behind HTTPS, the central behind an HTTPS reverse proxy.

   Every step is timed. Output: $SIM_OUT/sim-result.json and $SIM_OUT/SIM-REPORT.md;
   exit 0 only when every step passed. No secret is printed (passwords are simulation-only).
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const s3 = require(path.join(ROOT, 'server', 's3mem.js'));
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const connect = require(path.join(ROOT, 'server', 'connect.js'));
const control = require(path.join(ROOT, 'server', 'cloud-control.js'));

const E = process.env;
const OUT = E.SIM_OUT || path.join(ROOT, '.build', 'sim');
const PROJECT = E.SIM_PROJECT || 'payesh-sim';
const CENTRAL = E.SIM_CENTRAL || 'https://central.sim';
const SCHOOL1 = E.SIM_SCHOOL1 || 'http://school1:8080';
const SCHOOL2 = E.SIM_SCHOOL2 || 'http://school2:8080';
const WAIT_MS = Number(E.SIM_WAIT_MS || 200_000);       /* one eventual step (prod poll = 60 s) */
/* the owner's database, exactly what the owner types in «تنظیمات» (Dart regionFor ⇒ us-east-1 off Arvan) */
const DB = s3.normalize({
  endpoint: E.SIM_S3_ENDPOINT || 'https://s3.sim', bucket: E.SIM_S3_BUCKET || 'payesh-sim',
  region: E.SIM_S3_REGION || '', prefix: 'payesh/', accessKey: E.SIM_S3_ACCESS_KEY || 'sim-owner-ak-173',
  secret: E.SIM_S3_SECRET || 'sim-owner-secret-173-do-not-reuse', pathStyle: true,
});

/* ───────────────────────── step bookkeeping ───────────────────────── */
const steps = [];
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function step(id, fa, fn) {
  const s = Date.now();
  const rec = { id, fa, ok: false, ms: 0, detail: '' };
  try {
    const d = await fn(rec);
    rec.ok = true;
    rec.detail = d === undefined ? 'ok' : (typeof d === 'string' ? d : JSON.stringify(d));
  } catch (e) {
    rec.ok = false;
    rec.detail = String((e && e.message) || e).slice(0, 600);
  }
  rec.ms = Date.now() - s;
  steps.push(rec);
  console.log(`${rec.ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${String(rec.ms).padStart(7)} ms  ${fa}  →  ${rec.detail}`);
  return rec;
}
function assert(c, m) { if (!c) throw new Error(m); }
/** polls fn until it returns a truthy value; returns { value, ms } or throws after `limit` */
async function waitFor(fn, { limit = WAIT_MS, every = 1000, what = 'condition' } = {}) {
  const s = Date.now();
  let last = null;
  for (;;) {
    try { const v = await fn(); if (v) return { value: v, ms: Date.now() - s }; last = null; } catch (e) { last = e; }
    if (Date.now() - s > limit) throw new Error(`timeout ${limit} ms waiting for ${what}${last ? ' (last error: ' + String(last.message || last).slice(0, 200) + ')' : ''}`);
    await sleep(every);
  }
}

/* ───────────────────────── HTTP (what the apps send) ───────────────────────── */
async function api(base, p, { method = 'GET', body, token, timeout = 30_000, headers = {} } = {}) {
  const h = Object.assign({ accept: 'application/json' }, headers);
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const s = Date.now();
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      break;
    } catch (e) {
      const detail = String(e.cause ? e.cause.code || e.cause.message : e.message);
      /* a reused idle keep-alive socket closed by the peer (no byte of the request was processed): retry once */
      if (attempt === 0 && /ECONNRESET|UND_ERR_SOCKET|other side closed/i.test(detail)) continue;
      return { status: 0, json: { ok: false, error: 'network', detail }, ms: Date.now() - s };
    }
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json, ms: Date.now() - s };
}
const health = (base) => api(base, '/api/health', { timeout: 12_000 });

/* ───────────────────────── Docker engine (restart/stop/start) ───────────────────────── */
let docker = function (method, p) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: p, method, timeout: 120_000 }, (res) => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}
const cname = (svc) => `${PROJECT}-${svc}-1`;
/* dry run outside docker: SIM_CTL=/path/ctl.sh ⇒ `ctl.sh restart|stop|start <svc>` */
if (E.SIM_CTL) {
  const { execFileSync } = require('child_process');
  const ctl = (op, svc) => { try { execFileSync(E.SIM_CTL, [op, svc], { stdio: 'ignore', timeout: 120_000 }); return { status: 204, body: '' }; } catch (e) { return { status: 500, body: e.message }; } };
  docker = async (method, p) => { const m = /\/containers\/[^/]*?-([a-z0-9]+)-1\/(restart|stop|start)/.exec(p); return m ? ctl(m[2], m[1]) : { status: 404, body: p }; };
}
async function restart(svc) { const r = await docker('POST', `/containers/${cname(svc)}/restart?t=15`); assert(r.status === 204, `docker restart ${svc}: ${r.status} ${r.body.slice(0, 120)}`); }
async function stopSvc(svc) { const r = await docker('POST', `/containers/${cname(svc)}/stop?t=10`); assert(r.status === 204 || r.status === 304, `docker stop ${svc}: ${r.status}`); }
async function startSvc(svc) { const r = await docker('POST', `/containers/${cname(svc)}/start`); assert(r.status === 204 || r.status === 304, `docker start ${svc}: ${r.status}`); }

/* ───────────────────────── the OWNER PANEL (Node twin of the Dart owner) ───────────────────────── */
const owner = {
  async pull() {
    let text = null;
    try { text = await s3.get(DB, DB.prefix + sr.DIR.registry); } catch (e) { if (e.status !== 404) throw e; }
    const empty = { v: 1, schools: [], settings: {}, domain: '', grants: [], decisions: {}, rejected: [] };
    if (!text) return { rev: 0, plain: empty };
    const env = JSON.parse(text);
    const r = sr.open(DB.secret, sr.K.registry, env);
    return { rev: env.rev, plain: Object.assign(empty, r.plain) };
  },
  async mutate(change) {
    const cur = await this.pull();
    const plain = JSON.parse(JSON.stringify(cur.plain));
    const out = await change(plain);
    const rev = Math.max(Date.now(), cur.rev + 1);
    await s3.put(DB, DB.prefix + sr.DIR.registry, JSON.stringify(sr.seal(DB.secret, sr.K.registry, rev, JSON.stringify(plain))));
    return out;
  },
  hash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `pbkdf2$150000$${salt}$` + crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'utf8'), 150000, 32, 'sha256').toString('hex');
  },
  controlPlain(rev) {
    return JSON.stringify({ v: 1, rev, endpoint: DB.endpoint, region: 'us-east-1', bucket: DB.bucket, prefix: 'payesh/', accessKey: DB.accessKey, secret: DB.secret });
  },
  /** «ذخیرهٔ دیتابیس» در تنظیمات پنل مالک ⇒ control/cloud-<kid>.json (cloud_control.dart publishControl) */
  async publishControl() {
    const rev = Date.now();
    await s3.put(DB, DB.prefix + control.controlKeyFor(DB.accessKey), JSON.stringify(control.sealText(DB.secret, rev, this.controlPlain(rev))));
    return rev;
  },
  /** connect_bundle.dart publishConnectBundle: public, no-cache + connect.json index */
  async publishConnect(login, password) {
    const rev = Date.now();
    const env = connect.sealText(connect.deriveSecret('school', login, password), rev, this.controlPlain(rev));
    const pub = { 'x-amz-acl': 'public-read', 'cache-control': 'no-cache' };
    await s3.call(DB, { method: 'PUT', key: DB.prefix + 'pub/' + connect.bundlePath('school', login), body: JSON.stringify(env), headers: pub });
    await s3.call(DB, { method: 'PUT', key: DB.prefix + 'pub/connect.json', body: JSON.stringify({ v: 1, kind: 'payesh-connect-index', base: `${DB.endpoint}/${DB.bucket}/payesh/pub/`, at: new Date().toISOString() }), headers: pub });
  },
  fields(f) {
    return {
      name: f.name, code: f.code, province: 'تهران', county: 'تهران', district: 'منطقهٔ ۱', area_kind: 'district',
      phone: '', landline: '', level: 'متوسطه دوم', type: 'عادی', school_type: 'governmental', gender: 'پسرانه', shift: 'صبح',
      work_days: [0, 1, 2, 3, 4, 5], excuse_window_minutes: 15, capabilities: {}, branches: [], fields: [], address: '',
      boom_goals: '', public_goals: false, staff_count: 20, student_count: 300,
      manager: { name: f.manager, username: f.username, national_id: f.nid, phone: f.phone, title: 'مدیر مدرسه' },
    };
  },
  /** createSchool (type 1: the owner types the manager's username and password) */
  async createSchool(f, password) {
    const hash = this.hash(password);
    const id = 's-' + crypto.randomBytes(6).toString('hex');
    await this.mutate((plain) => {
      const rec = this.fields(f);
      rec.manager.password_hash = hash; rec.manager.rev = 1;
      plain.schools.push(Object.assign({ id }, rec, { active: true, created_at: new Date().toISOString() }));
    });
    for (const login of [f.username, f.phone].filter(Boolean)) await this.publishConnect(login, password);
    return id;
  },
  async resetPassword(id, password) {
    const hash = this.hash(password);
    let m = null;
    await this.mutate((plain) => {
      const s = plain.schools.find(x => x.id === id);
      assert(s, 'school not found');
      s.manager.password_hash = hash; s.manager.rev = (s.manager.rev || 1) + 1; m = s.manager;
    });
    for (const login of [m.username, m.phone].filter(Boolean)) await this.publishConnect(login, password);
  },
  setActive(id, active) { return this.mutate((plain) => { const s = plain.schools.find(x => x.id === id); assert(s, 'school not found'); s.active = active; }); },
  removeSchool(id) { return this.mutate((plain) => { plain.schools = plain.schools.filter(x => x.id !== id); }); },
  /** the «درخواست‌ها» page: every schools/req/*.json that opens */
  async requests() {
    const keys = await s3.list(DB, { prefix: DB.prefix + sr.DIR.req });
    const out = [];
    for (const k of (keys.keys || keys || [])) {
      const key = typeof k === 'string' ? k : k.key;
      try { const env = JSON.parse(await s3.get(DB, key)); out.push(sr.open(DB.secret, sr.K.request, env).plain); } catch (e) { /* unreadable */ }
    }
    return out;
  },
  /** approveRequest: the school with the requester's username and password HASH */
  async approve(req) {
    const id = 's-' + crypto.randomBytes(6).toString('hex');
    await this.mutate((plain) => {
      const rec = this.fields({ name: req.school_name, code: 'R' + Date.now().toString().slice(-6), manager: req.manager_name, username: req.username, nid: '', phone: req.phone });
      rec.manager.password_hash = req.password_hash; rec.manager.rev = 1;
      plain.schools.push(Object.assign({ id }, rec, { active: true, request_id: req.id, created_at: new Date().toISOString() }));
    });
    return id;
  },
  async ack(id) {
    try {
      const env = JSON.parse(await s3.get(DB, DB.prefix + sr.DIR.ack + id + '.json'));
      return sr.open(DB.secret, sr.K.ack, env).plain;
    } catch (e) { return null; }
  },
};

/* ───────────────────────── the APPS (school app login logic) ───────────────────────── */
let deviceSeq = 0;
const DEVICE_KEYS = new Map();   /* pubkey(b64) → private key: the web client proves possession on refresh */
function devicePubkey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const b64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  DEVICE_KEYS.set(b64, privateKey);
  return b64;
}
/** proof of key possession for /api/auth/refresh (server/identity.js proofMessage) */
function refreshProof(l, rawToken) {
  const key = DEVICE_KEYS.get(l.pubkey);
  if (!key) return undefined;
  const ts = Date.now();
  const msg = 'payesh-refresh-v1\n' + l.res.device_id + '\n' + ts + '\n' + crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  const sig = crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return { ts, sig };
}
/** the address-only list (the directory of the apps): the central's /payesh/pub/school-servers.json */
async function directory() {
  const r = await api(CENTRAL, '/payesh/pub/school-servers.json', { timeout: 10_000 });
  return r.status === 200 && r.json && Array.isArray(r.json.servers) ? r.json.servers : [];
}
function urlsOf(entry) {
  const out = [];
  for (const u of [...(entry.public_urls || []), entry.public_url, ...(entry.lan || [])]) if (u && !out.includes(u)) out.push(String(u).replace(/\/+$/, ''));
  return out;
}
/**
 * session_controller.dart: login on `home` (the app's own server: this PC, or the last one),
 * then _loginElsewhere — hinted host, then the list, never a server that is not set up.
 */
/** what the app does right after signing in (session_controller.checkSub, row 167): a role that
 *  needs a subscription and never had one gets the owner's trial straight away */
async function autoTrial(server, token, name) {
  const st = await api(server, '/api/sub/status', { token });
  const sub = (st.json && (st.json.sub || st.json)) || {};
  if (!(sub.managed && !sub.access && sub.status === 'none' && sub.trial_available)) return { sub: sub.status || null };
  const dh = crypto.createHash('sha256').update('sim-device-hash:' + name).digest('hex');
  const t = await api(server, '/api/sub/trial', { method: 'POST', token, body: { device_hash: dh } });
  return { sub: 'trial', trial_status: t.status, trial: t.json && (t.json.sub || t.json).status };
}
async function appLogin(home, login, password, opts = {}) {
  const l = await appLogin0(home, login, password, opts);
  if (l.server && l.res && l.res.session && l.res.session.token) {
    try { l.trial = await autoTrial(l.server, l.res.session.token, l.name); } catch (e) { l.trial = { error: e.message }; }
  }
  return l;
}
async function appLogin0(home, login, password, { name = 'sim-device-' + (++deviceSeq) } = {}) {
  const body = { phone: login, password, name, platform: 'windows', device_pubkey: devicePubkey() };
  const done = (r) => Object.assign(r, { pubkey: body.device_pubkey });
  const tried = [];
  const first = await api(home, '/api/auth/login', { method: 'POST', body, timeout: 45_000 });
  tried.push({ at: home, status: first.status, error: first.json && first.json.error, detail: first.json && first.json.detail, ms: first.ms });
  if (first.status === 200 && first.json.ok) return done({ server: home, res: first.json, tried, name });
  const moved = first.json && first.json.error === 'school_hosted_elsewhere';
  if (!moved && !(first.json && (first.json.error === 'bad_credentials' || first.json.error === 'not_found' || first.status === 401))) {
    return { server: null, res: first.json, tried, status: first.status };
  }
  const queue = [];
  const seen = new Set([home]);
  for (const u of ((first.json && first.json.urls) || [])) if (!seen.has(u)) queue.push(u);
  const dir = await directory();
  if (moved && first.json.instance) for (const e of dir) if (e.instance === first.json.instance) queue.unshift(...urlsOf(e));
  for (const e of dir) for (const u of urlsOf(e)) if (!queue.includes(u)) queue.push(u);
  let budget = 8;
  while (queue.length && budget-- > 0) {
    const u = queue.shift().replace(/\/+$/, '');
    if (seen.has(u)) continue;
    seen.add(u);
    const h = await health(u);
    if (h.status !== 200 || !h.json || !h.json.setup_done) { tried.push({ at: u, probe: h.status, setup_done: h.json && h.json.setup_done }); continue; }
    const r = await api(u, '/api/auth/login', { method: 'POST', body, timeout: 45_000 });
    tried.push({ at: u, status: r.status, error: r.json && r.json.error, ms: r.ms });
    if (r.status === 200 && r.json.ok) return done({ server: u, res: r.json, tried, name });
    if (r.json && r.json.error === 'school_hosted_elsewhere') {
      if (r.json.instance) for (const e of dir) if (e.instance === r.json.instance) queue.unshift(...urlsOf(e));
      continue;
    }
    if (r.status === 401 || r.status === 0 || (r.json && r.json.error === 'bad_credentials')) continue;
    return { server: u, res: r.json, tried, status: r.status };
  }
  return { server: null, res: first.json, tried, status: first.status };
}
const tokenOf = (l) => l && l.res && l.res.session && l.res.session.token;
const pull = (base, token) => api(base, '/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token, timeout: 30_000 });
let uidSeq = 0;
const uid = () => 'sim173-' + Date.now().toString(36) + '-' + (++uidSeq);
async function push(base, token, ops) {
  const r = await api(base, '/api/sync', { method: 'POST', token, body: { ops: ops.map(o => Object.assign({ uid: uid(), type: 'put' }, o)), idempotency_key: uid() } });
  return r;
}
/** a valid Iranian national code (checksum) from 9 digits */
function nid(seed) {
  const s = String(seed).padStart(9, '0').slice(-9);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  const r = sum % 11;
  return s + String(r < 2 ? r : 11 - r);
}
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : 0; };

/* ═══════════════════════════════ the scenario ═══════════════════════════════ */
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const R = Date.now().toString().slice(-5);
  const A = { name: 'دبیرستان شبیه‌سازی الف ' + R, code: 'A' + R, manager: 'مدیر الف', username: 'sima' + R, nid: nid('11173' + R), phone: '0912' + ('173' + R).slice(-7) };
  const B = { name: 'هنرستان شبیه‌سازی ب ' + R, code: 'B' + R, manager: 'مدیر ب', username: 'simb' + R, nid: nid('22173' + R), phone: '0913' + ('173' + R).slice(-7) };
  const PW_A = 'Sim-A-' + R + '!', PW_A2 = 'Sim-A2-' + R + '!', PW_B = 'Sim-B-' + R + '!';
  const ctx = {};

  /* ── ۰. زیرساخت ── */
  await step('S00', 'همهٔ سرورها بالا آمدند (مرکزی پشت HTTPS، دو رایانهٔ مدرسه)', async () => {
    const out = {};
    for (const [k, b] of [['central', CENTRAL], ['school1', SCHOOL1], ['school2', SCHOOL2]]) {
      const w = await waitFor(async () => { const h = await health(b); return h.status === 200 && h.json; }, { limit: 120_000, what: k + ' /api/health' });
      out[k] = { ms: w.ms, version: w.value.version, central: !!w.value.central, setup_done: !!w.value.setup_done, headless: !!w.value.headless };
    }
    ctx.version = out.central.version;
    assert(out.central.central && out.central.setup_done, 'central must answer central:true, setup_done:true ' + JSON.stringify(out.central));
    assert(!out.school1.setup_done && !out.school2.setup_done, 'school PCs must start fresh');
    return out;
  });

  await step('S01', 'سرور مرکزی با کلید محیطی به دیتابیس وصل است و در فهرست نشانی‌ها دیده می‌شود', async () => {
    const w = await waitFor(async () => {
      const t = await s3.get(DB, DB.prefix + 'pub/school-servers.json').catch(() => null);
      const doc = t ? JSON.parse(t) : null;
      return doc && (doc.servers || []).length ? doc : null;
    }, { what: 'pub/school-servers.json in the bucket' });
    const dir = await directory();
    ctx.centralInstance = (await health(CENTRAL)).json.instance || null;
    return { bucket_list_after_ms: w.ms, bucket_entries: w.value.servers.length, central_list_entries: dir.length };
  });

  await step('S02', 'پنل مالک «ذخیرهٔ دیتابیس» (پاکت control) ⇒ رسید پیروی سرور مرکزی', async () => {
    ctx.controlRev = await owner.publishControl();
    const w = await waitFor(async () => {
      const keys = await s3.list(DB, { prefix: DB.prefix + control.ACK_DIR });
      const list = (keys.keys || keys || []).map(k => (typeof k === 'string' ? k : k.key));
      for (const k of list) {
        try { const a = JSON.parse(await s3.get(DB, k)); if (Number(a.rev) >= ctx.controlRev) return { key: k.split('/').pop(), ok: a.ok, error: a.error || null }; } catch (e) { /* next */ }
      }
      return null;
    }, { what: 'control ack with the new rev' });
    /* the central TESTED the owner's settings (list/put/get with them) — ok:false = it could not use them */
    assert(w.value.ok === true, 'the central could not use the owner\'s database settings: ' + JSON.stringify(w.value));
    return { ack_after_ms: w.ms, ack: w.value };
  });

  /* ── ۱. پنل مالک: مدرسهٔ الف ── */
  await step('S03', 'پنل مالک مدرسهٔ الف را با نام کاربری و رمز مدیر می‌سازد (+ بستهٔ اتصال)', async () => {
    const s = Date.now();
    ctx.idA = await owner.createSchool(A, PW_A);
    const reg = await owner.pull();
    assert(reg.plain.schools.some(x => x.id === ctx.idA), 'school A not in the registry');
    const pubOk = await fetch(`${DB.endpoint}/${DB.bucket}/payesh/pub/${connect.bundlePath('school', A.username)}`).then(r => r.status);
    assert(pubOk === 200, 'connect bundle is not publicly readable: ' + pubOk);
    ctx.createdA = Date.now();
    return { id: ctx.idA, owner_write_ms: Date.now() - s, bundle_public: pubOk };
  });

  await step('S04', 'سرور مرکزی خودکار میزبان مدرسهٔ الف می‌شود (رسید schools/ack)', async () => {
    const w = await waitFor(async () => owner.ack(ctx.idA), { what: 'schools/ack/' + ctx.idA });
    ctx.ackA = w.value;
    return { hosted_after_ms: Date.now() - ctx.createdA, instance: String(w.value.instance || '').slice(0, 24) };
  });

  /* ── ۲. رایانهٔ مدرسهٔ الف: نصب تازه، بی‌تایپ نشانی ── */
  await step('S05', 'اپ مدرسه روی رایانهٔ تازه‌نصب: ورود مدیر الف (اتصال خودکار ⇒ سرور میزبان)', async () => {
    const l = await appLogin(SCHOOL1, A.username, PW_A);
    ctx.mgrA = l;
    assert(tokenOf(l), 'manager A could not sign in: ' + JSON.stringify(l.tried));
    const h1 = await health(SCHOOL1);
    return { signed_in_on: l.server, path: l.tried.map(t => `${t.at.replace(/^https?:\/\//, '')}:${t.status || t.probe}${t.error ? '/' + t.error : ''}`).join(' → '), school1_connected: !!(h1.json && (h1.json.cloud || h1.json.cloud_connected || h1.json.connected)) };
  });

  await step('S06', 'مدیر الف دادهٔ مدرسهٔ خودش را می‌بیند (نام مدرسه از پنل مالک)', async () => {
    const r = await pull(ctx.mgrA.server, tokenOf(ctx.mgrA));
    assert(r.status === 200, 'pull ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
    const sch = (r.json.collections.schools || [])[0] || {};
    assert(sch.name === A.name, `school name «${sch.name}» ≠ «${A.name}»`);
    return { pull_ms: r.ms, users: (r.json.collections.users || []).length };
  });

  /* ── ۳. دادهٔ مدرسه و همهٔ نقش‌ها ── */
  await step('S07', 'مدیر الف کلاس، درس، دبیر، دانش‌آموز، ولی، پیوند و برنامه را ثبت می‌کند', async () => {
    const base = ctx.mgrA.server, T = tokenOf(ctx.mgrA);
    const P = (ops) => push(base, T, ops);
    const r1 = await P([{ collection: 'classes', data: { name: 'دهم ریاضی ۱', grade: 'دهم' } }, { collection: 'subjects', data: { name: 'ریاضی ۱' } }]);
    assert(r1.status === 200 && r1.json.applied && r1.json.applied.length === 2, 'classes/subjects: ' + JSON.stringify(r1.json).slice(0, 300));
    ctx.classId = r1.json.applied[0].id; ctx.subjectId = r1.json.applied[1].id;
    ctx.teacher = { name: 'دبیر شبیه‌سازی', role: 'teacher', phone: '0935' + ('1' + R).padStart(7, '0').slice(-7), national_id: nid('3317' + R) };
    ctx.student = { name: 'دانش‌آموز شبیه‌سازی', role: 'student', phone: '0936' + ('2' + R).padStart(7, '0').slice(-7), national_id: nid('4417' + R), class_id: ctx.classId, grade: 'دهم' };
    ctx.student2 = { name: 'دانش‌آموز دوم', role: 'student', phone: '0936' + ('3' + R).padStart(7, '0').slice(-7), national_id: nid('5517' + R), class_id: ctx.classId, grade: 'دهم' };
    ctx.parent = { name: 'ولی شبیه‌سازی', role: 'parent', phone: '0937' + ('4' + R).padStart(7, '0').slice(-7), national_id: nid('6617' + R) };
    const r2 = await P([ctx.teacher, ctx.student, ctx.student2, ctx.parent].map(d => ({ collection: 'users', data: d })));
    assert(r2.status === 200 && r2.json.applied && r2.json.applied.length === 4, 'users: ' + JSON.stringify(r2.json).slice(0, 400));
    [ctx.teacher.id, ctx.student.id, ctx.student2.id, ctx.parent.id] = r2.json.applied.map(a => a.id);
    const r3 = await P([
      { collection: 'parent_links', data: { parent_id: ctx.parent.id, student_id: ctx.student.id, relation: 'پدر' } },
      { collection: 'schedule', data: { class_id: ctx.classId, teacher_id: ctx.teacher.id, subject_id: ctx.subjectId, weekday: 0, period: 1 } },
    ]);
    assert(r3.status === 200 && r3.json.applied && r3.json.applied.length === 2, 'links/schedule: ' + JSON.stringify(r3.json).slice(0, 300));
    return { push_ms: [r1.ms, r2.ms, r3.ms], users: 4 };
  });

  for (const [id, who, key] of [['S08', 'دبیر', 'teacher'], ['S09', 'دانش‌آموز', 'student'], ['S10', 'ولی', 'parent']]) {
    await step(id, `ورود ${who} از اپ روی رایانهٔ مدرسه (نام کاربری = همراه، رمز = کد ملی)`, async () => {
      const u = ctx[key];
      const l = await appLogin(SCHOOL1, u.phone, u.national_id);
      ctx[key + 'Login'] = l;
      assert(tokenOf(l), `${key} could not sign in: ` + JSON.stringify(l.tried));
      return { on: l.server, path: l.tried.map(t => `${t.at.replace(/^https?:\/\//, '')}:${t.status || t.probe}${t.error ? '/' + t.error : ''}`).join(' → ') };
    });
  }

  await step('S11', 'دبیر حضور و غیاب ثبت می‌کند؛ دانش‌آموز و ولی همان را می‌بینند؛ دانش‌آموز دیگر را نه', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tl = ctx.teacherLogin;
    const r = await push(tl.server, tokenOf(tl), [
      { collection: 'attendance', data: { class_id: ctx.classId, student_id: ctx.student.id, date: today, status: 'absent' } },
      { collection: 'attendance', data: { class_id: ctx.classId, student_id: ctx.student2.id, date: today, status: 'present' } },
    ]);
    assert(r.status === 200 && r.json.applied && r.json.applied.length === 2, 'teacher attendance: ' + JSON.stringify(r.json).slice(0, 300));
    const sp = await pull(ctx.studentLogin.server, tokenOf(ctx.studentLogin));
    const pp = await pull(ctx.parentLogin.server, tokenOf(ctx.parentLogin));
    const sAtt = (sp.json.collections.attendance || []).filter(a => a.date === today);
    const pAtt = (pp.json.collections.attendance || []).filter(a => a.date === today);
    assert(sAtt.length === 1 && Number(sAtt[0].student_id) === ctx.student.id && sAtt[0].status === 'absent', 'student sees: ' + JSON.stringify(sAtt));
    assert(pAtt.length === 1 && Number(pAtt[0].student_id) === ctx.student.id, 'parent sees: ' + JSON.stringify(pAtt));
    const deny = await push(ctx.studentLogin.server, tokenOf(ctx.studentLogin), [{ collection: 'attendance', data: { class_id: ctx.classId, student_id: ctx.student2.id, date: today, status: 'present' } }]);
    assert(deny.json && (deny.json.rejected || []).length === 1 && !(deny.json.applied || []).length, 'student must not write attendance: ' + JSON.stringify(deny.json).slice(0, 200));
    return { teacher_push_ms: r.ms, student_rows: sAtt.length, parent_rows: pAtt.length, student_write: deny.json.rejected[0].error };
  });

  /* ── ۴. تغییرهای پنل مالک ── */
  await step('S12', 'مالک رمز مدیر الف را عوض می‌کند ⇒ رمز تازه کار می‌کند، رمز قدیم نه', async () => {
    const s = Date.now();
    await owner.resetPassword(ctx.idA, PW_A2);
    const w = await waitFor(async () => {
      const l = await appLogin(ctx.mgrA.server, A.username, PW_A2);
      return tokenOf(l) ? l : null;
    }, { every: 3000, what: 'the new manager password to work' });
    const old = await api(ctx.mgrA.server, '/api/auth/login', { method: 'POST', body: { phone: A.username, password: PW_A, name: 'old-pw', platform: 'windows', device_pubkey: devicePubkey() } });
    assert(!(old.json && old.json.ok), 'the OLD password still works after the owner changed it');
    ctx.mgrA = w.value;
    return { new_password_after_ms: Date.now() - s, old_password: old.status + '/' + (old.json && old.json.error) };
  });

  await step('S13', 'مالک مدرسهٔ الف را غیرفعال و دوباره فعال می‌کند (ورود بسته/باز)', async () => {
    let s = Date.now();
    await owner.setActive(ctx.idA, false);
    const off = await waitFor(async () => {
      /* probe without a valid device key: a still-active school answers bad_device_pubkey/401 and
         creates NO device (a real login every 3 s would fill the manager's device cap) */
      const r = await api(ctx.mgrA.server, '/api/auth/login', { method: 'POST', body: { phone: A.username, password: PW_A2, name: 'inactive-probe', platform: 'windows', device_pubkey: 'not-a-key' } });
      return r.status === 403 && r.json && /inactive|removed/.test(r.json.error || '') ? r : null;
    }, { every: 4000, what: 'login to be refused for the inactive school' });
    const real = await api(ctx.mgrA.server, '/api/auth/login', { method: 'POST', body: { phone: A.username, password: PW_A2, name: 'inactive', platform: 'windows', device_pubkey: devicePubkey() } });
    assert(real.status === 403 && real.json && real.json.error === 'school_inactive', 'real app login on the inactive school: ' + real.status + ' ' + JSON.stringify(real.json));
    const live = await api(ctx.mgrA.server, '/api/sub/status', { token: tokenOf(ctx.mgrA) });
    const liveSub = (live.json && (live.json.sub || live.json)) || {};
    const offMs = Date.now() - s;
    s = Date.now();
    await owner.setActive(ctx.idA, true);
    const on = await waitFor(async () => { const l = await appLogin(ctx.mgrA.server, A.username, PW_A2); return tokenOf(l) ? l : null; }, { every: 3000, what: 'login to work again' });
    ctx.mgrA = on.value;
    return { closed_after_ms: offMs, closed_error: real.json.error, open_session_sees: liveSub.status || live.status, reopened_after_ms: Date.now() - s };
  });

  /* ── ۵. درخواست ثبت مدرسه از اپ ⇒ پنل مالک ⇒ تأیید ⇒ ورود ── */
  await step('S14', 'اپ «درخواست ثبت مدرسه» می‌فرستد (به سرور مرکزی)', async () => {
    ctx.req = { school_name: 'دبستان درخواستی ' + R, level: sr.LEVELS[0], province: 'اصفهان', county: 'اصفهان', village: '', phone: '0915' + ('5' + R).padStart(7, '0').slice(-7), staff_count: 12, student_count: 150, manager_name: 'مدیر درخواستی', username: 'simr' + R, password: 'Sim-R-' + R + '!' };
    const r = await api(CENTRAL, '/api/schools/register', { method: 'POST', body: ctx.req });
    assert(r.status === 200 && r.json.ok && r.json.id, 'register: ' + r.status + ' ' + JSON.stringify(r.json));
    ctx.reqId = r.json.id; ctx.reqToken = r.json.token;
    return { id: r.json.id, status: r.json.status, ms: r.ms };
  });

  await step('S15', 'درخواست در صفحهٔ «درخواست‌ها»ی پنل مالک دیده می‌شود', async () => {
    const w = await waitFor(async () => (await owner.requests()).find(x => x.id === ctx.reqId), { every: 1000, what: 'the request in the owner panel' });
    ctx.reqPlain = w.value;
    assert(String(w.value.password_hash || '').startsWith('pbkdf2$'), 'request without a pbkdf2 hash');
    return { visible_after_ms: w.ms, school: w.value.school_name };
  });

  await step('S16', 'مالک تأیید می‌کند ⇒ وضعیت «تأیید شد» ⇒ مدیر با همان رمز درخواست وارد می‌شود', async () => {
    const s = Date.now();
    ctx.idR = await owner.approve(ctx.reqPlain);
    const st = await waitFor(async () => {
      const r = await api(CENTRAL, `/api/schools/register/status?id=${encodeURIComponent(ctx.reqId)}&token=${encodeURIComponent(ctx.reqToken)}`);
      return r.json && r.json.status === 'approved' ? r.json : null;
    }, { every: 2000, what: 'status approved' });
    const stMs = Date.now() - s;
    const w = await waitFor(async () => { const l = await appLogin(CENTRAL, ctx.req.username, ctx.req.password); return tokenOf(l) ? l : null; }, { every: 3000, what: 'requested manager login' });
    ctx.mgrR = w.value;
    return { status_after_ms: stMs, login_after_ms: Date.now() - s, on: w.value.server, school: st.value.school };
  });

  /* ── ۶. مدرسهٔ ب با سرور خودش (رایانهٔ مدرسهٔ ۲) ── */
  await step('S17', 'مالک مدرسهٔ ب را می‌سازد و مدیرش همان لحظه روی رایانهٔ مدرسهٔ ۲ وارد می‌شود', async () => {
    ctx.idB = await owner.createSchool(B, PW_B);
    const l = await appLogin(SCHOOL2, B.username, PW_B);
    ctx.mgrB = l;
    assert(tokenOf(l), 'manager B could not sign in: ' + JSON.stringify(l.tried));
    const r = await pull(l.server, tokenOf(l));
    assert(((r.json.collections || {}).schools || [])[0].name === B.name, 'B sees another school');
    return { on: l.server, own_server: l.server === SCHOOL2, path: l.tried.map(t => `${t.at.replace(/^https?:\/\//, '')}:${t.status || t.probe}${t.error ? '/' + t.error : ''}`).join(' → ') };
  });

  await step('S18', 'رایانهٔ مدرسهٔ ۲ خودش را به سرور مرکزی اعلام می‌کند (فهرست نشانی‌ها)', async () => {
    const want = ctx.mgrB.server === SCHOOL2 ? (await health(SCHOOL2)).json.instance : null;
    if (!want) return 'skipped: school B is hosted by the central';
    const w = await waitFor(async () => (await directory()).find(e => e.instance === want), { every: 3000, what: 'school2 in the central list' });
    return { listed_after_ms: w.ms, urls: urlsOf(w.value).length, school: w.value.school };
  });

  await step('S19', 'جداسازی: توکن مدرسهٔ ب/درخواستی دادهٔ مدرسهٔ الف را نمی‌بیند', async () => {
    const findA = (r) => JSON.stringify((r.json && r.json.collections) || {}).includes(A.name) || JSON.stringify((r.json && r.json.collections) || {}).includes(ctx.student.national_id);
    const out = {};
    for (const [k, l] of [['B', ctx.mgrB], ['R', ctx.mgrR]]) {
      for (const base of [l.server, CENTRAL, SCHOOL1]) {
        const r = await pull(base, tokenOf(l));
        assert(!findA(r), `token of ${k} reads school A data on ${base}`);
        out[k + '@' + base.replace(/^https?:\/\//, '')] = r.status;
      }
    }
    const forged = await pull(CENTRAL, 'x'.repeat(43));
    assert(forged.status === 401, 'forged token: ' + forged.status);
    return out;
  });

  /* ── ۷. پایداری ── */
  await step('S20', 'ری‌استارت سرور مرکزی ⇒ مدارس میزبانی‌شده برمی‌گردند و داده سالم است', async () => {
    const s = Date.now();
    await restart('central');
    await waitFor(async () => { const h = await health(CENTRAL); return h.status === 200; }, { limit: 120_000, what: 'central health' });
    const up = Date.now() - s;
    const w = await waitFor(async () => { const l = await appLogin(SCHOOL1, A.username, PW_A2); return tokenOf(l) ? l : null; }, { every: 3000, what: 'manager A login after restart' });
    const r = await pull(w.value.server, tokenOf(w.value));
    const users = (r.json.collections.users || []).length;
    assert(users >= 5, 'school A lost users after restart: ' + users);
    ctx.mgrA = w.value;
    return { health_after_ms: up, login_after_ms: Date.now() - s, users };
  });

  await step('S21', 'نشست قبلی دبیر بعد از ری‌استارت هنوز معتبر است؛ نوسازی نشست با دستگاه (بی‌ورود دوباره)', async () => {
    const tl = ctx.teacherLogin;
    const r0 = await pull(tl.server, tokenOf(tl));
    assert(r0.status === 200 || r0.status === 401, 'teacher pull ' + r0.status);
    const raw = tl.res.device_token;
    assert(raw, 'teacher login returned no device_token');
    /* ردیف ۱۷۳ D14: بعد از ری‌استارت سرور مرکزی، پاسخِ خودِ مدرسهٔ میزبانی‌شده (نه bad_device سرور اصلی) */
    const np = await api(tl.server, '/api/auth/refresh', { method: 'POST', body: { device_token: raw } });
    assert(np.status === 401 && np.json && np.json.error === 'proof_required', 'refresh without proof after restart: ' + np.status + ' ' + JSON.stringify(np.json).slice(0, 200));
    const rf = await api(tl.server, '/api/auth/refresh', { method: 'POST', body: { device_token: raw, proof: refreshProof(tl, raw) } });
    assert(rf.status === 200 && rf.json.ok && rf.json.session, 'refresh with proof: ' + rf.status + ' ' + JSON.stringify(rf.json).slice(0, 200));
    const r1 = await pull(tl.server, rf.json.session.token);
    assert(r1.status === 200, 'pull with the refreshed session ' + r1.status);
    tl.res.device_token = rf.json.device_token || raw;
    tl.res.session = rf.json.session;
    /* اپ ویندوز/اندروید (payesh_sync) کلید عمومی نمی‌فرستد ⇒ نوسازی بی‌اثبات */
    const bare = await api(tl.server, '/api/auth/login', { method: 'POST', body: { phone: ctx.teacher.phone, password: ctx.teacher.national_id, name: 'sim-app-nokey', platform: 'windows' } });
    assert(bare.status === 200 && bare.json.device_token, 'pubkey-less app login: ' + bare.status + ' ' + JSON.stringify(bare.json).slice(0, 200));
    const brf = await api(tl.server, '/api/auth/refresh', { method: 'POST', body: { device_token: bare.json.device_token } });
    assert(brf.status === 200 && brf.json.ok, 'pubkey-less app refresh: ' + brf.status + ' ' + JSON.stringify(brf.json).slice(0, 200));
    return { old_session: r0.status === 200 ? 'still valid' : 'expired', no_proof: np.json.error, refreshed: r1.status, rotated: !!rf.json.rotated, app_nokey_refresh: brf.status };
  });

  await step('S22', 'ری‌استارت رایانهٔ مدرسهٔ ۲ ⇒ داده و ورود مدیر ب سالم', async () => {
    const s = Date.now();
    await restart('school2');
    await waitFor(async () => (await health(SCHOOL2)).status === 200, { limit: 120_000, what: 'school2 health' });
    const l = await appLogin(SCHOOL2, B.username, PW_B);
    assert(tokenOf(l), 'manager B after restart: ' + JSON.stringify(l.tried));
    return { back_after_ms: Date.now() - s, on: l.server };
  });

  await step('S23', 'قطع دیتابیس (صندوقچه) ⇒ ورود و کار کاربران ادامه دارد؛ وصل دوباره ⇒ همگام', async () => {
    await stopSvc(E.SIM_S3_SERVICE || 's3');
    try {
      const l = await appLogin(ctx.teacherLogin.server, ctx.teacher.phone, ctx.teacher.national_id);
      assert(tokenOf(l), 'teacher cannot sign in while the database is down: ' + JSON.stringify(l.tried));
      const today = new Date().toISOString().slice(0, 10);
      const r = await push(l.server, tokenOf(l), [{ collection: 'attendance', data: { class_id: ctx.classId, student_id: ctx.student.id, date: today, status: 'late' } }]);
      assert(r.status === 200 && (r.json.applied || []).length === 1, 'write while database down: ' + JSON.stringify(r.json).slice(0, 200));
      return { login_ms: l.tried.reduce((a, t) => a + (t.ms || 0), 0), write_ms: r.ms };
    } finally {
      await startSvc(E.SIM_S3_SERVICE || 's3');
      await waitFor(async () => !!(await s3.get(DB, DB.prefix + sr.DIR.registry).catch(() => null)), { limit: 60_000, what: 's3 back' });
    }
  });

  /* ── ۸. پشتیبان و بازگردانی (همان دکمهٔ پنل مدیر) ── */
  await step('S24', 'پشتیبان‌گیری مدیر ب و بازگردانی آن', async () => {
    const T = tokenOf(ctx.mgrB) && (await appLogin(SCHOOL2, B.username, PW_B));
    const tok = tokenOf(T);
    const b = await api(T.server, '/api/admin/backup', { method: 'POST', token: tok, body: {} });
    assert(b.status === 200 && b.json.ok, 'backup: ' + b.status + ' ' + JSON.stringify(b.json).slice(0, 200));
    const list = await api(T.server, '/api/admin/backups', { token: tok });
    const files = (list.json && Array.isArray(list.json.files)) ? list.json.files : [];
    assert(files.includes(b.json.file), 'backup not listed: ' + JSON.stringify(list.json).slice(0, 200));
    /* بازگردانی: فایل آینهٔ امضاشده ⇒ /api/admin/restore (بی‌جایگزینی) ⇒ دادهٔ مدرسه همان است */
    const before = await pull(T.server, tok);
    const ref = await api(T.server, '/api/admin/mirror/refresh', { method: 'POST', token: tok, body: {} });
    assert(ref.status === 200 && ref.json.ok, 'mirror refresh: ' + ref.status);
    const snap = await api(T.server, '/api/admin/mirror/download', { token: tok });
    assert(snap.status === 200 && snap.json && snap.json.collections, 'mirror download: ' + snap.status);
    const rs = await api(T.server, '/api/admin/restore', { method: 'POST', token: tok, body: { data: snap.json, replace: false }, timeout: 60_000 });
    assert(rs.status === 200 && rs.json.ok, 'restore: ' + rs.status + ' ' + JSON.stringify(rs.json).slice(0, 200));
    /* پشتیبانِ دست‌کاری‌شده رد می‌شود (امضا) */
    const bad = JSON.parse(JSON.stringify(snap.json)); bad.at = '1999-01-01T00:00:00.000Z';
    const rb = await api(T.server, '/api/admin/restore', { method: 'POST', token: tok, body: { data: bad } });
    assert(rb.status === 400, 'tampered backup accepted: ' + rb.status);
    const after = await pull(T.server, tok);
    const cnt = (x) => JSON.stringify(x.json || {}).length;
    return { backup_ms: b.ms, backups: files.length, file: b.json.file, size: b.json.size, restore_ms: rs.ms, tampered: rb.json && rb.json.error, pull_bytes_before: cnt(before), pull_bytes_after: cnt(after) };
  });

  /* ── ۹. بار: ورود هم‌زمان پشت پروکسی ── */
  await step('S25', '۳۰ ورود هم‌زمان کاربران مدرسهٔ الف از راه سرور مرکزی (پشت پروکسی HTTPS)', async () => {
    const base = ctx.mgrA.server, T = tokenOf(ctx.mgrA);
    const many = [];
    for (let i = 0; i < 30; i++) many.push({ name: 'دانش‌آموز بار ' + i, role: 'student', phone: '0938' + String(R + i).padStart(7, '0').slice(-7), national_id: nid('77' + R + String(i).padStart(2, '0')), class_id: ctx.classId, grade: 'دهم' });
    const r = await push(base, T, many.map(d => ({ collection: 'users', data: d })));
    assert(r.status === 200 && (r.json.applied || []).length === 30, 'bulk users: ' + JSON.stringify(r.json).slice(0, 300));
    const s = Date.now();
    const res = await Promise.all(many.map(u => api(CENTRAL, '/api/auth/login', { method: 'POST', body: { phone: u.phone, password: u.national_id, name: 'load', platform: 'android', device_pubkey: devicePubkey() }, timeout: 60_000 })));
    const ok = res.filter(x => x.status === 200 && x.json.ok).length;
    const ms = res.map(x => x.ms);
    const errs = {};
    for (const x of res) if (!(x.status === 200 && x.json.ok)) errs[x.status + '/' + (x.json && x.json.error)] = (errs[x.status + '/' + (x.json && x.json.error)] || 0) + 1;
    assert(ok === 30, `${ok}/30 signed in; errors ${JSON.stringify(errs)}`);
    return { ok, wall_ms: Date.now() - s, p50: pct(ms, 50), p95: pct(ms, 95), max: Math.max(...ms) };
  });

  await step('S26', 'شش درخواست ثبت مدرسه از شش دستگاه مختلف پشت همان پروکسی؛ هدر جعلی سقف را دور نمی‌زند', async () => {
    const out = [];
    const reg = (i, headers) => api(CENTRAL, '/api/schools/register', { method: 'POST', headers,
      body: Object.assign({}, ctx.req, { school_name: 'مدرسهٔ صف ' + i + ' ' + R, username: 'simq' + i + R, phone: '0917' + String(R * 10 + i).padStart(7, '0').slice(-7) }) });
    for (let i = 0; i < 6; i++) {
      const r = await reg(i, { 'x-sim-client-ip': '203.0.113.' + (10 + i) });
      out.push(r.status + (r.json && r.json.error ? '/' + r.json.error : ''));
    }
    const limited = out.filter(x => x.startsWith('429')).length;
    assert(limited === 0, `${limited}/6 refused with 429 — every device behind the proxy shares one IP: ${out.join(', ')}`);
    /* NEG: one device (one internet address) forging a different X-Forwarded-For on every try */
    const forged = [];
    for (let i = 0; i < 7; i++) {
      const r = await reg(10 + i, { 'x-sim-client-ip': '198.51.100.77', 'x-forwarded-for': '10.66.0.' + (1 + i) });
      forged.push(r.status);
    }
    assert(forged.includes(429), 'forged X-Forwarded-For escaped the 5/h limit: ' + forged.join(','));
    return { devices: out.join(', '), forged_xff: forged.join(',') };
  });

  /* ── ۱۰. حذف و ساخت دوباره (شکایت ردیف ۱۷۰) ── */
  await step('S27', 'مالک مدرسهٔ درخواستی را حذف می‌کند ⇒ ورود بسته؛ با همان نام کاربری دوباره می‌سازد ⇒ ورود باز', async () => {
    let s = Date.now();
    await owner.removeSchool(ctx.idR);
    const off = await waitFor(async () => {
      /* probe without a valid device key (no device is created while the school still exists) */
      const r = await api(CENTRAL, '/api/auth/login', { method: 'POST', body: { phone: ctx.req.username, password: ctx.req.password, name: 'removed-probe', platform: 'windows', device_pubkey: 'not-a-key' } });
      return r.status === 403 && r.json && r.json.error === 'school_removed' ? r : null;
    }, { every: 4000, what: 'login refused (school_removed) after delete' });
    const offMs = Date.now() - s;
    s = Date.now();
    const pw = 'Sim-R2-' + R + '!';
    ctx.idR2 = await owner.createSchool({ name: 'دبستان درخواستی (دوباره) ' + R, code: 'C' + R, manager: 'مدیر درخواستی', username: ctx.req.username, nid: nid('88173' + R), phone: '' }, pw);
    const on = await waitFor(async () => { const l = await appLogin(CENTRAL, ctx.req.username, pw); return tokenOf(l) ? l : null; }, { every: 3000, what: 'login on the re-created school' });
    const r = await pull(on.value.server, tokenOf(on.value));
    const name = ((r.json.collections || {}).schools || [])[0] || {};
    return { closed_after_ms: offMs, closed: off.value.status + '/' + (off.value.json && off.value.json.error), reopened_after_ms: Date.now() - s, school: name.name };
  });

  /* ── گزارش ── */
  let s3stats = null, front = null;
  try { s3stats = await (await fetch('http://s3:9000/__stats')).json(); } catch (e) { /* noop */ }
  try { front = await (await fetch(CENTRAL + '/__front')).json(); } catch (e) { /* noop */ }
  const passed = steps.filter(x => x.ok).length;
  const result = { at: new Date().toISOString(), version: ctx.version, total_ms: Date.now() - t0, passed, failed: steps.length - passed, steps, s3: s3stats, front };
  fs.writeFileSync(path.join(OUT, 'sim-result.json'), JSON.stringify(result, null, 2));
  const md = ['| گام | شرح | نتیجه | زمان (ms) | جزئیات |', '|---|---|---|---:|---|',
    ...steps.map(x => `| ${x.id} | ${x.fa} | ${x.ok ? 'PASS' : '**FAIL**'} | ${x.ms} | ${String(x.detail).replace(/\|/g, '\\|').slice(0, 400)} |`)].join('\n');
  fs.writeFileSync(path.join(OUT, 'SIM-REPORT.md'), `# شبیه‌سازی داکر — ${result.at}\n\nنسخهٔ سرور: ${ctx.version} · ${passed}/${steps.length} گام سبز · کل ${Math.round(result.total_ms / 1000)} ثانیه\n\n${md}\n`);
  console.log(`SIM-${passed === steps.length ? 'OK' : 'FAILED'} ${passed}/${steps.length} total ${Math.round(result.total_ms / 1000)} s`);
  process.exit(passed === steps.length ? 0 : 1);
})().catch((e) => { console.error('SIM-CRASH', e && e.stack || e); process.exit(2); });
