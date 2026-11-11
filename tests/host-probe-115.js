#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 115 — host probe (tools/host-probe.mjs + tools/host-probe-form.html).

     HP-01  Node version gate (≥ 22.5) and node:sqlite detection (incl. flag path)
     HP-02  disk persistence marker: first run ?, same process ?, new process warn,
            new boot pass, /tmp fail, unwritable fail
     HP-03  always-on heartbeats: < 30 min ?, continuous pass, gap fail, stale tail fail
     HP-04  PostgreSQL probe against a fake server: the ONLY pre-TLS bytes are the
            8-byte SSLRequest; no user/password/db ever on the wire; TLS ok → pass,
            unknown CA → warn, 'N' → fail, closed port → fail, no target → ? NOT-RUN
     HP-05  redaction: env secret values, URL userinfo, key=value, JWT, token prefixes;
            a full runProbe never prints a secret placed in env / --pg-host
     HP-06  report contract: every CHECK_ID once, label ∈ {M,?}, unknown ⇔ '?'
     HP-07  HTTPS + Cloudflare signals (D-09) and verdict logic
     HP-08  serve mode: key gate, RTL HTML without scripts, /probe.json, 405, 410 TTL
     HP-09  owner form: Persian-digit panel parsing, labels, redaction, raw paste never
            in output, verdict parity with the CLI tool, no network APIs, strict CSP
     HP-10  Persian checklist doc + static no-credentials checks
     HP-11  mutants: each reverted control turns its check red
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools/host-probe.mjs');
const FORM = path.join(ROOT, 'tools/host-probe-form.html');
const START = path.join(ROOT, 'tools/host-probe-start.cjs');
const DOC = path.join(ROOT, 'docs/cloud/115-host-probe.md');
const SECRET = 'Zq9-very-secret-pw';

let passed = 0, failed = 0, negatives = 0, quiet = false;
const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; if (!quiet) console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const tmpDirs = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
const notTmp = { isTmp: () => false };
const byId = r => Object.fromEntries(r.checks.map(c => [c.id, c]));

/* ── suites (take the module so mutants can be run through them) ── */
function suiteVersion(m) {
  assert(m.checkNodeVersion('22.4.9').status === 'fail', '22.4.9 must fail');
  assert(m.checkNodeVersion('20.18.0').status === 'fail', '20 must fail');
  assert(m.checkNodeVersion('22.5.0').status === 'pass', '22.5.0 must pass');
  assert(m.checkNodeVersion('v24.1.0').status === 'pass', '24 must pass');
  const g = m.checkNodeVersion('garbage'); assert(g.status === 'unknown' && g.label === '?', 'garbage → ?');
}
async function suiteSqlite(m) {
  const ok = await m.checkNodeSqlite(async () => ({ DatabaseSync: function () {} }));
  assert(ok.status === 'pass' && ok.value.needs_flag === false, 'module present → pass');
  const flag = await m.checkNodeSqlite(async () => { throw Object.assign(new Error('x'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }); }, () => true);
  assert(flag.status === 'pass' && flag.value.needs_flag === true, 'flag path → pass needs_flag');
  const none = await m.checkNodeSqlite(async () => { throw new Error('no'); }, () => { throw new Error('no'); });
  assert(none.status === 'fail' && none.label === 'M', 'absent → fail');
}
function suitePersistence(m) {
  const d = tmp('hp115-p-');
  const a = m.checkPersistence(d, Object.assign({ pid: 1, bootId: 'B1' }, notTmp));
  assert(a.status === 'unknown' && a.label === '?', 'first run must be ? (got ' + a.status + ')');
  const b = m.checkPersistence(d, Object.assign({ pid: 1, bootId: 'B1' }, notTmp));
  assert(b.status === 'unknown', 'same process must stay ?');
  const c = m.checkPersistence(d, Object.assign({ pid: 2, bootId: 'B1' }, notTmp));
  assert(c.status === 'warn' && c.label === 'M', 'new process, same boot → warn (got ' + c.status + ')');
  const e = m.checkPersistence(d, Object.assign({ pid: 3, bootId: 'B2' }, notTmp));
  assert(e.status === 'pass' && e.value.survived === 'host_reboot', 'new boot → pass');
  const t = m.checkPersistence(tmp('hp115-t-'), { pid: 1, bootId: 'B1', isTmp: () => true });
  assert(t.status === 'fail', '/tmp data dir must fail');
  const f = path.join(tmp('hp115-f-'), 'file'); fs.writeFileSync(f, 'x');
  const u = m.checkPersistence(f, Object.assign({ pid: 1, bootId: 'B1' }, notTmp));
  assert(u.status === 'fail', 'unwritable must fail');
  const raw = fs.readFileSync(path.join(d, '.payesh-probe', 'marker.json'), 'utf8');
  assert(!raw.includes('B1') && !raw.includes('B2'), 'boot id must be stored hashed only');
}
function suiteHeartbeat(m) {
  const t0 = 1_700_000_000_000; const min = 60000;
  const short = Array.from({ length: 10 }, (_, i) => t0 + i * min);
  assert(m.analyzeHeartbeats(short, t0 + 10 * min, 1, 1).status === 'unknown', '< 30 min → ?');
  const cont = Array.from({ length: 61 }, (_, i) => t0 + i * min);
  const p = m.analyzeHeartbeats(cont, t0 + 61 * min, 1, 1);
  assert(p.status === 'pass' && p.label === 'M', 'continuous → pass (got ' + p.status + ')');
  const gap = cont.filter(x => x < t0 + 20 * min || x > t0 + 35 * min);
  const g = m.analyzeHeartbeats(gap, t0 + 61 * min, 1, 1);
  assert(g.status === 'fail' && g.value.gaps >= 1, 'gap → fail (got ' + g.status + ')');
  const stale = m.analyzeHeartbeats(cont, t0 + 200 * min, 1, 1);
  assert(stale.status === 'fail', 'stale tail → fail');
}

