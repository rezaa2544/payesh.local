#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 205 — the apps of a school, against the REAL school server.
   Runs inside the school's network namespace (docker --network container:…),
   so the server sees it as the school LAN and /api/setup is allowed once.

     node load.js seed                  setup + manager + 12 classes + 360 students
                                        + 24 teachers; 4000 objects in the bucket
     node load.js phase NAME SECS DEVICES THINK_MS USAGE_EVERY_S
                                        every teacher device: push attendance (one class)
                                        → incremental pull → /api/me → /api/live/rev
                                        → think; the manager presses «فضای مصرفی»
                                        (POST /api/admin/helpers/usage = storage.usage job)
                                        every USAGE_EVERY_S seconds and opens the helpers card.
   Output: /out/<NAME>.json (latencies p50/p95/max by route, errors, the jobs and who
   did them, server SQLite/bucket counters before/after from the probe, /metrics).
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = process.env.REPO || '/repo';
const BASE = process.env.SCHOOL || 'http://127.0.0.1:8080';
const OUT = process.env.OUT_DIR || '/out';
const MGR = { phone: '09120000205', password: 'sim-205-pass' };

async function api(p, { method = 'GET', body, token, timeout = 60_000 } = {}) {
  const h = { accept: 'application/json' };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const s = performance.now();
  try {
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
    return { status: r.status, json, ms: performance.now() - s, text };
  } catch (e) {
    return { status: 0, json: { ok: false, error: String(e.cause ? e.cause.code || e.cause.message : e.message) }, ms: performance.now() - s, text: '' };
  }
}
const pubkey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
async function login(phone, password, name) {
  const r = await api('/api/auth/login', { method: 'POST', body: { phone, password, name, platform: 'android', device_pubkey: pubkey() } });
  if (!(r.status === 200 && r.json.ok)) throw new Error('login ' + phone + ': ' + r.status + ' ' + r.text.slice(0, 200));
  return r.json.session.token;
}
function nid(seed) {
  const s = String(seed).padStart(9, '0').slice(-9);
  let sum = 0; for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  const r = sum % 11; return s + String(r < 2 ? r : 11 - r);
}
let uidSeq = 0;
const uid = () => 'sim205-' + Date.now().toString(36) + '-' + process.pid + '-' + (++uidSeq);
const push = (token, ops) => api('/api/sync', { method: 'POST', token, body: { ops: ops.map(o => Object.assign({ uid: uid(), type: 'put' }, o)), idempotency_key: uid() } });
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1) : 0; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

function s3cfg() {
  const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
  return { s3mem, cfg: s3mem.normalize({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKey: process.env.S3_ACCESS_KEY, secret: process.env.S3_SECRET, region: process.env.S3_REGION || 'us-east-1', prefix: 'payesh/', pathStyle: true }) };
}

async function seed() {
  for (let i = 0; i < 200; i++) { const h = await api('/api/health'); if (h.status === 200) break; await sleep(500); }
  const st = await api('/api/setup', { method: 'POST', body: { manager_name: 'مدیر شبیه‌سازی', phone: MGR.phone, password: MGR.password, school_name: 'هنرستان شبیه‌سازی ۲۰۵', level: 'متوسطه دوم', school_type: 'کاردانش' } });
  if (!(st.status === 200 && st.json.ok) && !(st.json && st.json.error === 'already_setup')) throw new Error('setup: ' + st.status + ' ' + st.text.slice(0, 300));
  const T = await login(MGR.phone, MGR.password, 'sim-manager');
  const grades = ['دهم', 'یازدهم', 'دوازدهم'];
  const fields = ['الکتروتکنیک', 'حسابداری', 'کامپیوتر', 'معماری'];
  const cls = [];
  for (const g of grades) for (const f of fields) cls.push({ collection: 'classes', data: { name: g + ' ' + f, grade: g, branch: f } });
  const r1 = await push(T, cls);
  if (!(r1.status === 200 && (r1.json.applied || []).length === cls.length)) throw new Error('classes: ' + r1.text.slice(0, 300));
  const classIds = r1.json.applied.map(a => a.id);
  const teachers = [], students = [];
  for (let i = 0; i < 24; i++) teachers.push({ name: 'دبیر ' + (i + 1), role: 'teacher', phone: '0935' + String(2050000 + i).slice(-7), national_id: nid(205000000 + i) });
  for (let i = 0; i < 360; i++) {
    const c = i % classIds.length;
    students.push({ name: 'دانش‌آموز', last_name: 'شماره ' + (i + 1), role: 'student', phone: '0936' + String(2050000 + i).slice(-7), national_id: nid(205100000 + i), class_id: classIds[c], grade: grades[Math.floor(c / 4)], branch: fields[c % 4] });
  }
  const users = [...teachers, ...students];
  const ids = [];
  for (let i = 0; i < users.length; i += 60) {
    const r = await push(T, users.slice(i, i + 60).map(d => ({ collection: 'users', data: d })));
    if (!(r.status === 200 && (r.json.applied || []).length === Math.min(60, users.length - i))) throw new Error('users: ' + r.text.slice(0, 300));
    ids.push(...r.json.applied.map(a => a.id));
  }
  teachers.forEach((t, i) => { t.id = ids[i]; t.class_id = classIds[i % classIds.length]; });
  students.forEach((s, i) => { s.id = ids[teachers.length + i]; });
  const rs = await push(T, [{ collection: 'subjects', data: { name: 'کارگاه' } }]);
  const subjectId = rs.json.applied[0].id;
  const rsc = await push(T, teachers.map((t, i) => ({ collection: 'schedule', data: { class_id: t.class_id, teacher_id: t.id, subject_id: subjectId, weekday: i % 6, period: 1 + Math.floor(i / 12) } })));
  if (!(rsc.status === 200 && (rsc.json.applied || []).length === teachers.length)) throw new Error('schedule: ' + rsc.text.slice(0, 300));
  /* the bucket a real school has after months: mirror/backup objects (storage.usage lists them all) */
  const { s3mem, cfg } = s3cfg();
  const t0 = Date.now();
  const body = 'x'.repeat(2048);
  for (let i = 0; i < 4000; i += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, k) => s3mem.put(cfg, `payesh/mirror/sim205/${String(i + k).padStart(5, '0')}.json`, body)));
  }
  fs.writeFileSync(path.join(OUT, 'seed.json'), JSON.stringify({ classIds, teachers, students: students.map(s => ({ id: s.id, class_id: s.class_id })), bucket_objects: 4000, bucket_seed_ms: Date.now() - t0 }, null, 1));
  console.log(JSON.stringify({ ok: true, classes: classIds.length, teachers: teachers.length, students: students.length, bucket_objects: 4000 }));
}

