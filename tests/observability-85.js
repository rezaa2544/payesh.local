'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Server-side observability — row 85          (OB85-01 .. OB85-12)

   What is real:
     • the product server (server/index.js) runs as a separate process with a
       real SQLite database, seeded by server/seed.js, logging enabled;
     • every request goes over real HTTP; the test reads the server's actual
       stdout/stderr, not a mock logger;
     • /metrics is the same Prometheus text a scraper reads; the SLO alert rules
       (deploy/monitoring/slo-85.yml) are evaluated by the same evaluator as row
       49 (tools/alerts-49.mjs) against a scrape;
     • the negative controls are real: PII sent in query, path, header and body
       must not appear in the log, a planted PII line must turn the gate red,
       and mutated copies of server/logger.js (redaction off, allowlist off,
       request-id check off) must be caught.

   Not claimed: delivery to a real external pager/on-call (D-42 → OWNER).

   Run: npm run test:observability85
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];
const LOGGER = path.join(ROOT, 'server', 'logger.js');
const SCAN = path.join(ROOT, 'tools', 'log-pii-scan-85.mjs');
const ALERTS = path.join(ROOT, 'tools', 'alerts-49.mjs');
const RULES = path.join(ROOT, 'deploy', 'monitoring', 'slo-85.yml');
const DOC = path.join(ROOT, 'docs', 'cloud', '85-observability-slo.md');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ob85-'));

const slo = require(path.join(ROOT, 'server', 'slo.js'));
const metrics = require(path.join(ROOT, 'server', 'metrics.js'));

let passed = 0, failed = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 400)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* PII samples (synthetic, valid-looking). Never real people. */
const NID = '0012345679';
const NID_FA = '۰۰۱۲۳۴۵۶۷۹';
const PHONE = '09121234567';
const EMAIL = 'parent.ob85@example.org';
const NAME = 'Zoya-Ob85-Fullname';

/* ───────────────────────── logger unit checks ─────────────────────────
   Parametrised by module path, so the same checks run against mutants. */
function freshRequire(p) { delete require.cache[require.resolve(p)]; return require(p); }

function loggerUnit(modPath) {
  const L = freshRequire(modPath);
  const out = [];
  /* 1) redaction of values that do pass the allowlist */
  const line = JSON.stringify(L.build('info', 'http', {
    request_id: 'ob85-unit-0001', school_id: 7,
    path: '/api/students/' + NID_FA,
    detail: `x ${PHONE} ${EMAIL} Bearer abcdefghijklmnop12345 ${'a'.repeat(48)} national_code=${NID}`,
  }));
  const hits = L.scanPii(line);
  if (hits.length) out.push('redaction leaked ' + hits.map(h => h.kind).join(','));
  /* 2) allowlist: non-allowlisted keys (name, body, phone) never reach the line */
  const obj = L.build('info', 'http', { request_id: 'ob85-unit-0002', full_name: NAME, body: { national_code: NID }, phone: PHONE });
  const txt = JSON.stringify(obj);
  if (txt.includes(NAME) || 'full_name' in obj || 'body' in obj || 'phone' in obj) out.push('allowlist bypassed');
  if (obj.dropped_keys !== 3) out.push('dropped_keys=' + obj.dropped_keys);
  /* 3) reserved keys cannot be forged */
  const f = L.build('info', 'real', { event: 'forged', level: 'debug' });
  if (f.event !== 'real' || f.level !== 'info') out.push('reserved key forged');
  /* 4) request id: opaque accepted, PII-shaped / malformed replaced */
  const UUID = /^[0-9a-f-]{36}$/;
  if (L.requestId({ 'x-request-id': 'ci-trace.0001' }) !== 'ci-trace.0001') out.push('opaque id not echoed');
  for (const bad of [PHONE, NID, 'has space x', 'a'.repeat(65), EMAIL, 'short']) {
    if (!UUID.test(L.requestId({ 'x-request-id': bad }))) out.push('request id not replaced for a ' + (bad.length) + '-char value');
  }
  return out;
}