function makeCert() {
  const d = tmp('hp115-c-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(d, 'k.pem')), cert: fs.readFileSync(path.join(d, 'c.pem')) };
}
/* fake PostgreSQL: records every pre-TLS byte, answers 'S' (or 'N'), then speaks TLS */
function fakePg(mode, cert) {
  const seen = { pre: [], tlsBytes: 0 };
  const srv = net.createServer(sock => {
    sock.once('data', buf => {
      seen.pre.push(Buffer.from(buf));
      if (mode === 'N') { sock.write('N'); sock.end(); return; }
      sock.write('S');
      const ts = new tls.TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert });
      ts.on('data', b => { seen.tlsBytes += b.length; });
      ts.on('error', () => {});
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, port: srv.address().port })));
}
async function suitePg(m, cert) {
  const s = await fakePg('S', cert);
  try {
    const target = m.parsePgTarget(`postgres://admin:${SECRET}@127.0.0.1:${s.port}/schooldb`);
    assert(target && target.host === '127.0.0.1' && target.port === s.port && !JSON.stringify(target).includes(SECRET), 'userinfo must be dropped');
    const r1 = await m.pgTlsProbe(target, { timeoutMs: 4000 });
    const c1 = m.checkOutboundPg(target, r1);
    assert(r1.ok && c1.status === 'warn', 'self-signed without CA → warn (got ' + c1.status + '/' + r1.stage + ')');
    const r2 = await m.pgTlsProbe(target, { timeoutMs: 4000, ca: cert.cert });
    const c2 = m.checkOutboundPg(target, r2);
    assert(c2.status === 'pass' && c2.label === 'M', 'trusted CA → pass (got ' + c2.status + ')');
    const pre = Buffer.concat(s.seen.pre);
    assert(s.seen.pre.length === 2 && s.seen.pre.every(b => b.equals(m.PG_SSL_REQUEST)), 'pre-TLS bytes must be exactly the SSLRequest');
    assert(!pre.includes('admin') && !pre.includes(SECRET) && !pre.includes('schooldb'), 'no creds on the wire');
    assert(s.seen.tlsBytes === 0, 'no application data after TLS (got ' + s.seen.tlsBytes + ' bytes)');
    assert(!JSON.stringify(c2).includes('127.0.0.1'), 'host must appear only as hash');
  } finally { s.srv.close(); }
  const n = await fakePg('N', cert);
  try {
    const t = { host: '127.0.0.1', port: n.port };
    const c = m.checkOutboundPg(t, await m.pgTlsProbe(t, { timeoutMs: 4000 }));
    assert(c.status === 'fail' && c.value.stage === 'ssl_refused', "'N' → fail");
  } finally { n.srv.close(); }
  const closed = await new Promise(r => { const x = net.createServer(); x.listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => r(p)); }); });
  const cc = m.checkOutboundPg({ host: '127.0.0.1', port: closed }, await m.pgTlsProbe({ host: '127.0.0.1', port: closed }, { timeoutMs: 3000 }));
  assert(cc.status === 'fail' && cc.value.stage === 'tcp', 'closed port → fail tcp');
  const nr = m.checkOutboundPg(null);
  assert(nr.status === 'unknown' && nr.label === '?' && /NOT-RUN/.test(nr.detail_fa), 'no target → ? NOT-RUN');
}
function suiteRedact(m) {
  const env = { DATABASE_URL: 'postgres://u:' + SECRET + '@db.example/x', HOME: '/home/x' };
  const cases = [
    ['value ' + env.DATABASE_URL, SECRET], ['see https://bob:hunter2pass@h.example/p', 'hunter2pass'],
    ['password=Abc123xyz&x=1', 'Abc123xyz'], ['token: tkn_very_long_value', 'tkn_very_long_value'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N'],
    ['ghp_ABCDEFGHIJKLMNOPQRSTUVWX', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX'],
  ];
  for (const [inp, bad] of cases) { const r = m.redactString(inp, env); assert(!r.text.includes(bad) && r.hits > 0, 'leaked: ' + bad); }
  assert(m.redactString('/home/x', env).text === '/home/x', 'non-sensitive env must stay');
}
async function suiteFullRun(m) {
  const d = tmp('hp115-r-');
  const env = { PATH: process.env.PATH, PAYESH_DATA: d, DATABASE_URL: 'postgres://u:' + SECRET + '@127.0.0.1:1/db', PAYESH_PROBE_PG_HOST: 'postgres://u:' + SECRET + '@127.0.0.1:1/db' };
  const r = await m.runProbe({ env, network: true, updateHost: '127.0.0.1', timeoutMs: 2000, persistenceCtx: notTmp });
  const txt = JSON.stringify(r);
  assert(!txt.includes(SECRET), 'secret leaked in report');
  assert(r.redaction && r.redaction.applied === true, 'redaction block missing');
  return r;
}
function suiteContract(m, r) {
  const ids = r.checks.map(c => c.id);
  assert(JSON.stringify(ids.slice().sort()) === JSON.stringify(m.CHECK_IDS.slice().sort()) && new Set(ids).size === ids.length, 'check ids mismatch: ' + ids.join(','));
  for (const c of r.checks) {
    assert(m.LABELS.includes(c.label), c.id + ' bad label ' + c.label);
    assert(['pass', 'warn', 'fail', 'unknown'].includes(c.status), c.id + ' bad status');
    assert((c.status === 'unknown') === (c.label === '?'), c.id + ': unknown ⇔ ? violated (' + c.status + '/' + c.label + ')');
    assert(typeof c.title_fa === 'string' && /[\u0600-\u06FF]/.test(c.title_fa), c.id + ' needs Persian title');
  }
  assert(r.schema === m.SCHEMA && /^[0-9a-f]{8}$/.test(r.host_id_hash), 'schema/host hash');
  assert(byId(r).outbound_tls_pg.status === 'fail', 'pg on closed port must be measured fail');
}
function suiteHttpsVerdict(m) {
  assert(m.checkHttps({ via: 'request', forwardedProto: 'https' }).status === 'pass', 'https request → pass');
  assert(m.checkHttps({ via: 'request', forwardedProto: 'http' }).status === 'fail', 'http request → fail');
  const cf = m.checkHttps({ via: 'request', forwardedProto: 'https', headers: { 'cf-ray': 'abc' } });
  assert(cf.status === 'fail' && cf.value.cloudflare_signals.includes('cf-ray'), 'Cloudflare must fail (D-09)');
  assert(m.checkHttps({ via: 'public_url', status: 200, authorized: true, headers: { server: 'cloudflare' } }).status === 'fail', 'server:cloudflare must fail');
  assert(m.checkHttps({}).label === '?', 'not run → ?');
  const mk = (id, status) => ({ id, status, label: status === 'unknown' ? '?' : 'M' });
  const all = ['node_version', 'node_sqlite', 'disk_persistence', 'always_on', 'https'].map(i => mk(i, 'pass')).concat([mk('outbound_tls_pg', 'pass'), mk('local_postgres', 'unknown')]);
  assert(m.verdict(all).gateway_on_this_host === 'ready', 'all pass → ready');
  const bad = all.map(c => c.id === 'disk_persistence' ? mk(c.id, 'fail') : c);
  assert(m.verdict(bad).gateway_on_this_host === 'not_ready' && m.verdict(bad).blockers.includes('disk_persistence'), 'fail → not_ready');
  const nopg = all.map(c => c.id === 'outbound_tls_pg' || c.id === 'local_postgres' ? mk(c.id, 'fail') : c);
  assert(m.verdict(nopg).blockers.includes('postgres_reachable'), 'no PG path → blocker');
  const unk = all.map(c => c.id === 'always_on' ? mk(c.id, 'unknown') : c);
  assert(m.verdict(unk).gateway_on_this_host === 'incomplete', 'unknown → incomplete');
}
function get(port, p, headers, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET', headers: headers || {} }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject); req.end();
  });
}
async function suiteServe(m) {
  const d = tmp('hp115-s-');
  const s = await m.serve({ env: { PATH: process.env.PATH, PAYESH_PROBE_KEY: 'k-123456' }, dataDir: d, port: 0, bind: '127.0.0.1', network: false, persistenceCtx: notTmp, heartbeatMs: 3600000 });
  const port = s.address().port;
  try {
    assert((await get(port, '/')).status === 403, 'missing key must be 403');
    assert((await get(port, '/?key=wrong')).status === 403, 'wrong key must be 403');
    const h = await get(port, '/?key=k-123456', { 'x-forwarded-proto': 'https' });
    assert(h.status === 200 && /dir="rtl"/.test(h.body) && /Content-Security-Policy/.test(h.body) && !/<script/i.test(h.body), 'html report');
    assert(h.headers['cache-control'] === 'no-store', 'no-store');
    const j = await get(port, '/probe.json?key=k-123456', { 'x-forwarded-proto': 'https' });
    const r = JSON.parse(j.body); const b = byId(r);
    assert(r.mode === 'serve' && b.https.status === 'pass' && b.port.status === 'pass', 'serve report https/port');
    const j2 = JSON.parse((await get(port, '/probe.json?key=k-123456')).body);
    assert(byId(j2).https.status === 'fail', 'plain http → https fail');
    assert(!j.body.includes('k-123456'), 'probe key must be redacted');
    assert((await get(port, '/?key=k-123456', {}, 'POST')).status === 405, 'POST → 405');
    assert(fs.readFileSync(path.join(d, '.payesh-probe', 'heartbeat.log'), 'utf8').trim().length > 0, 'heartbeat written');
  } finally { await new Promise(r => s.close(r)); }
  const s2 = await m.serve({ env: {}, dataDir: d, port: 0, bind: '127.0.0.1', network: false, ttlHours: -1, heartbeatMs: 3600000 });
  try { assert((await get(s2.address().port, '/')).status === 410, 'expired → 410'); } finally { await new Promise(r => s2.close(r)); }
}
function loadForm(html) {
  const mm = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(mm, 'form script missing');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(mm[1], ctx);
  return ctx;
}
function suiteForm(m, html) {
  assert(!/(fetch\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.|https?:\/\/)/.test(html.replace(/<p[\s\S]*?<\/p>/g, '')), 'form must not use network APIs or remote URLs');
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert(/default-src 'none'/.test(csp) && !/unsafe-eval|https?:/.test(csp), 'strict CSP');
  const f = loadForm(html);
  const p = f.parsePanelText('نسخه Node.js: ۲۲.۱۱.۰\nRAM: 1 GB\nDisk space 10 GB SSD\n2 vCPU');
  assert(p.node === '22.11.0' && p.mem === 1024 && p.disk === 10 && p.cpu === 2, 'panel parse: ' + JSON.stringify(p));
  const p2 = f.parsePanelText('حافظه ۵۱۲ مگابایت — دیسک ۵۰۰ مگ');
  assert(p2.mem === 512 && p2.disk === 0.5, 'Persian units: ' + JSON.stringify(p2));
  const rep = f.buildFormReport({ panel: 'DirectAdmin', node: '22.11', mem: '1024', cpu: '1', disk: '10', persist: 'yes', always: 'no', https: 'yes', pglocal: 'unknown', pgout: 'yes', logs: 'unknown', backup: 'yes',
    notes: 'db is postgres://root:' + SECRET + '@x/y and password=' + SECRET }, '2026-11-11T00:00:00Z');
  const txt = JSON.stringify(rep);
  assert(!txt.includes(SECRET), 'form leaked secret');
  assert(rep.source === 'owner_panel' && rep.redaction.raw_paste_included === false, 'form source/redaction');
  const b = byId(rep);
  for (const c of rep.checks) { assert(['M', '?'].includes(c.label), 'form label'); assert((c.status === 'unknown') === (c.label === '?'), 'form ⇔ ' + c.id); }
  assert(b.always_on.status === 'fail' && b.node_version.status === 'pass' && b.node_sqlite.label === '?', 'form mapping');
  assert(b.backup.status === 'warn', 'backup "yes" must stay warn without restore drill');
  assert(JSON.stringify(rep.checks.map(c => c.id).sort()) === JSON.stringify(m.CHECK_IDS.slice().sort()), 'form must cover same CHECK_IDS');
  assert(JSON.stringify(rep.verdict) === JSON.stringify(m.verdict(rep.checks)), 'verdict parity form ↔ tool');
  const old = byId(f.buildFormReport({ node: '20.11.1' }));
  assert(old.node_version.status === 'fail' && old.node_sqlite.status === 'fail', 'old node in form → fail');
}

