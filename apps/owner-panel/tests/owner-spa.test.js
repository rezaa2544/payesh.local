'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون‌های PR-3 — SPA فارسی/RTL پنل مالک با پوستهٔ «نبض»
   • assets():  پوستهٔ تولیدشده از client/pulse.css + آزمون drift، جدول
                اختلاف توکن‌ها، استقلال از client/pages.js، بدون CDN/فونت/
                اسکریپت خارجی، CSP، manifest؛ هر کنترل یک کنترل منفی دارد
   • proxy():   سرور ایستا/پروکسی same-origin: CSP، allowlist هدر، ردّ
                cookie/redirect/غیر JSON/بدنهٔ نامعتبر، path traversal
   • ui():      jsdom ← پروکسی ← API واقعی PR-2 ← PGlite + migrations:
                ورود fail-closed، هشت صفحه، حالت loading/empty/error،
                نقش operator (بدون دکمهٔ تمدید/حذف + ردّ 403 در API)،
                حذف دومرحله‌ای: درخواست ⇒ تأیید مالک دوم ⇒ مهلت ۲۴ساعت ⇒ اجرا (003)، تم روشن/تیره
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'apps', 'owner-panel');
const WEB = path.join(APP, 'web');
const MIG = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const themeGen = require('../scripts/gen-theme');
const { createOwnerPanelServer, SECURITY_HEADERS } = require('../server/static-server');
const platformApi = require('../server/platform-api');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const P = '/api/platform/v1';
let CHECKS = 0;
function check(label, cond) { CHECKS++; assert.ok(cond, label); }

/* ───────────────────────── ۱. دارایی‌ها و پوسته ───────────────────────── */
function loadAssets() {
  return {
    pulse: read(ROOT, 'client', 'pulse.css'),
    theme: read(WEB, 'theme.css'),
    html: read(WEB, 'index.html'),
    js: read(WEB, 'app.js'),
    css: read(WEB, 'app.css'),
    manifest: read(WEB, 'manifest.webmanifest'),
    server: read(APP, 'server', 'static-server.js'),
    icons: ['logo-mark.png', 'icon-192.png', 'icon-512.png'].map(n => ({
      name: n,
      web: fs.readFileSync(path.join(WEB, 'icons', n)),
      src: fs.readFileSync(path.join(ROOT, 'client', 'icons', n)),
    })),
  };
}