async function metrics() {
  const r = await api('/metrics');
  const out = {};
  for (const line of String(r.text || '').split('\n')) {
    const m = /^(payesh_[a-z0-9_]+)(\{[^}]*\})?\s+([-0-9.eE+]+)$/.exec(line.trim());
    if (m && /route|db_|helper|event_loop|process_cpu|rss|heap|http_requests_total|sync/.test(m[1])) out[m[1] + (m[2] || '')] = Number(m[3]);
  }
  return out;
}

async function phase(name, secs, devices, think, usageEvery) {
  const seedInfo = readJson(path.join(OUT, 'seed.json'));
  const studentsByClass = new Map();
  for (const s of seedInfo.students) { if (!studentsByClass.has(s.class_id)) studentsByClass.set(s.class_id, []); studentsByClass.get(s.class_id).push(s.id); }
  for (let i = 0; i < 200; i++) { const h = await api('/api/health'); if (h.status === 200) break; await sleep(300); }
  for (let i = 0; i < 50 && !readJson(path.join(OUT, 'probe-school.json')); i++) await sleep(200);
  const mgr = await login(MGR.phone, MGR.password, 'sim-manager-' + name);
  const devs = [];
  for (let i = 0; i < devices; i++) {
    const t = seedInfo.teachers[i % seedInfo.teachers.length];
    devs.push({ t, token: await login(t.phone, t.national_id, 'sim-' + name + '-' + i), since: null });
  }
  const lat = {}, errs = {};
  const rec = (route, r) => {
    (lat[route] = lat[route] || []).push(r.ms);
    if (!(r.status === 200 || r.status === 304)) errs[route + ' ' + r.status + '/' + (r.json && r.json.error)] = (errs[route + ' ' + r.status + '/' + (r.json && r.json.error)] || 0) + 1;
  };
  const probe0 = readJson(path.join(OUT, 'probe-school.json'));
  const m0 = await metrics();
  const s3a = await (await fetch((process.env.S3_ENDPOINT || 'http://127.0.0.1:9000') + '/__stats')).json().catch(() => null);
  const t0 = Date.now(), end = t0 + secs * 1000;
  let rows = 0, day = 0;
  const loop = async (d, i) => {
    await sleep(Math.floor(Math.random() * Math.max(think, 200)));
    while (Date.now() < end) {
      const list = studentsByClass.get(d.t.class_id) || [];
      const date = '1405-08-' + String(1 + ((day++ + i) % 28)).padStart(2, '0');
      const ops = list.map(sid => ({ collection: 'attendance', data: { class_id: d.t.class_id, student_id: sid, date, status: Math.random() < 0.08 ? 'absent' : 'present' } }));
      const p = await push(d.token, ops); rec('POST /api/sync', p); if (p.status === 200) rows += (p.json.applied || []).length;
      const q = await api('/api/v1/pull' + (d.since ? '?since=' + encodeURIComponent(d.since) : ''), { token: d.token });
      rec('GET /api/v1/pull', q); if (q.status === 200 && q.json.server_time) d.since = q.json.server_time;
      rec('GET /api/me', await api('/api/me', { token: d.token }));
      rec('GET /api/live/rev', await api('/api/live/rev', { token: d.token }));
      if (think) await sleep(think * (0.5 + Math.random()));
    }
  };
  const jobs = [];
  const manager = async () => {
    let next = Date.now() + 3000;
    while (Date.now() < end) {
      if (Date.now() >= next) {
        next = Date.now() + usageEvery * 1000;
        const r = await api('/api/admin/helpers/usage', { method: 'POST', token: mgr, timeout: 90_000 });
        jobs.push({ at_s: +((Date.now() - t0) / 1000).toFixed(1), ms: Math.round(r.ms), status: r.status, ok: !!(r.json && r.json.ok), by: r.json && r.json.by, why: r.json && r.json.why || null, objects: r.json && r.json.result && (r.json.result.objects ?? r.json.result.count) });
        rec('POST /api/admin/helpers/usage', r);
      }
      const h = await api('/api/admin/helpers', { token: mgr });
      rec('GET /api/admin/helpers', h);
      await sleep(5000);
    }
  };
  await Promise.all([...devs.map((d, i) => loop(d, i)), manager()]);
  const wall = (Date.now() - t0) / 1000;
  await sleep(1500);   /* probe flushes every second */
  const probe1 = readJson(path.join(OUT, 'probe-school.json'));
  const m1 = await metrics();
  const s3b = await (await fetch((process.env.S3_ENDPOINT || 'http://127.0.0.1:9000') + '/__stats')).json().catch(() => null);
  const helpersCard = await api('/api/admin/helpers', { token: mgr });
  const routes = {};
  for (const [k, a] of Object.entries(lat)) routes[k] = { n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: pct(a, 100) };
  const dsql = probe0 && probe1 ? {
    statements: probe1.sql.statements - probe0.sql.statements, reads: probe1.sql.reads - probe0.sql.reads, writes: probe1.sql.writes - probe0.sql.writes,
    exec: probe1.sql.exec - probe0.sql.exec, ms: +(probe1.sql.ms - probe0.sql.ms).toFixed(1),
  } : null;
  const dnet = {};
  if (probe0 && probe1) for (const [k, v] of Object.entries(probe1.net.by_area)) { const d = v - (probe0.net.by_area[k] || 0); if (d) dnet[k] = d; }
  const cpu = probe0 && probe1 && probe0.cpu && probe1.cpu ? { user_ms: Math.round((probe1.cpu.user - probe0.cpu.user) / 1000), system_ms: Math.round((probe1.cpu.system - probe0.cpu.system) / 1000) } : null;
  const s3 = s3a && s3b ? { requests: s3b.requests - s3a.requests, by_method: Object.fromEntries(Object.keys(s3b.by_method).map(k => [k, s3b.by_method[k] - (s3a.by_method[k] || 0)]).filter(([, v]) => v)) } : null;
  const totalReq = Object.values(routes).reduce((a, r) => a + r.n, 0);
  const res = {
    name, secs: +wall.toFixed(1), devices, think_ms: think, usage_every_s: usageEvery,
    user_requests: totalReq, req_per_s: +(totalReq / wall).toFixed(1), attendance_rows: rows,
    routes, errors: errs, jobs,
    server: { sqlite: dsql, sqlite_per_req: dsql ? +(dsql.statements / totalReq).toFixed(2) : null, process_cpu: cpu, bucket_requests_by_server: dnet, bucket_requests_by_server_total: Object.values(dnet).reduce((a, b) => a + b, 0) },
    bucket_total: s3,
    metrics_after: m1, metrics_before: m0,
    helpers_card: helpersCard.json && { online: helpersCard.json.online, mode: helpersCard.json.mode, use_helpers: helpersCard.json.use_helpers, route: helpersCard.json.load && helpersCard.json.load.route, helpers: (helpersCard.json.helpers || []).map(h => ({ id: h.helper_id, online: h.online, done: h.done })) },
  };
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ name, req_per_s: res.req_per_s, sync_p95: routes['POST /api/sync'] && routes['POST /api/sync'].p95, jobs: jobs.map(j => j.by + ':' + (j.why || '') + ':' + j.ms), sqlite: dsql && dsql.statements, cpu, s3: s3 && s3.requests }));
}

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'seed') return seed();
  if (cmd === 'phase') return phase(a[0], Number(a[1] || 60), Number(a[2] || 12), Number(a[3] || 1000), Number(a[4] || 20));
  throw new Error('usage: load.js seed | phase NAME SECS DEVICES THINK_MS USAGE_EVERY_S');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