const MUTANTS = [
  ['M1 node minimum lowered', s => s.replace('NODE_MIN = [22, 5, 0]', 'NODE_MIN = [22, 0, 0]'), m => suiteVersion(m)],
  ['M2 /tmp data dir accepted', s => s.replace('if (tmpLike) return', 'if (false) return'), m => suitePersistence(m)],
  ['M3 process restart counted as reboot', s => s.replace('if (rebooted) return', 'if (rebooted || restarted) return'), m => suitePersistence(m)],
  ['M4 heartbeat gaps ignored', s => s.replace('if (g > GAP_MS) { gaps++; }', ''), m => suiteHeartbeat(m)],
  ['M5 URL userinfo not redacted', s => s.replace("rep(/([a-z][a-z0-9+.-]*:\\/\\/)([^\\s/@:\"]+):([^\\s/@\"]+)@/gi", "rep(/NEVERMATCH/g"), m => suiteRedact(m)],
  ['M6 Cloudflare ignored', s => s.replace('if (cf.length) {', 'if (false) {'), m => suiteHttpsVerdict(m)],
  ['M7 blockers ignored in verdict', s => s.replace("const state = blockers.length ? 'not_ready'", "const state = false ? 'not_ready'"), m => suiteHttpsVerdict(m)],
  ['M8 probe key not enforced', s => s.replace("if (key && u.searchParams.get('key') !== key)", 'if (false)'), m => suiteServe(m)],
  ['M9 extra bytes before TLS', s => s.replace('sock.write(PG_SSL_REQUEST);', "sock.write(PG_SSL_REQUEST); sock.write('user=admin');"), (m, cert) => suitePg(m, cert)],
  ['M10 sqlite flag failure reported as pass', s => s.replace("return check('node_sqlite', 'ماژول node:sqlite', 'M', 'fail', { available: false }", "return check('node_sqlite', 'ماژول node:sqlite', 'M', 'pass', { available: false }"), m => suiteSqlite(m)],
];