/* ───────────────────────── net / process helpers ───────────────────────── */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function req(port, method, urlPath, { headers = {}, body = null, raw = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? Buffer.from(raw) : (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const h = Object.assign({ connection: 'close' }, headers);
    if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h, agent: false }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch (e) { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf, json });
      });
    });
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitFor(fn, ms = 25000, step = 100) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await sleep(step);
  }
  throw new Error('timeout' + (last ? ': ' + last.message : ''));
}

/* ───────────────────────── Prometheus helpers ───────────────────────── */
function metricValue(text, name) {
  const re = new RegExp('^' + name + '(?:\\{[^}]*\\})?\\s+(-?[0-9.eE+-]+)$', 'm');
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}
function runAlerts(metricsText, extra = []) {
  const f = path.join(WORK, 'scrape-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(f, metricsText);
  const r = spawnSync(process.execPath, [ALERTS, '--rules', RULES, '--metrics-file', f, ...extra], { encoding: 'utf8', cwd: ROOT, timeout: 30000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

(async () => {
  console.log('\nRow 85: server observability (JSON logs without PII, /metrics, SLO, alerts)\n');

  /* ── OB85-01: logger unit on the real module ─────────────────────── */
  await check('OB85-01', 'logger: allowlist drops non-allowlisted keys, values redacted (incl. Persian digits), reserved keys unforgeable, request id sanitised', async () => {
    const errs = loggerUnit(LOGGER);
    assert(errs.length === 0, errs.join('; '));
    return 'clean';
  });

  /* ── OB85-02: mutation controls on copies of logger.js ───────────── */
  await check('OB85-02', 'negative (mutants): redaction off / allowlist off / request-id check off ⇒ each caught by OB85-01 checks', async () => {
    const src = fs.readFileSync(LOGGER, 'utf8');
    const muts = [
      ['redaction-off', 'let out = normDigits(s);', 'let out = String(s); void 0; /* mutant */ return { text: out, n: 0 };'],
      ['allowlist-off', 'if (!SAFE_KEYS.has(k)) { dropped++; continue; }', 'void 0; /* mutant */'],
      ['request-id-check-off', 'if (RID_RE.test(h) && scanPii(h).length === 0) return h;', 'if (h) return h; void 0; /* mutant */'],
    ];
    const res = [];
    for (const [name, a, b] of muts) {
      assert(src.split(a).length === 2, 'mutation anchor not unique/absent: ' + name);
      const dir = fs.mkdtempSync(path.join(WORK, 'mut-'));
      const p = path.join(dir, 'logger.js');
      fs.writeFileSync(p, src.replace(a, b));
      const errs = loggerUnit(p);
      assert(errs.length > 0, 'mutant survived: ' + name);
      res.push(name + ':killed');
    }
    /* baseline: an unmodified copy passes (the harness itself is not always red) */
    const dir = fs.mkdtempSync(path.join(WORK, 'base-'));
    fs.writeFileSync(path.join(dir, 'logger.js'), src);
    assert(loggerUnit(path.join(dir, 'logger.js')).length === 0, 'baseline copy failed');
    return res.join(' ') + ' baseline:clean';
  });

  /* ── real server ─────────────────────────────────────────────────── */
  const dataDir = path.join(WORK, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    PAYESH_DATA: dataDir, PAYESH_LOG: '1', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
  });
  const seed = spawnSync(process.execPath, [...FLAGS, 'server/seed.js', '--fresh'], { cwd: ROOT, env: Object.assign({}, env, { PAYESH_LOG: '0' }), encoding: 'utf8' });
  const adminCode = (String(seed.stdout).match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0];
  const port = await freePort();
  const child = spawn(process.execPath, [...FLAGS, 'server/index.js'], {
    cwd: ROOT, env: Object.assign({}, env, { PORT: String(port), HOST: '127.0.0.1' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const stop = () => new Promise(r => { if (child.exitCode != null) return r(); child.once('exit', r); try { child.kill('SIGKILL'); } catch (e) { r(); } });

  const sent = {};
  try {
    await waitFor(async () => (await req(port, 'GET', '/healthz')).status === 200);

    await check('OB85-03', 'every /api response carries X-Request-Id; an opaque caller id is echoed, a PII-shaped one is replaced', async () => {
      assert(adminCode, 'seed gave no admin code');
      const a = await req(port, 'GET', '/api/health', { headers: { 'x-request-id': 'ob85-trace-health-01' } });
      assert(a.headers['x-request-id'] === 'ob85-trace-health-01', 'echo ' + a.headers['x-request-id']);
      const b = await req(port, 'GET', '/api/health', { headers: { 'x-request-id': PHONE } });
      assert(/^[0-9a-f-]{36}$/.test(b.headers['x-request-id'] || ''), 'phone-shaped id not replaced');
      sent.minted = b.headers['x-request-id'];
      assert(String(a.headers['access-control-expose-headers'] || '').includes('x-request-id'), 'x-request-id not exposed to browsers');
      return 'echo ok · minted ' + sent.minted.slice(0, 8) + '…';
    });

    await check('OB85-04', 'authenticated request: JSON access line with request_id + school_id (from session) + auth/role; no query string', async () => {
      const pair = await req(port, 'POST', '/api/auth/pair', { body: { code: adminCode } });
      assert(pair.status === 200 && pair.json && pair.json.session, 'pair ' + pair.status);
      sent.token = pair.json.session.token;
      const r = await req(port, 'GET', `/api/v1/pull?since=1970-01-01T00:00:00.000Z&national_code=${NID}&phone=${PHONE}&email=${encodeURIComponent(EMAIL)}`,
        { headers: { authorization: 'Bearer ' + sent.token, 'x-request-id': 'ob85-trace-pull-01' } });
      assert(r.status === 200, 'pull ' + r.status);
      /* the response really contains student data — so a leak would be possible */
      sent.pullBytes = r.text.length;
      await sleep(150);
      const lines = out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
      const m = lines.find(l => l.event === 'http' && l.request_id === 'ob85-trace-pull-01');
      assert(m, 'no access line for the pull');
      assert(m.school_id === 1 && m.auth === true && m.role, 'school/auth/role ' + JSON.stringify(m));
      assert(m.path === '/api/v1/pull' && m.status === 200 && typeof m.ms === 'number', JSON.stringify(m));
      assert(m.service === 'payesh-local' && m.level === 'info' && !Number.isNaN(Date.parse(m.ts)), 'envelope ' + JSON.stringify(m));
      const h = lines.find(l => l.request_id === 'ob85-trace-health-01');
      assert(h && h.school_id === null && h.auth === false, 'unauthenticated line ' + JSON.stringify(h));
      return `school_id=${m.school_id} role=${m.role} pull_bytes=${sent.pullBytes}`;
    });

    await check('OB85-05', 'PII in path/header/body/query and a bad-JSON body ⇒ responses served, nothing PII-shaped written', async () => {
      const auth = { authorization: 'Bearer ' + sent.token };
      const codes = [];
      codes.push((await req(port, 'GET', '/api/students/' + NID, { headers: Object.assign({ 'x-request-id': 'ob85-trace-path-01' }, auth) })).status);
      codes.push((await req(port, 'GET', '/api/students/' + encodeURIComponent(NID_FA), { headers: auth })).status);
      codes.push((await req(port, 'POST', '/api/auth/pair', { body: { code: 'ZZZZ-ZZZZ', national_code: NID, phone: PHONE, email: EMAIL, name: NAME } })).status);
      codes.push((await req(port, 'POST', '/api/auth/pair', { raw: `{"national_code":"${NID}", broken`, headers: { 'x-request-id': EMAIL } })).status);
      codes.push((await req(port, 'GET', '/api/health', { headers: { 'x-request-id': 'Bearer ' + 'k'.repeat(30), 'x-forwarded-for': PHONE, 'user-agent': NAME + ' ' + EMAIL } })).status);
      await sleep(250);
      const all = out + '\n' + err;
      for (const v of [NID, PHONE, EMAIL, NAME, sent.token]) assert(!all.includes(v), 'raw value leaked into the log (len ' + v.length + ')');
      const pathLine = out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).find(l => l.request_id === 'ob85-trace-path-01');
      assert(pathLine && pathLine.path === '/api/students/[national_code]' && pathLine.redactions >= 1, 'path not redacted: ' + JSON.stringify(pathLine));
      return 'statuses ' + codes.join(',') + ' · path redacted';
    });

    await check('OB85-06', 'gate on the real server log: tools/log-pii-scan-85.mjs --require-json ⇒ OK (0 findings, every access line has request_id + school_id, no unknown keys)', async () => {
      const f = path.join(WORK, 'server.log');
      fs.writeFileSync(f, out + '\n' + err);
      const r = spawnSync(process.execPath, [SCAN, '--require-json', f], { encoding: 'utf8', cwd: ROOT });
      assert(r.status === 0, 'scan rc=' + r.status + ' ' + r.stdout.slice(0, 400));
      const m = /http=(\d+)/.exec(r.stdout);
      assert(m && Number(m[1]) >= 8, 'too few access lines: ' + r.stdout.trim());
      sent.scan = r.stdout.trim().split('\n').pop();
      return sent.scan;
    });

    await check('OB85-07', 'negative: the same gate on a log with ONE planted PII line ⇒ red (exit 1), value not echoed in the report', async () => {
      const f = path.join(WORK, 'planted.log');
      const planted = JSON.stringify({ ts: new Date().toISOString(), level: 'info', service: 'payesh-local', event: 'http', request_id: 'x-planted-1', school_id: 1, path: '/api/students/' + NID });
      fs.writeFileSync(f, out + '\n' + planted + '\n');
      const r = spawnSync(process.execPath, [SCAN, '--require-json', f], { encoding: 'utf8', cwd: ROOT });
      assert(r.status === 1, 'planted PII not caught, rc=' + r.status);
      assert(/LOG-PII-85-HIT .*kind=national_code/.test(r.stdout) && /LOG-PII-85-FAILED/.test(r.stdout), r.stdout.slice(0, 300));
      assert(!r.stdout.includes(NID), 'the gate report itself leaked the value');
      /* and a structural leak: unknown key (a name has no regex shape) */
      const f2 = path.join(WORK, 'planted-key.log');
      fs.writeFileSync(f2, JSON.stringify({ ts: 't', event: 'http', request_id: 'x-planted-2', school_id: 1, student_name: 'Sara' }) + '\n');
      const r2 = spawnSync(process.execPath, [SCAN, '--require-json', f2], { encoding: 'utf8', cwd: ROOT });
      assert(r2.status === 1 && /kind=unknown_key/.test(r2.stdout), 'unknown key not caught: ' + r2.stdout);
      /* and a missing school_id */
      const f3 = path.join(WORK, 'planted-noschool.log');
      fs.writeFileSync(f3, JSON.stringify({ ts: 't', event: 'http', request_id: 'x-planted-3' }) + '\n');
      const r3 = spawnSync(process.execPath, [SCAN, '--require-json', f3], { encoding: 'utf8', cwd: ROOT });
      assert(r3.status === 1 && /kind=missing_school_id/.test(r3.stdout), 'missing school_id not caught');
      return 'pii:red unknown_key:red missing_school_id:red';
    });

    await check('OB85-08', '/metrics on the real server: request-duration histogram + SLO burn/p95 gauges + objectives equal server/slo.js', async () => {
      const r = await req(port, 'GET', '/metrics');
      assert(r.status === 200, 'metrics ' + r.status);
      const t = r.text;
      for (const n of ['payesh_slo_availability_burn_rate', 'payesh_slo_latency_burn_rate', 'payesh_slo_latency_good_ratio',
        'payesh_http_latency_p95_seconds', 'payesh_http_request_duration_seconds_count', 'payesh_http_request_duration_seconds_sum']) {
        assert(metricValue(t, n) !== null, 'missing ' + n);
      }
      assert(/payesh_http_request_duration_seconds_bucket\{le="\+Inf"\} \d+/.test(t), 'no +Inf bucket');
      const cnt = metricValue(t, 'payesh_http_request_duration_seconds_count');
      assert(cnt >= 10, 'histogram count ' + cnt);
      assert(metricValue(t, 'payesh_slo_objective_availability') === slo.byId('availability').objective, 'availability objective drift');
      assert(metricValue(t, 'payesh_slo_objective_latency') === slo.byId('latency').objective, 'latency objective drift');
      assert(!t.includes(NID) && !t.includes(PHONE), 'metrics leaked PII');
      return `count=${cnt} p95=${metricValue(t, 'payesh_http_latency_p95_seconds')}s avail_burn=${metricValue(t, 'payesh_slo_availability_burn_rate')}`;
    });
  } finally {
    await stop();
  }

  /* ── SLO math and rules-as-code ───────────────────────────────────── */
  await check('OB85-09', 'burn-rate math on the real Registry: 2% 5xx ⇒ availability burn 4; 10% slow ⇒ latency burn 2; p95 from durations', async () => {
    const reg = metrics.create();
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      const code = i < 2 ? 503 : 200;
      const ms = i < 10 ? 1500 + i : 50 + i;
      reg.observeHttp(code, now - 1000 + i, ms);
    }
    const t = await reg.render(now);
    const ab = metricValue(t, 'payesh_slo_availability_burn_rate');
    const lb = metricValue(t, 'payesh_slo_latency_burn_rate');
    const p95 = metricValue(t, 'payesh_http_latency_p95_seconds');
    assert(Math.abs(ab - 4) < 1e-6, 'availability burn ' + ab);
    assert(Math.abs(lb - 2) < 1e-6, 'latency burn ' + lb);
    /* sorted durations: 90 fast (≤149ms), then 10 slow (1500..1509); p95 = 95th value = 1504ms */
    assert(Math.abs(p95 - 1.504) < 1e-6, 'p95 ' + p95);
    assert(metricValue(t, 'payesh_http_request_duration_seconds_count') === 100, 'histogram count');
    return `avail_burn=${ab} latency_burn=${lb} p95=${p95}`;
  });

  await check('OB85-10', 'rules as code: slo-85.yml parses with the row-49 grammar and every rule equals server/slo.js expectedRules(); runbook anchors exist', async () => {
    const r = spawnSync(process.execPath, [ALERTS, '--rules', RULES, '--check-rules'], { encoding: 'utf8', cwd: ROOT });
    assert(r.status === 0, 'check-rules rc=' + r.status + ' ' + r.stderr);
    const got = new Map();
    for (const m of r.stdout.matchAll(/ALERT-RULE name=(\S+) group=\S+ expr="(\S+) (\S+) (\S+)" for=\d+s severity=(\S+)/g)) {
      got.set(m[1], { metric: m[2], op: m[3], threshold: Number(m[4]), severity: m[5] });
    }
    const exp = slo.expectedRules();
    assert(got.size === exp.length, `rule count ${got.size} != ${exp.length}`);
    for (const e of exp) {
      const g = got.get(e.alert);
      assert(g, 'missing rule ' + e.alert);
      for (const k of ['metric', 'op', 'threshold', 'severity']) assert(g[k] === e[k], `${e.alert}.${k}: yml=${g[k]} code=${e[k]}`);
    }
    const doc = fs.readFileSync(DOC, 'utf8');
    const yml = fs.readFileSync(RULES, 'utf8');
    for (const m of yml.matchAll(/runbook: docs\/cloud\/85-observability-slo\.md#([a-z0-9-]+)/g)) {
      assert(new RegExp('<a id="' + m[1] + '"></a>|\\{#' + m[1] + '\\}').test(doc), 'runbook anchor missing in doc: #' + m[1]);
    }
    return exp.length + ' rules match code';
  });

  await check('OB85-11', 'alerts fire on a real scrape: 10% 5xx sustained past for: ⇒ PayeshSloAvailabilityFastBurn FIRING; healthy scrape ⇒ nothing fires', async () => {
    const bad = metrics.create();
    const now = Date.now();
    for (let i = 0; i < 200; i++) bad.observeHttp(i % 10 === 0 ? 500 : 200, now - 2000 + i, 40);
    const badText = await bad.render(now);
    const state = path.join(WORK, 'alerts-state.json');
    const sink = path.join(WORK, 'alerts-sink.jsonl');
    const t0 = new Date(now).toISOString();
    const t1 = new Date(now + 3 * 60_000).toISOString();
    const a = runAlerts(badText, ['--now', t0, '--state', state, '--sink', sink]);
    assert(a.code === 0 && /ALERT-PENDING name=PayeshSloAvailabilityFastBurn/.test(a.out), 'first eval not pending: ' + a.out.slice(0, 400) + a.err);
    const b = runAlerts(badText, ['--now', t1, '--state', state, '--sink', sink]);
    assert(b.code === 0 && /ALERT-FIRING name=PayeshSloAvailabilityFastBurn/.test(b.out), 'not firing after for: ' + b.out.slice(0, 400) + b.err);
    const good = metrics.create();
    for (let i = 0; i < 200; i++) good.observeHttp(200, now - 2000 + i, 40);
    const c = runAlerts(await good.render(now), ['--now', t1, '--state', path.join(WORK, 'alerts-state-ok.json'), '--sink', path.join(WORK, 'alerts-sink-ok.jsonl')]);
    assert(c.code === 0 && /firing=0 pending=0/.test(c.out), 'healthy scrape fired: ' + c.out.slice(-300));
    return 'burn=' + metricValue(badText, 'payesh_slo_availability_burn_rate') + ' fired · healthy firing=0';
  });

  await check('OB85-12', 'no plain-text access log left in server/index.js (old `METHOD path status ms` console.log removed)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    assert(!/console\.log\(`\$\{req\.method\} \$\{url\.pathname\}/.test(src), 'plain-text access log still present');
    assert(!/console\.error\('\[ERR\]'/.test(src), 'stack-dumping error log still present');
    assert((src.match(/logger\.info\('http'/g) || []).length === 1, 'JSON access log missing');
    return 'ok';
  });

  await check('OB85-13', 'row 130: real wire bytes (keep-alive delta) + host CPU/memory gauges for the owner live monitor', async () => {
    const reg = metrics.create();
    const srv = http.createServer((req, res) => {
      res.on('finish', () => reg.observeBytes(req.socket));
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(5000)); });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const port = srv.address().port;
    const one = () => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end('y'.repeat(3000));
    });
    await one();
    await one();
    agent.destroy();
    await new Promise(r => srv.close(r));
    const text = await reg.render();
    const rx = Number(metricValue(text, 'payesh_net_rx_bytes_total'));
    const tx = Number(metricValue(text, 'payesh_net_tx_bytes_total'));
    assert(rx >= 6000 && rx < 9000, 'rx not the real 2×3000 B (+headers): ' + rx);
    assert(tx >= 10000 && tx < 13000, 'tx not the real 2×5000 B (+headers), keep-alive double count? ' + tx);
    const cpu = Number(metricValue(text, 'payesh_cpu_usage_pct'));
    const mem = Number(metricValue(text, 'payesh_memory_used_pct'));
    assert(cpu >= 0 && cpu <= 100 && mem > 0 && mem <= 100, 'cpu/mem out of range ' + cpu + '/' + mem);
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    assert(/mreg\.observeBytes\(req\.socket\)/.test(src), 'server/index.js does not record wire bytes');
    return `rx=${rx} tx=${tx} cpu=${cpu.toFixed(1)} mem=${mem.toFixed(1)}`;
  });

  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n# passed=${passed} failed=${failed}${failures.length ? ' failures=' + failures.join(',') : ''}`);
  console.log(failed ? 'OBSERVABILITY-85-FAILED' : 'OBSERVABILITY-85-OK');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