/* هر تابع فهرست خطا برمی‌گرداند؛ ورودی سالم ⇒ []، ورودی خراب ⇒ غیرخالی. */
const ASSET_CHECKS = {
  themeDrift(a) {
    let want;
    try { want = themeGen.buildTheme(a.pulse); } catch (e) { return ['pulse.css unparsable: ' + e.message]; }
    return a.theme === want ? [] : ['web/theme.css differs from gen-theme output of client/pulse.css'];
  },
  tokenDiscrepancies(a) {
    let st;
    try { st = themeGen.discrepancyStatus(a.pulse); } catch (e) { return [e.message]; }
    const bad = st.filter(d => !d.stillDiffers).map(d => `${d.mode} ${d.token}: recorded pulse=${d.pulse}, actual=${d.actual}`);
    /* مقدار prompt نباید در پوستهٔ تولیدشده ظاهر شود */
    for (const d of themeGen.TOKEN_DISCREPANCIES) {
      if (a.theme.includes(`${d.token}: ${d.prompt};`)) bad.push(`prompt value leaked into theme: ${d.token}: ${d.prompt}`);
    }
    return bad;
  },
  themeModes(a) {
    const out = [];
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/.test(a.theme);
    if (!media) out.push('system-dark block must be guarded by :root:not([data-theme="light"])');
    if (!/:root\[data-theme="dark"\] \{/.test(a.theme)) out.push('explicit dark selector missing');
    const { light, dark } = themeGen.parsePulse(a.pulse);
    if (!a.theme.includes(`--bg: ${light.map['--bg']};`)) out.push('light --bg missing');
    if (!a.theme.includes(`--bg: ${dark.map['--bg']};`)) out.push('dark --bg missing');
    return out;
  },
  noExternal(a) {
    const out = [];
    const files = { 'index.html': a.html, 'app.js': a.js, 'app.css': a.css, 'theme.css': a.theme, 'manifest.webmanifest': a.manifest };
    for (const [n, s] of Object.entries(files)) {
      const stripped = s.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '');
      if (/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(stripped)) out.push(n + ': external URL');
      if (/@import|@font-face|url\(\s*['"]?(?:https?:)?\/\//i.test(s)) out.push(n + ': external css resource');
    }
    return out;
  },
  safeDom(a) {
    const out = [];
    const banned = [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/,
      /setAttribute\(\s*['"]style['"]/, /setTimeout\(\s*['"]/];
    for (const re of banned) if (re.test(a.js)) out.push('app.js uses ' + re);
    /* storage فقط برای کلید پوسته؛ توکن هرگز ذخیره نمی‌شود */
    const uses = [...a.js.matchAll(/(localStorage|sessionStorage)\.(setItem|getItem|removeItem)\(\s*([^,)]+)/g)];
    for (const m of uses) if (m[1] !== 'localStorage' || m[3].trim() !== 'THEME_KEY') out.push('storage use not limited to THEME_KEY: ' + m[0]);
    if (/document\.cookie/.test(a.js)) out.push('app.js touches document.cookie');
    if (!/credentials:\s*'omit'/.test(a.js) || !/redirect:\s*'error'/.test(a.js)) out.push('fetch must omit credentials and refuse redirects');
    return out;
  },
  independence(a) {
    const out = [];
    /* توضیحات حذف می‌شوند؛ فقط کد اجرایی بررسی می‌شود */
    const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [n, s] of Object.entries({ 'app.js': a.js, 'index.html': a.html, 'static-server.js': a.server })) {
      if (/pages\.js|\.\.\/client|['"]\/?client\//.test(code(s))) out.push(n + ' references client/pages.js or client/*');
    }
    return out;
  },
  cssTokensOnly(a) {
    const css = a.css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = css.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi);
    return hits ? ['app.css hard-codes colours: ' + hits.join(',')] : [];
  },
  html(a) {
    const out = [];
    if (!/<html lang="fa-IR" dir="rtl">/.test(a.html)) out.push('html must be lang=fa-IR dir=rtl');
    const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(a.html) || [])[1] || '';
    if (!/script-src 'self'/.test(csp) || /unsafe-(inline|eval)/.test(csp) || !/default-src 'none'/.test(csp)) out.push('CSP meta missing or weak');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(a.html)) out.push('inline <script> present');
    if (/<script[^>]*src="(?!app\.js")/i.test(a.html)) out.push('unexpected script source');
    if (/\sstyle=|\son[a-z]+=/i.test(a.html)) out.push('inline style/handler attribute');
    return out;
  },
  manifest(a) {
    let m;
    try { m = JSON.parse(a.manifest); } catch (e) { return ['manifest not JSON']; }
    const { light } = themeGen.parsePulse(a.pulse);
    const out = [];
    if (m.theme_color !== '#0d9488' || m.theme_color !== light.map['--primary']) out.push('theme_color must equal pulse --primary (#0d9488)');
    if (m.background_color !== '#eef7f5' || m.background_color !== light.map['--bg']) out.push('background_color must equal pulse --bg (#eef7f5)');
    if (m.lang !== 'fa-IR' || m.dir !== 'rtl') out.push('manifest lang/dir');
    return out;
  },
  icons(a) {
    return a.icons.filter(i => !i.web.equals(i.src)).map(i => i.name + ' is not byte-identical to client/icons');
  },
};

function runAssetChecks(a) {
  const failures = {};
  for (const [name, fn] of Object.entries(ASSET_CHECKS)) {
    const f = fn(a);
    if (f.length) failures[name] = f;
  }
  return failures;
}

function assets() {
  const a = loadAssets();
  const real = runAssetChecks(a);
  check('asset checks pass on committed files: ' + JSON.stringify(real), Object.keys(real).length === 0);

  /* کنترل‌های منفی: هر کنترل باید ورودی خراب را رد کند */
  const mutate = (patch) => Object.assign({}, a, patch);
  const N = [
    ['N1 hand-edited theme (radius 18→16)', 'themeDrift', mutate({ theme: a.theme.replace('--radius: 18px;', '--radius: 16px;') })],
    ['N1b prompt value leaks into theme', 'tokenDiscrepancies', mutate({ theme: a.theme.replace('--muted: #91b1a8;', '--muted: #7fa39a;') })],
    ['N1c pulse.css changed without regenerating', 'themeDrift', mutate({ pulse: a.pulse.replace('--primary: #0d9488;', '--primary: #0d9489;') })],
    ['N2 CDN script in index.html', 'noExternal', mutate({ html: a.html.replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>') })],
    ['N2b CDN script also fails html check', 'html', mutate({ html: a.html.replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>') })],
    ['N2c external font', 'noExternal', mutate({ css: a.css + '\n@font-face{font-family:x;src:url(https://fonts.example.com/v.woff2)}' })],
    ['N3 innerHTML in app.js', 'safeDom', mutate({ js: a.js + '\nx.innerHTML = y;' })],
    ['N3b token persisted to localStorage', 'safeDom', mutate({ js: a.js + "\nlocalStorage.setItem('tok', session.token);" })],
    ['N4 dependency on client/pages.js', 'independence', mutate({ js: a.js + "\nrequire('../../client/pages.js');" })],
    ['N5 hard-coded colour in app.css', 'cssTokensOnly', mutate({ css: a.css + '\n.x{color:#123456}' })],
    ['N6 forced-light broken under OS dark', 'themeModes', mutate({ theme: a.theme.replace(':root:not([data-theme="light"])', ':root') })],
    ['N6b inline script', 'html', mutate({ html: a.html.replace('</body>', '<script>alert(1)</script></body>') })],
    ['N6c manifest colour drift', 'manifest', mutate({ manifest: a.manifest.replace('#0d9488', '#1e3a8a') })],
    ['N6d icon copy drift', 'icons', mutate({ icons: a.icons.map((i, k) => k ? i : Object.assign({}, i, { web: Buffer.concat([i.web, Buffer.from([0])]) })) })],
  ];
  for (const [label, name, broken] of N) {
    check('negative control rejected: ' + label, ASSET_CHECKS[name](broken).length > 0);
  }
  /* جدول اختلاف توکن‌ها صریحاً ثبت شده و چهار ردیف سند ۶۱ §3.1 را پوشش می‌دهد */
  check('discrepancy table covers radius/muted/line/primary-2',
    ['--radius', '--muted', '--line', '--primary-2'].every(t => themeGen.TOKEN_DISCREPANCIES.some(d => d.token === t)));
  check('client/pages.js untouched by this app (no file under apps/owner-panel named pages.js)',
    !fs.readdirSync(WEB).includes('pages.js'));
  return { checks: CHECKS };
}

/* ───────────────────────── ابزار HTTP ───────────────────────────────── */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(() => resolve())); }
function raw(port, method, p, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* noop */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ───────────────────────── ۲. پروکسی same-origin ─────────────────────── */
async function proxy() {
  let seen = null;
  const fake = http.createServer((req, res) => {
    seen = { method: req.method, url: req.url, headers: req.headers };
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: 'http://evil.example/' }); return res.end(); }
    if (req.url.endsWith('/html')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<b>x</b>'); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'sid=leak; Path=/', 'x-request-id': 'rid-1', 'x-internal-secret': 'nope' });
    res.end(JSON.stringify({ ok: true, echo: true }));
  });
  const fakePort = await listen(fake);
  const panel = createOwnerPanelServer({ upstream: `http://127.0.0.1:${fakePort}` });
  const port = await listen(panel);
  const unconfigured = createOwnerPanelServer({});
  const uPort = await listen(unconfigured);
  try {
    const page = await raw(port, 'GET', '/');
    check('index served', page.status === 200 && page.headers['content-type'].startsWith('text/html'));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) check('security header ' + k, page.headers[k] === v);
    check('CSP forbids framing and inline', /frame-ancestors 'none'/.test(page.headers['content-security-policy']) && !/unsafe/.test(page.headers['content-security-policy']));
    check('theme.css served as css', (await raw(port, 'GET', '/theme.css')).headers['content-type'].startsWith('text/css'));

    /* traversal و فایل‌های غیرمجاز */
    check('path traversal refused', (await raw(port, 'GET', '/../../client/pages.js')).status === 404);
    check('encoded traversal refused', (await raw(port, 'GET', '/%2e%2e/%2e%2e/package.json')).status === 404);
    check('unknown extension refused', (await raw(port, 'GET', '/README.md')).status === 404);
    check('non-platform api path not proxied', (await raw(port, 'GET', '/api/school/v1/me')).status === 404 && seen === null);

    /* allowlist هدر: cookie و هدرهای دیگر به upstream نمی‌رسند */
    const r1 = await raw(port, 'GET', P + '/dashboard', { cookie: 'school_session=abc', authorization: 'Bearer platform.v1.a.b', 'x-forwarded-for': '1.2.3.4', 'x-request-id': 'rid-1', 'x-evil': '1' });
    check('proxied GET ok', r1.status === 200 && r1.json && r1.json.echo === true);
    check('cookie not forwarded upstream', !('cookie' in seen.headers));
    check('only allowlisted headers forwarded', !('x-forwarded-for' in seen.headers) && !('x-evil' in seen.headers) && seen.headers.authorization === 'Bearer platform.v1.a.b');
    check('set-cookie stripped from response', !('set-cookie' in r1.headers));
    check('non-allowlisted upstream header stripped', !('x-internal-secret' in r1.headers) && r1.headers['x-request-id'] === 'rid-1');

    /* redirect و غیر JSON */
    const r2 = await raw(port, 'GET', P + '/redirect');
    check('upstream redirect refused (N: open redirect)', r2.status === 502 && r2.json.error === 'upstream_redirect_refused' && !r2.headers.location);
    const r3 = await raw(port, 'GET', P + '/html');
    check('upstream non-JSON refused', r3.status === 502 && r3.json.error === 'upstream_bad_content_type');

    /* بدنهٔ نامعتبر */
    seen = null;
    const r4 = await raw(port, 'POST', P + '/plans', { 'content-type': 'application/json' }, '{bad');
    check('invalid JSON body refused before upstream', r4.status === 400 && r4.json.error === 'bad_json' && seen === null);
    const r5 = await raw(port, 'POST', P + '/plans', { 'content-type': 'text/plain' }, '{}');
    check('non-JSON content-type refused', r5.status === 415 && seen === null);
    const r6 = await raw(port, 'POST', P + '/plans', { 'content-type': 'application/json' }, JSON.stringify({ x: 'a'.repeat(40 * 1024) }));
    check('oversized body refused', r6.status === 413 && seen === null);
    const r7 = await raw(port, 'PUT', P + '/plans', { 'content-type': 'application/json' }, '{}');
    check('method outside GET/POST/DELETE refused', r7.status === 405 && seen === null);

    const r8 = await raw(uPort, 'GET', P + '/dashboard');
    check('no upstream ⇒ 503 upstream_not_configured (fail-closed)', r8.status === 503 && r8.json.error === 'upstream_not_configured');
    let threw = false;
    try { createOwnerPanelServer({ upstream: 'http://user:pw@127.0.0.1:1' }); } catch (e) { threw = true; }
    check('upstream with embedded credentials refused', threw);
  } finally {
    await close(panel); await close(fake); await close(unconfigured);
  }
  return { checks: CHECKS };
}

/* ───────────────────────── ۳. UI سرتاسری ─────────────────────────────── */
function pgliteAdapter(db) {
  return {
    async withTransaction(fn) {
      await db.exec('BEGIN');
      try {
        await db.exec('SET LOCAL ROLE payesh_platform_runtime');
        const r = await fn((sql, params = []) => db.query(sql, params));
        await db.exec('COMMIT');
        return r;
      } catch (e) {
        try { await db.exec('ROLLBACK'); } catch (_) { /* noop */ }
        throw e;
      }
    },
  };
}

async function seedDb() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.product_records (
    tenant_id uuid NOT NULL, collection text NOT NULL, record_id bigint NOT NULL,
    version integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, collection, record_id))`);
  await db.exec(`ALTER TABLE public.product_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.product_records FORCE ROW LEVEL SECURITY;
    CREATE POLICY product_records_isolation ON public.product_records
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  await db.exec(read(MIG, '001_owner_panel.up.sql'));
  await db.exec(read(MIG, '002_owner_panel_api.up.sql'));
  await db.exec(read(MIG, '003_tenant_deletion.up.sql'));
  const ids = { owner: crypto.randomUUID(), owner2: crypto.randomUUID(), operator: crypto.randomUUID(), support: crypto.randomUUID(),
    A: crypto.randomUUID(), B: crypto.randomUUID() };
  for (const [id, login, role] of [[ids.owner, 'owner-1', 'platform_owner'], [ids.owner2, 'owner-2', 'platform_owner'],
    [ids.operator, 'operator-1', 'platform_operator'], [ids.support, 'support-1', 'platform_support']]) {
    await db.query('INSERT INTO owner_platform.platform_users(id,login_id,role) VALUES ($1,$2,$3)', [id, login, role]);
  }
  await db.query(`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('basic','پایه',1024)`);
  ids.subs = {};
  for (const t of [ids.A, ids.B]) {
    const r = await db.query(`INSERT INTO owner_platform.subscriptions (tenant_id,plan_code,status,starts_at,ends_at)
      VALUES ($1,'basic','active',now()-interval '1 day',now()+interval '30 days') RETURNING id`, [t]);
    ids.subs[t] = r.rows[0].id;
    await db.query('INSERT INTO owner_platform.tenant_limits(tenant_id,max_users,max_students,storage_bytes) VALUES ($1,50,500,1073741824)', [t]);
    await db.query('INSERT INTO owner_platform.tenant_usage(tenant_id,users_count,students_count,storage_bytes) VALUES ($1,7,120,268435456)', [t]);
  }
  return { db, ids };
}

function makeDom(port) {
  const { JSDOM } = require('jsdom');
  const html = read(WEB, 'index.html');
  const dom = new JSDOM(html, { url: `http://127.0.0.1:${port}/`, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.OWNER_PANEL_NO_AUTOBOOT = true;
  dom.window.eval(read(WEB, 'app.js'));
  const base = `http://127.0.0.1:${port}`;
  const calls = [];
  const fetchImpl = (u, init) => { calls.push({ url: u, init }); return fetch(base + u, init); };
  return { dom, win: dom.window, doc: dom.window.document, fetchImpl, calls };
}

async function settle(app, win) {
  for (let i = 0; i < 50; i++) {
    const p = app.idle();
    await p;
    await new Promise(r => setTimeout(r, 5));
    if (app.idle() === p) return;
  }
}
const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => Array.from(doc.querySelectorAll(sel));
function states(doc) { return $$(doc, '#page .state').map(s => s.getAttribute('data-state')); }

async function submitDialog(doc, win, app, fill) {
  const form = $(doc, '#dialog form');
  assert.ok(form, 'dialog opened');
  fill(form);
  form.requestSubmit();
  await new Promise(r => setTimeout(r, 5));
  await settle(app, win);
}

async function ui() {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  if (hadWindow) delete global.window;

  const SECRET = crypto.randomBytes(32).toString('hex');
  const { db, ids } = await seedDb();
  const api = platformApi.createPlatformApi({ db: pgliteAdapter(db), secret: SECRET, instance: 'spa-test', rateLimitMax: 10000 });
  const upstream = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://gw.invalid')));
  const upPort = await listen(upstream);
  const panel = createOwnerPanelServer({ upstream: `http://127.0.0.1:${upPort}` });
  const port = await listen(panel);
  /* upstream ساختگی برای حالت empty و error */
  const emptyUp = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const p = new URL(req.url, 'http://x').pathname.replace(P, '');
    const body = { '/dashboard': { ok: true, dashboard: { subscriptions: 0, plans: 0, active_users: 0, open_grants: 0 } },
      '/tenants': { ok: true, tenants: [], count: 0 }, '/plans': { ok: true, plans: [], count: 0 },
      '/subscriptions': { ok: true, subscriptions: [], count: 0 }, '/platform-users': { ok: true, users: [], count: 0 },
      '/support-grants': { ok: true, grants: [], count: 0 }, '/audit': { ok: true, events: [], count: 0 },
      '/tenant-deletions': { ok: true, requests: [], count: 0 } }[p] || { ok: false, error: 'not_found' };
    res.end(JSON.stringify(body));
  });
  const emptyPort = await listen(emptyUp);
  const emptyPanel = createOwnerPanelServer({ upstream: `http://127.0.0.1:${emptyPort}` });
  const emptyPanelPort = await listen(emptyPanel);
  const deadPanel = createOwnerPanelServer({});
  const deadPort = await listen(deadPanel);

  const tok = (sub, role, extra = {}) => platformApi.signPlatformToken(Object.assign({ sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: crypto.randomUUID() }, extra), SECRET);
  const T = { owner: tok(ids.owner, 'platform_owner'), owner2: tok(ids.owner2, 'platform_owner'),
    operator: tok(ids.operator, 'platform_operator'), support: tok(ids.support, 'platform_support') };
  const PAGES = ['dashboard', 'schools', 'plans', 'limits', 'health', 'operators', 'reports', 'audit'];

  try {
    /* ── ورود fail-closed ─────────────────────────────────────────── */
    {
      const { doc, win, fetchImpl, calls } = makeDom(port);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl });
      await app.start();
      check('no session ⇒ login screen with TOTP field', !!$(doc, '#login-form') && !!$(doc, '#totp') && !$(doc, '.shell'));
      check('document is fa-IR / rtl', doc.documentElement.getAttribute('lang') === 'fa-IR' && doc.documentElement.getAttribute('dir') === 'rtl');
      $(doc, '#login_id').value = 'owner-1'; $(doc, '#password').value = 'secret-pass'; $(doc, '#totp').value = '۱۲۳';
      $(doc, '#login-form').requestSubmit(); await settle(app, win);
      check('short TOTP rejected client-side without network', calls.length === 0 && /۶ رقم/.test($(doc, '#login-msg').textContent));
      check('password field cleared after submit', $(doc, '#password').value === '');
      $(doc, '#login_id').value = 'owner-1'; $(doc, '#password').value = 'secret-pass'; $(doc, '#totp').value = '۱۲۳۴۵۶';
      $(doc, '#login-form').requestSubmit(); await settle(app, win);
      check('login posts Persian-digit TOTP normalised', calls.length === 1 && JSON.parse(calls[0].init.body).totp === '123456');
      check('login request omits cookies and refuses redirects', calls[0].init.credentials === 'omit' && calls[0].init.redirect === 'error');
      check('missing issuer (no migration 004) ⇒ 501 ⇒ fail-closed message, no session', app.session === null && /D‑45/.test($(doc, '#login-msg').textContent) && !$(doc, '.shell'));
      check('forged/unsigned token cannot even set UI session', app.setSession('platform.v1.e30.AAAA') === false && app.session === null);
      check('expired token rejected by UI', app.setSession(tok(ids.owner, 'platform_owner', { exp: Date.now() - 1000 })) === false);
    }

    /* ── ورود واقعی با صادرکنندهٔ D‑45 (migration 004 + اسکریپت ساخت اپراتور) ── */
    {
      await db.exec(read(MIG, '004_owner_login.up.sql'));
      const ownerAuth = require('../server/owner-auth');
      const { createOperator } = require('../scripts/create-operator');
      await db.exec('BEGIN'); await db.exec('SET LOCAL ROLE payesh_platform_owner');
      const op = await createOperator((sql, p = []) => db.query(sql, p), { loginId: 'owner-1', role: 'platform_owner', password: 'spa-owner-pass-01' });
      await db.exec('COMMIT');
      const { doc, win, fetchImpl } = makeDom(port);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl });
      await app.start();
      $(doc, '#login_id').value = 'owner-1'; $(doc, '#password').value = 'wrong-password-xx'; $(doc, '#totp').value = ownerAuth.totpAt(op.totpSecret, Date.now());
      $(doc, '#login-form').requestSubmit(); await settle(app, win);
      check('wrong password via real issuer ⇒ 401 message, no session', app.session === null && /نادرست/.test($(doc, '#login-msg').textContent) && !$(doc, '.shell'));
      $(doc, '#login_id').value = 'owner-1'; $(doc, '#password').value = 'spa-owner-pass-01'; $(doc, '#totp').value = ownerAuth.totpAt(op.totpSecret, Date.now());
      $(doc, '#login-form').requestSubmit(); await settle(app, win);
      check('password + TOTP via real issuer ⇒ session + dashboard', app.session && app.session.sub === op.userId && app.session.role === 'platform_owner' && !!$(doc, '.shell'));
      await db.exec(read(MIG, '004_owner_login.down.sql'));
    }

    /* ── owner: هر هشت صفحه از API واقعی ─────────────────────────── */
    {
      const { doc, win, fetchImpl, calls } = makeDom(port);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: T.owner });
      await app.start(); await settle(app, win);
      for (const p of PAGES) {
        await app.show(p); await settle(app, win);
        const st = states(doc);
        check(`owner page ${p} leaves loading and shows no error (${st.join(',')})`, !st.includes('loading') && !st.includes('error'));
        check(`page ${p} marked active in nav`, $(doc, `.navitem[data-page="${p}"]`).getAttribute('aria-current') === 'page');
      }
      check('all requests same-origin relative under /api/platform/v1', calls.every(c => c.url.startsWith(P + '/')));
      await app.show('dashboard'); await settle(app, win);
      check('dashboard shows Persian digits', $(doc, '[data-metric="subscriptions"] b').textContent === '۲');
      await app.show('schools'); await settle(app, win);
      check('owner sees delete-request and suspend', $$(doc, '[data-action="delete-request"]').length === 2 && $$(doc, '[data-action="suspend"]').length === 2);
      check('dates rendered in Jalali', /۱۴[۰-۹]{2}/.test($(doc, '#page table').textContent));

      /* حذف دومرحله‌ای روی مدرسهٔ سوم C: درخواست owner ⇒ تأیید owner2 ⇒ مهلت ۲۴ساعت ⇒ اجرا */
      ids.C = crypto.randomUUID();
      await db.query(`INSERT INTO owner_platform.subscriptions (tenant_id,plan_code,status,starts_at,ends_at)
        VALUES ($1,'basic','active',now()-interval '1 day',now()+interval '30 days')`, [ids.C]);
      await app.show('dashboard'); await settle(app, win);
      await app.show('schools'); await settle(app, win);
      check('owner sees deletion-requests card (empty)', states(doc).includes('empty') && /چهارچشمی/.test($(doc, '#page').textContent));
      $(doc, `[data-action="delete-request"][data-tenant="${ids.C}"]`).click();
      const dlgText = $(doc, '#dialog').textContent;
      check('delete dialog states four-eyes, 24h delay and 180-day retention', /چهارچشمی/.test(dlgText) && /۲۴ ساعت/.test(dlgText) && /۱۸۰ روز/.test(dlgText));
      const before = calls.length;
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'کوتاه'; });
      check('delete: short reason blocked client-side', calls.length === before && /۱۰ نویسه/.test($(doc, '#dlg-error').textContent));
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'پایان قرارداد مدرسه به درخواست مدیر'; f.querySelector('#dlg-retype').value = 'wrong'; });
      check('delete: retype mismatch blocked', calls.length === before && !!$(doc, '#dialog'));
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'پایان قرارداد مدرسه به درخواست مدیر'; f.querySelector('#dlg-retype').value = ids.C; });
      const reqCall = calls.slice(before).find(c => c.init.method === 'POST');
      check('delete request posted to deletion-request with retyped id (not DELETE)',
        !!reqCall && reqCall.url === `${P}/tenants/${ids.C}/deletion-request` && JSON.parse(reqCall.init.body).confirm_tenant_id === ids.C
        && !calls.slice(before).some(c => c.init.method === 'DELETE'));
      check('request accepted; UI says waiting for second owner', /منتظر تأیید مالک دیگر/.test(($(doc, '.flash[data-kind="ok"]') || {}).textContent || ''));
      const dr = await db.query('SELECT id, status, requested_by FROM owner_platform.tenant_deletion_request WHERE tenant_id=$1', [ids.C]);
      check('DB: one pending request by owner', dr.rows.length === 1 && dr.rows[0].status === 'pending' && dr.rows[0].requested_by === ids.owner);
      const RQ = dr.rows[0].id;
      check('C row no longer offers a second request', !$(doc, `[data-action="delete-request"][data-tenant="${ids.C}"]`) && !!$(doc, '[data-deletion="pending"]'));
      check('requester sees no approve button for own request', !$(doc, `[data-action="deletion-approve"][data-request="${RQ}"]`) && !!$(doc, '[data-wait="second-owner"]'));
      const selfApprove = await raw(port, 'POST', `${P}/tenant-deletions/${RQ}/approve`, { 'content-type': 'application/json', authorization: 'Bearer ' + T.owner }, '{}');
      check('N8 self-approval via proxy ⇒ 403 four_eyes_required', selfApprove.status === 403 && selfApprove.json.error === 'four_eyes_required');
      const subC0 = await db.query('SELECT status FROM owner_platform.subscriptions WHERE tenant_id=$1', [ids.C]);
      check('subscription untouched while pending', subC0.rows[0].status === 'active');

      {
        const o2 = makeDom(port);
        const app2 = o2.win.OwnerPanel.createApp({ document: o2.doc, window: o2.win, fetch: o2.fetchImpl, session: T.owner2 });
        await app2.start(); await app2.show('schools'); await settle(app2, o2.win);
        const ab = $(o2.doc, `[data-action="deletion-approve"][data-request="${RQ}"]`);
        check('second owner sees approve button', !!ab);
        ab.click();
        await submitDialog(o2.doc, o2.win, app2, (f) => { f.querySelector('#dlg-reason').value = 'تأیید پس از تماس با مدیر مدرسه'; f.querySelector('#dlg-retype').value = ids.C; });
        check('second-owner approval succeeds end-to-end', !!$(o2.doc, '.flash[data-kind="ok"]'));
        check('UI shows 24h delay running, no execute button', !!$(o2.doc, '[data-wait="delay"]') && !$(o2.doc, '[data-action="deletion-execute"]'));
      }
      const ap = await db.query(`SELECT status, approved_by, extract(epoch from (not_before - approved_at))::int AS delay FROM owner_platform.tenant_deletion_request WHERE id=$1`, [RQ]);
      check('DB: approved by owner2 with not_before = approved_at + 24h', ap.rows[0].status === 'approved' && ap.rows[0].approved_by === ids.owner2 && ap.rows[0].delay === 86400);
      const early = await raw(port, 'POST', `${P}/tenant-deletions/${RQ}/execute`, { 'content-type': 'application/json', authorization: 'Bearer ' + T.owner }, '{}');
      check('N9 execute before 24h via proxy ⇒ 409 deletion_delay_pending', early.status === 409 && early.json.error === 'deletion_delay_pending');

      /* گذر زمان (superuser، بیرون از نقش runtime): هر دو ستون با هم عقب می‌روند */
      await db.query(`UPDATE owner_platform.tenant_deletion_request SET approved_at = approved_at - interval '25 hours',
        not_before = not_before - interval '25 hours' WHERE id=$1`, [RQ]);
      await app.show('dashboard'); await settle(app, win);
      await app.show('schools'); await settle(app, win);
      const eb = $(doc, `[data-action="deletion-execute"][data-request="${RQ}"]`);
      check('after delay the execute button appears', !!eb);
      eb.click();
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'اجرای حذف پس از پایان مهلت قانونی'; f.querySelector('#dlg-retype').value = ids.C; });
      check('execute succeeds end-to-end', /داده نگه داشته شد/.test(($(doc, '.flash[data-kind="ok"]') || {}).textContent || ''));
      const ex = await db.query(`SELECT r.status, extract(epoch from (r.retain_until - r.executed_at))::bigint AS keep, s.status AS sub
        FROM owner_platform.tenant_deletion_request r JOIN owner_platform.subscriptions s ON s.tenant_id = r.tenant_id WHERE r.id=$1`, [RQ]);
      check('DB: executed, subscription canceled, retention ≥ 180 days', ex.rows[0].status === 'executed' && ex.rows[0].sub === 'canceled' && Number(ex.rows[0].keep) >= 180 * 86400);
      const otherSubs = await db.query(`SELECT count(*)::int AS n FROM owner_platform.subscriptions WHERE tenant_id = ANY($1::uuid[]) AND status='active'`, [[ids.A, ids.B]]);
      check('other tenants untouched', otherSubs.rows[0].n === 2);

      /* تمدید واقعی + ممیزی */
      await app.show('plans'); await settle(app, win);
      $(doc, `[data-action="renew"][data-subscription="${ids.subs[ids.A]}"]`).click();
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'تمدید سالانه طبق قرارداد امضاشده'; f.querySelector('#dlg-days').value = '۳۰'; });
      check('owner renew succeeds end-to-end', !!$(doc, '.flash[data-kind="ok"]'));
      await app.show('audit'); await settle(app, win);
      check('audit shows subscription.renew with continuous chain', /subscription\.renew/.test($(doc, '#page').textContent) && !!$(doc, '[data-chain="continuous"]'));

      /* حالت تم */
      const html = doc.documentElement;
      html.removeAttribute('data-theme'); win.localStorage.clear();
      const btn = () => $(doc, '[data-action="theme"]');
      btn().click(); check('theme → light', html.getAttribute('data-theme') === 'light' && win.localStorage.getItem('payesh-owner-panel-theme') === 'light');
      btn().click(); check('theme → dark', html.getAttribute('data-theme') === 'dark');
      btn().click(); check('theme → system', !html.hasAttribute('data-theme') && win.localStorage.getItem('payesh-owner-panel-theme') === null);
      check('token never written to storage', !JSON.stringify(Object.assign({}, win.localStorage)).includes('platform.v1') && !JSON.stringify(Object.assign({}, win.sessionStorage)).includes('platform.v1'));
      const theme = read(WEB, 'theme.css');
      const { dark } = themeGen.parsePulse(read(ROOT, 'client', 'pulse.css'));
      const darkBlock = theme.slice(theme.indexOf(':root[data-theme="dark"]'));
      check('explicit dark uses pulse dark tokens', darkBlock.includes(`--bg: ${dark.map['--bg']};`) && darkBlock.includes(`--primary-2: ${dark.map['--primary-2']};`));
    }

    /* ── operator: بدون تمدید/حذف در UI، و API هم رد می‌کند ─────────── */
    {
      const { doc, win, fetchImpl } = makeDom(port);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: T.operator });
      await app.start();
      await app.show('schools'); await settle(app, win);
      check('operator: no delete button', $$(doc, '[data-action="delete-request"]').length === 0);
      check('operator: suspend allowed (server allows owner+operator)', $$(doc, '[data-action="suspend"]').length === 2);
      await app.show('plans'); await settle(app, win);
      check('operator: no renew button', $$(doc, '[data-action="renew"]').length === 0 && $$(doc, '[data-action="create-plan"]').length === 0);
      await app.show('operators'); await settle(app, win);
      check('operator: may request grant, may not approve/revoke/create user',
        !!$(doc, '[data-action="request-grant"]') && !$(doc, '[data-action="approve-grant"]') && !$(doc, '[data-action="revoke-grant"]') && !$(doc, '[data-action="create-user"]'));

      /* درخواست مجوز از UI ⇒ تأیید مالک دیگر از UI */
      $(doc, '[data-action="request-grant"]').click();
      const toLocal = (ms) => { const d = new Date(ms); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
      await submitDialog(doc, win, app, (f) => {
        f.querySelector('#dlg-tenant').value = ids.B; f.querySelector('#dlg-scope').value = 'metadata';
        f.querySelector('#dlg-case').value = 'CASE-98'; f.querySelector('#dlg-reason').value = 'بررسی خطای همگام‌سازی گزارش‌شده توسط مدرسه';
        f.querySelector('#dlg-notified').value = toLocal(Date.now() - 10 * 60_000);
        f.querySelector('#dlg-start').value = toLocal(Date.now() + 10 * 60_000); f.querySelector('#dlg-hours').value = '4';
      });
      check('operator grant request accepted by server', !!$(doc, '.flash[data-kind="ok"]'));
    }

    /* ── API همچنان مرجع است: اگر gate UI دور زده شود، سرور رد می‌کند ── */
    {
      const { doc, win, fetchImpl } = makeDom(port);
      win.OwnerPanel.CAPS.platform_operator.renew = true;           /* کنترل منفی: gate UI حذف شد */
      win.OwnerPanel.CAPS.platform_operator.deleteRequest = true;
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: T.operator });
      await app.start(); await app.show('plans'); await settle(app, win);
      const subCount = (await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions')).rows[0].n;
      check('N7 tampered UI exposes renew button (control is real)', $$(doc, '[data-action="renew"]').length === subCount && subCount >= 2);
      $(doc, '[data-action="renew"]').click();
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'تلاش اپراتور برای تمدید بدون اختیار'; });
      check('N7 server still refuses operator renew (role_forbidden)', /اجازهٔ این کار را ندارد/.test($(doc, '.flash[data-kind="error"]').textContent));
      const direct = await raw(port, 'POST', `${P}/subscriptions/${ids.subs[ids.A]}/renew`, { 'content-type': 'application/json', authorization: 'Bearer ' + T.operator }, JSON.stringify({ reason: 'تمدید بدون اختیار اپراتور' }));
      check('operator renew via proxy ⇒ 403 role_forbidden', direct.status === 403 && direct.json.error === 'role_forbidden');
      const del = await raw(port, 'DELETE', `${P}/tenants/${ids.A}`, { authorization: 'Bearer ' + T.operator });
      check('operator delete via proxy ⇒ 403', del.status === 403);
      const delOwner = await raw(port, 'DELETE', `${P}/tenants/${ids.A}`, { authorization: 'Bearer ' + T.owner });
      check('even owner immediate DELETE ⇒ 403 tenant_deletion_disabled', delOwner.status === 403 && delOwner.json.error === 'tenant_deletion_disabled');
      const opReq = await raw(port, 'POST', `${P}/tenants/${ids.A}/deletion-request`, { 'content-type': 'application/json', authorization: 'Bearer ' + T.operator },
        JSON.stringify({ reason: 'تلاش اپراتور برای حذف بدون اختیار', confirm_tenant_id: ids.A }));
      check('operator deletion-request via proxy ⇒ 403 role_forbidden', opReq.status === 403 && opReq.json.error === 'role_forbidden');
      await app.show('schools'); await settle(app, win);
      check('N7 tampered UI exposes delete button but deletion list is server-refused', $$(doc, '[data-action="delete-request"]').length >= 1
        && $$(doc, '#page .state[data-state="error"]').length === 1);
    }

    /* ── owner2 تأیید درخواست اپراتور (چهارچشمی) ──────────────────── */
    {
      const { doc, win, fetchImpl } = makeDom(port);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: T.owner2 });
      await app.start(); await app.show('operators'); await settle(app, win);
      const btn = $(doc, '[data-action="approve-grant"]');
      check('owner sees pending request from audit', !!btn);
      btn.click();
      await submitDialog(doc, win, app, (f) => { f.querySelector('#dlg-reason').value = 'تأیید پس از بررسی پرونده CASE-98'; });
      check('owner approval succeeds end-to-end', !!$(doc, '.flash[data-kind="ok"]'));
      const g = await db.query("SELECT approved_by, operator_id FROM owner_platform.support_grant WHERE case_ref='CASE-98'");
      check('grant stored with distinct requester/approver', g.rows.length === 1 && g.rows[0].approved_by === ids.owner2 && g.rows[0].operator_id === ids.operator);
    }

    /* ── حالت‌های empty و error ───────────────────────────────────── */
    {
      const { doc, win, fetchImpl } = makeDom(emptyPanelPort);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: T.owner });
      await app.start();
      for (const p of ['dashboard', 'schools', 'plans', 'limits', 'operators', 'reports', 'audit']) {
        await app.show(p); await settle(app, win);
        const st = states(doc);
        check(`empty state on ${p} (${st.join(',')})`, st.includes('empty') && !st.includes('loading') && !st.includes('error'));
      }
    }
    {
      const { doc, win, fetchImpl } = makeDom(deadPort);
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: T.owner });
      await app.start();
      for (const p of PAGES) {
        await app.show(p); await settle(app, win);
        const st = states(doc);
        check(`error state on ${p} when upstream missing (${st.join(',')})`, st.includes('error') && !st.includes('loading'));
      }
      const msg = $(doc, '#page .state[data-state="error"]').textContent;
      check('error message is Persian and specific', /تنظیم نشده/.test(msg));
    }
    {
      /* loading: پاسخ معلق ⇒ حالت loading قابل مشاهده است */
      const { doc, win } = makeDom(port);
      let release;
      const hang = () => new Promise((resolve) => { release = resolve; });
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: hang, session: T.owner });
      app.start();
      await new Promise(r => setTimeout(r, 5));
      check('loading state rendered while request pending', states(doc).includes('loading') && $(doc, '#page .state').getAttribute('role') === 'status');
      release({ status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, dashboard: { subscriptions: 1, plans: 1, active_users: 1, open_grants: 0 } }) });
      await settle(app, win);
      check('loading resolves to content', !states(doc).includes('loading') && !!$(doc, '[data-metric="plans"]'));
    }
    {
      /* توکن با امضای جعلی ⇒ سرور 401 ⇒ UI به صفحهٔ ورود برمی‌گردد */
      const { doc, win, fetchImpl } = makeDom(port);
      const forged = platformApi.signPlatformToken({ sub: ids.owner, role: 'platform_owner', iat: Date.now(), exp: Date.now() + 3600_000 }, crypto.randomBytes(32).toString('hex'));
      const app = win.OwnerPanel.createApp({ document: doc, window: win, fetch: fetchImpl, session: forged });
      await app.start(); await settle(app, win);
      check('forged-signature token ⇒ server 401 ⇒ back to login', app.session === null && !!$(doc, '#login-form') && /منقضی/.test(doc.body.textContent));
    }
  } finally {
    await close(panel); await close(upstream); await close(emptyPanel); await close(emptyUp); await close(deadPanel);
    await db.close();
    if (hadWindow) global.window = previousWindow;
  }
  return { checks: CHECKS };
}

async function all() {
  CHECKS = 0;
  assets();
  await proxy();
  await ui();
  return CHECKS;
}

module.exports = { assets, proxy, ui, all, ASSET_CHECKS, runAssetChecks, loadAssets, checks: () => CHECKS };

if (require.main === module) {
  all().then((n) => { console.log(`OWNER-SPA checks=${n} failures=0`); })
    .catch((e) => { console.error('OWNER-SPA FAILED after checks=' + CHECKS + ':', e && e.message); process.exit(1); });
}