async function main(opts) {
  quiet = !!(opts && opts.quiet);
  passed = 0; failed = 0; negatives = 0; failures.length = 0;
  const m = await import(pathToFileURL(TOOL).href);
  let cert = null;
  try { cert = makeCert(); } catch (_) { cert = null; }
  await check('HP-01', 'Node ≥ 22.5 gate + node:sqlite (module / flag / absent)', async () => { suiteVersion(m); await suiteSqlite(m); });
  await check('HP-02', 'disk persistence marker (first ?, restart warn, reboot pass, /tmp fail)', () => suitePersistence(m));
  await check('HP-03', 'always-on heartbeats (<30m ?, continuous pass, gap/stale fail)', () => suiteHeartbeat(m));
  await check('HP-04', 'PG probe: only SSLRequest pre-TLS, no creds, TLS pass/warn, N/closed fail, NOT-RUN', async () => {
    if (!cert) throw new Error('openssl unavailable — cannot build fake TLS server');
    await suitePg(m, cert);
  });
  await check('HP-05', 'redaction rules + full run never prints secrets', async () => { suiteRedact(m); await suiteFullRun(m); });
  let full = null;
  await check('HP-06', 'report contract (ids, labels, unknown ⇔ ?)', async () => { full = await suiteFullRun(m); suiteContract(m, full); return full.checks.length + ' checks'; });
  await check('HP-07', 'HTTPS + Cloudflare (D-09) + verdict', () => suiteHttpsVerdict(m));
  await check('HP-08', 'serve mode: key gate, RTL no-script HTML, JSON, 405, 410', () => suiteServe(m));
  const html = fs.readFileSync(FORM, 'utf8');
  await check('HP-09', 'owner form: parsing, labels, redaction, verdict parity, no network', () => suiteForm(m, html));
  await check('HP-10', 'Persian checklist doc + start file + static no-credential checks', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    for (const k of ['host-probe.mjs', '--serve', 'host-probe-form.html', 'host-probe-start.cjs', '--pg-host', '۱۱۶', '[M]', '[?]', 'رمز']) assert(doc.includes(k), 'doc missing ' + k);
    assert((doc.match(/[\u0600-\u06FF]/g) || []).length > 1000, 'doc must be Persian');
    const start = fs.readFileSync(START, 'utf8'); assert(/host-probe\.mjs/.test(start) && /--serve/.test(start), 'start file');
    const src = fs.readFileSync(TOOL, 'utf8');
    assert(!/JSON\.stringify\(\s*(process\.)?env\b/.test(src), 'tool must never dump env');
    assert(!/\b(user|password)\s*:\s*['"][^'"]+['"]/.test(src), 'no hard-coded credentials');
    assert(!/postgres(ql)?:\/\/[^\s'"]*:[^\s'"]*@/.test(src + html + doc), 'no credentialed URL in files');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(x => x[1]);
    assert(imports.every(i => ['os', 'fs', 'path', 'net', 'tls', 'http', 'https', 'crypto', 'child_process', 'url'].includes(i)), 'zero-dependency: ' + imports.join(','));
  });
  await check('HP-11', 'mutants: each reverted control turns red', async () => {
    const src = fs.readFileSync(TOOL, 'utf8'); const dir = tmp('hp115-m-'); const missed = [];
    for (let i = 0; i < MUTANTS.length; i++) {
      const [name, mut, suite] = MUTANTS[i];
      const ms = mut(src); if (ms === src) throw new Error(name + ': mutation did not apply');
      const f = path.join(dir, 'mut' + i + '.mjs'); fs.writeFileSync(f, ms);
      const mm = await import(pathToFileURL(f).href);
      let red = false;
      try { await suite(mm, cert); } catch (_e) { red = true; if (process.env.HP_DEBUG) console.log("   " + name + " -> " + _e.message); }
      if (red) negatives++; else missed.push(name);
    }
    if (missed.length) throw new Error('mutants survived: ' + missed.join('; '));
    return negatives + '/' + MUTANTS.length + ' killed';
  });
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } }
  return { passed, failed, negatives, failures: failures.slice() };
}

module.exports = { main };
if (require.main === module) {
  main().then(r => {
    console.log(`\nHOST-PROBE-115 ${r.failed ? 'FAILED' : 'OK'} passed=${r.passed} failed=${r.failed} negative_controls=${r.negatives}`);
    process.exit(r.failed ? 1 : 0);
  }, e => { console.error(e); process.exit(1); });
}
