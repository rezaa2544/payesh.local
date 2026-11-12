'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۲۳ — صفحهٔ «زیرساخت» و فرم «ساخت مدرسه» در SPA پنل مالک
   jsdom ← پروکسی same-origin ← API واقعی (ردیف‌های ۱۲۱ و ۱۲۲) ← PGlite + migrations 001..006

   • بدون داده: هر سنجه «نامعلوم» است و هیچ «۰» ساختگی دیده نمی‌شود؛ Provisioning «دستی»
   • Credential: فقط ارجاع secret:NAME؛ مقدار canary در env هرگز در DOM، بدنهٔ درخواست یا ممیزی نیست
   • عملیات پرخطر دومرحله‌ای: درخواست (بازتایپ هدف) ⇒ بی‌اثر تا تأیید ⇒ تأیید فقط مالک (بازتایپ)
   • Health Check دستی: نامعلوم ⇒ سالم/قطع، cooldown ۳۰ ثانیه (429)، هشدار پس از ۳ شکست
   • ساخت مدرسه: فقط مالک، تلاش دوباره با همان provision_op_id، کد فعال‌سازی فقط یک بار
   • حالت loading/empty/error و نقش‌های operator/support
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WEB = path.join(ROOT, 'apps', 'owner-panel', 'web');
const MIG = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const platformApi = require('../server/platform-api');
const { createOwnerPanelServer } = require('../server/static-server');

const P = '/api/platform/v1';
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const CANARY = 'canary-' + crypto.randomBytes(12).toString('hex');
let CHECKS = 0;
let NEG = 0;
function check(label, cond) { CHECKS++; assert.ok(cond, label); }
function negative(label, cond) { CHECKS++; NEG++; assert.ok(cond, 'negative control: ' + label); }

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
function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { return new Promise((resolve) => server.close(() => resolve())); }
function makeDom(port) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(read(WEB, 'index.html'), { url: `http://127.0.0.1:${port}/`, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.OWNER_PANEL_NO_AUTOBOOT = true;
  dom.window.eval(read(WEB, 'app.js'));
  const base = `http://127.0.0.1:${port}`;
  const calls = [];
  const fetchImpl = (u, init) => { calls.push({ url: u, init }); return fetch(base + u, init); };
  return { win: dom.window, doc: dom.window.document, fetchImpl, calls };
}
async function settle(app) {
  for (let i = 0; i < 50; i++) {
    const p = app.idle();
    await p;
    await new Promise(r => setTimeout(r, 5));
    if (app.idle() === p) return;
  }
}
const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => Array.from(doc.querySelectorAll(sel));
const states = doc => $$(doc, '#page .state').map(s => s.getAttribute('data-state'));
const flashText = (doc, kind) => (($(doc, `.flash[data-kind="${kind}"]`) || {}).textContent || '');
async function dialog(doc, app, values) {
  const form = $(doc, '#dialog form');
  assert.ok(form, 'dialog opened');
  for (const [sel, v] of Object.entries(values)) {
    const el = form.querySelector(sel);
    assert.ok(el, 'dialog field ' + sel);
    el.value = v;
    el.dispatchEvent(new doc.defaultView.Event('change'));
  }
  form.requestSubmit();
  await new Promise(r => setTimeout(r, 5));
  await settle(app);
}
const REASON = 'ثبت دستی زیرساخت مرحلهٔ A برای آزمون';

async function run() {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  if (hadWindow) delete global.window;
  const prevEnv = process.env.RADCLOUD_API_TOKEN;
  process.env.RADCLOUD_API_TOKEN = CANARY;

  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  for (const f of ['001_owner_panel.up.sql', '002_owner_panel_api.up.sql', '003_tenant_deletion.up.sql',
    '004_owner_login.up.sql', '005_tenant_provisioning.up.sql', '006_infra_registry.up.sql']) await db.exec(read(MIG, f));
  const U = { owner: crypto.randomUUID(), operator: crypto.randomUUID(), support: crypto.randomUUID() };
  for (const [id, login, role] of [[U.owner, 'owner-1', 'platform_owner'], [U.operator, 'operator-1', 'platform_operator'], [U.support, 'support-1', 'platform_support']]) {
    await db.query("INSERT INTO owner_platform.platform_users(id,login_id,role,status) VALUES ($1,$2,$3,'active')", [id, login, role]);
  }
  await db.query("INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('basic','پایه',1024)");

  /* checker اسکریپتی (مرحلهٔ شبکه، قطعی) و provisioner سمت مدرسه (اولی شکست می‌خورد) */
  const script = [];
  const checker = async () => script.shift() || { ok: true, latency_ms: 12, status_code: 200, error_code: null };
  const provisionCalls = [];
  let failNext = 0;
  const codes = [];
  const provisioner = async ({ tenantId, slug, opId }) => {
    provisionCalls.push({ tenantId, slug, opId });
    if (failNext > 0) { failNext--; throw new Error('school db down'); }
    const code = 'ACT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    codes.push(code);
    return { manager_uid: 1, manager_activated: false, activation_code: code };
  };
  const SECRET = crypto.randomBytes(32).toString('hex');
  const mk = (cooldown) => platformApi.createPlatformApi({ db: pgliteAdapter(db), secret: SECRET, instance: 'spa-123', rateLimitMax: 10000,
    healthChecker: checker, checkCooldownSec: cooldown, schoolProvisioner: provisioner });
  const servers = [];
  async function panelFor(apiObj) {
    const up = http.createServer((req, res) => apiObj.handle(req, res, new URL(req.url, 'http://gw.invalid')));
    const upPort = await listen(up);
    const panel = createOwnerPanelServer({ upstream: `http://127.0.0.1:${upPort}` });
    const port = await listen(panel);
    servers.push(up, panel);
    return port;
  }
  const fast = await panelFor(mk(0));
  const strict = await panelFor(mk(30));
  const deadPanel = createOwnerPanelServer({}); const deadPort = await listen(deadPanel); servers.push(deadPanel);

  const tok = (sub, role) => platformApi.signPlatformToken({ sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: crypto.randomUUID() }, SECRET);
  const T = { owner: tok(U.owner, 'platform_owner'), operator: tok(U.operator, 'platform_operator'), support: tok(U.support, 'platform_support') };
  const open = async (port, token) => {
    const d = makeDom(port);
    const app = d.win.OwnerPanel.createApp({ document: d.doc, window: d.win, fetch: d.fetchImpl, session: token });
    await app.start(); await settle(app);
    await app.show('infra'); await settle(app);
    return Object.assign(d, { app });
  };
  const count = async (sql, p) => Number((await db.query(sql, p || [])).rows[0].n);

  try {
    /* ── ۱. پوسته و فهرست صفحه ─────────────────────────────────────── */
    {
      const d = makeDom(fast);
      const PAGES = d.win.OwnerPanel.PAGES;
      check('infra page registered with Persian title', PAGES.some(p => p.id === 'infra' && p.title === 'زیرساخت'));
      check('caps: only owner approves infra changes / creates schools',
        d.win.OwnerPanel.CAPS.platform_owner.infraApprove && !d.win.OwnerPanel.CAPS.platform_operator.infraApprove
        && !d.win.OwnerPanel.CAPS.platform_support.infraRequestChange && d.win.OwnerPanel.CAPS.platform_owner.createSchool
        && !d.win.OwnerPanel.CAPS.platform_operator.createSchool);
      const js = read(WEB, 'app.js').replace(/\/\*[\s\S]*?\*\//g, '');
      negative('no innerHTML/eval in SPA', !/innerHTML|\beval\(/.test(js));
    }

    /* ── ۲. حالت empty و «نامعلوم» ─────────────────────────────────── */
    let o = await open(fast, T.owner);
    {
      const st = states(o.doc);
      check(`empty infra: all cards empty, no loading/error (${st.join(',')})`, st.filter(s => s === 'empty').length === 5 && !st.includes('loading') && !st.includes('error'));
      check('nav marks infra active', $(o.doc, '.navitem[data-page="infra"]').getAttribute('aria-current') === 'page');
      check('provisioning shown as manual, never automated', !!$(o.doc, '[data-provisioning="manual"]') && /Provisioning\) فعال نیست/.test($(o.doc, '#page').textContent));
      check('document is rtl', o.doc.documentElement.getAttribute('dir') === 'rtl');
    }

    /* ── ۳. ثبت ارائه‌دهنده: فقط ارجاع Secret ─────────────────────── */
    {
      $(o.doc, '[data-action="infra-add-provider"]').click();
      negative('provider dialog has no password field', !$(o.doc, '#dialog input[type="password"]'));
      check('dialog warns never to enter a secret', /هرگز اینجا وارد نکنید/.test($(o.doc, '#dialog').textContent));
      let before = o.calls.length;
      await dialog(o.doc, o.app, { '#dlg-code': 'radcloud', '#dlg-name': 'RadCloud', '#dlg-credref': CANARY, '#dlg-reason': REASON });
      negative('raw token as credential blocked client-side (no request)', o.calls.length === before && /secret:NAME/.test($(o.doc, '#dlg-error').textContent));
      await dialog(o.doc, o.app, { '#dlg-credref': 'secret:lower_case' });
      negative('malformed secret reference blocked', o.calls.length === before && !!$(o.doc, '#dialog'));
      await dialog(o.doc, o.app, { '#dlg-code': 'Bad Code' , '#dlg-credref': '' });
      negative('invalid provider code blocked', o.calls.length === before);
      await dialog(o.doc, o.app, { '#dlg-code': 'radcloud', '#dlg-credref': 'secret:RADCLOUD_API_TOKEN' });
      const post = o.calls.slice(before).find(c => c.init.method === 'POST');
      const body = JSON.parse(post.init.body);
      check('provider POST to /infra/providers', post.url === P + '/infra/providers' && body.api_mode === 'manual');
      negative('request body carries only the reference, no raw credential key',
        body.credential_ref === 'secret:RADCLOUD_API_TOKEN' && !Object.keys(body).some(k => /password|token|secret|api_key|connection/i.test(k) && k !== 'credential_ref'));
      check('success flash + provider row', /ثبت شد/.test(flashText(o.doc, 'ok')) && !!$(o.doc, '[data-credential="reference"]'));
      check('UI shows the reference name only', $(o.doc, '[data-credential="reference"]').textContent === 'secret:RADCLOUD_API_TOKEN');
      negative('secret VALUE (env canary) never in DOM', !o.doc.body.innerHTML.includes(CANARY));
      check('mode badge says manual', $(o.doc, '[data-api-mode="manual"]').textContent === 'دستی');
      /* سرور هم رد می‌کند: کد تکراری ⇒ پیام فارسی خطا */
      $(o.doc, '[data-action="infra-add-provider"]').click();
      await dialog(o.doc, o.app, { '#dlg-code': 'radcloud', '#dlg-name': 'RadCloud 2', '#dlg-reason': REASON });
      negative('duplicate provider ⇒ server 409 shown in Persian', /قبلاً ثبت شده/.test(flashText(o.doc, 'error')));
    }
    const PID = (await db.query("SELECT id FROM owner_platform.infra_provider WHERE code='radcloud'")).rows[0].id;

    /* ── ۴. سرویس، سنجه‌ها و «نامعلوم» ─────────────────────────────── */
    {
      $(o.doc, `[data-action="infra-add-service"][data-provider="${PID}"]`).click();
      await dialog(o.doc, o.app, { '#dlg-name': 'Gateway A', '#dlg-kind': 'gateway', '#dlg-region': 'IR-THR', '#dlg-reason': REASON });
      check('service registered', /سرویس ثبت شد/.test(flashText(o.doc, 'ok')) && $$(o.doc, '.infra-service').length === 1);
      const stats = $$(o.doc, '.infra-service .stat');
      check('ten metrics rendered per service', stats.length === 10);
      negative('every metric without data shows «نامعلوم», none is a fabricated number',
        stats.every(s => s.getAttribute('data-known') === 'no' && s.querySelector('b').textContent === 'نامعلوم') && !stats.some(s => /[۰-۹0-9]/.test(s.querySelector('b').textContent)));
      check('unknown metrics labelled «بدون داده»', stats.every(s => s.querySelector('[data-label="?"]')));
    }
    const SID = (await db.query('SELECT id FROM owner_platform.infra_service LIMIT 1')).rows[0].id;
    {
      $(o.doc, `[data-action="infra-record-metric"][data-service="${SID}"]`).click();
      check('metric dialog explains labels M/E', /\[M\]/.test($(o.doc, '#dialog').textContent) && /\[E\]/.test($(o.doc, '#dialog').textContent));
      const before = o.calls.length;
      await dialog(o.doc, o.app, { '#dlg-metric': 'capacity_cpu', '#dlg-value': '-3', '#dlg-reason': REASON });
      negative('negative metric blocked client-side', o.calls.length === before);
      await dialog(o.doc, o.app, { '#dlg-value': '۴', '#dlg-label': 'M' });
      const s = $(o.doc, '.stat[data-metric="capacity_cpu"]');
      check('measured value shown with Persian digits and [M]', s.getAttribute('data-known') === 'yes' && /۴/.test(s.textContent) && s.querySelector('[data-label="M"]'));
      $(o.doc, `[data-action="infra-record-metric"][data-service="${SID}"]`).click();
      await dialog(o.doc, o.app, { '#dlg-metric': 'usage_memory', '#dlg-value': '', '#dlg-reason': REASON });
      const u = $(o.doc, '.stat[data-metric="usage_memory"]');
      check('blank value recorded as unknown, still «نامعلوم»', u.getAttribute('data-known') === 'no' && u.querySelector('b').textContent === 'نامعلوم');
      const mrow = (await db.query("SELECT value, label FROM owner_platform.infra_metric WHERE metric='usage_memory'")).rows[0];
      check('DB: unknown metric stored as NULL with label ?', mrow.value === null && mrow.label === '?');
    }

    /* ── ۵. Endpoint و Health Check ────────────────────────────────── */
    {
      $(o.doc, `[data-action="infra-add-endpoint"][data-service="${SID}"]`).click();
      const before = o.calls.length;
      await dialog(o.doc, o.app, { '#dlg-url': 'https://admin:pw@gw.example.ir/health', '#dlg-reason': REASON });
      negative('user:password in URL blocked client-side', o.calls.length === before && /رمز/.test($(o.doc, '#dlg-error').textContent));
      await dialog(o.doc, o.app, { '#dlg-url': 'tcp://db.example.ir:5432', '#dlg-checkkind': 'http' });
      negative('scheme/kind mismatch blocked', o.calls.length === before);
      await dialog(o.doc, o.app, { '#dlg-url': 'https://gw.example.ir/health', '#dlg-checkkind': 'http', '#dlg-expected': '۲۰۰' });
      check('endpoint registered', /Endpoint ثبت شد/.test(flashText(o.doc, 'ok')));
      const hb = $(o.doc, '[data-health]');
      check('never-checked endpoint: health «نامعلوم», latency «نامعلوم», last check «هرگز»',
        hb.getAttribute('data-health') === 'unknown' && hb.textContent === 'نامعلوم' && !!$(o.doc, '[data-unknown="latency"]') && /هرگز/.test($(o.doc, '#page table:last-of-type, #page').textContent));
    }
    const EID = (await db.query('SELECT id FROM owner_platform.infra_endpoint LIMIT 1')).rows[0].id;
    {
      $(o.doc, `[data-action="infra-check"][data-endpoint="${EID}"]`).click(); await settle(o.app);
      check('manual check ok ⇒ health «سالم» with latency', /سالم/.test(flashText(o.doc, 'ok')) && $(o.doc, '[data-health]').getAttribute('data-health') === 'up' && /۱۲/.test($(o.doc, '#page').textContent));
      script.push(...Array(3).fill({ ok: false, latency_ms: null, status_code: null, error_code: 'timeout' }));
      for (let i = 0; i < 3; i++) { $(o.doc, `[data-action="infra-check"][data-endpoint="${EID}"]`).click(); await settle(o.app); }
      check('failed check ⇒ «قطع» with error code', $(o.doc, '[data-health]').getAttribute('data-health') === 'down' && /timeout/.test($(o.doc, '[data-health]').textContent));
      check('3 consecutive failures ⇒ one open alert in UI', $$(o.doc, '[data-severity]').length === 1);
      $(o.doc, `[data-action="infra-check"][data-endpoint="${EID}"]`).click(); await settle(o.app);
      check('first success closes the alert', $$(o.doc, '[data-severity]').length === 0 && $(o.doc, '[data-health]').getAttribute('data-health') === 'up');
      /* cooldown واقعی ۳۰ ثانیه روی API دوم */
      const s = await open(strict, T.owner);
      $(s.doc, `[data-action="infra-check"][data-endpoint="${EID}"]`).click(); await settle(s.app);
      $(s.doc, `[data-action="infra-check"][data-endpoint="${EID}"]`).click(); await settle(s.app);
      negative('second manual check within 30 s ⇒ 429 shown in Persian (no check storm)', /۳۰ ثانیه/.test(flashText(s.doc, 'error')));
    }

    /* ── ۶. عملیات پرخطر دومرحله‌ای ────────────────────────────────── */
    const op = await open(fast, T.operator);
    {
      check('operator can request changes but has no approve button', !!$(op.doc, `[data-action="infra-req-disable-provider"][data-provider="${PID}"]`) && !$(op.doc, '[data-action="infra-approve"]'));
      $(op.doc, `[data-action="infra-req-disable-provider"][data-provider="${PID}"]`).click();
      check('request dialog explains two steps and audit', /دو مرحله/.test($(op.doc, '#dialog').textContent) && /ممیزی/.test($(op.doc, '#dialog').textContent));
      const before = op.calls.length;
      await dialog(op.doc, op.app, { '#dlg-reason': 'غیرفعال‌سازی موقت هاست برای نگه‌داری', '#dlg-retype': 'wrong' });
      negative('request: retype mismatch blocked', op.calls.length === before && !!$(op.doc, '#dialog'));
      await dialog(op.doc, op.app, { '#dlg-retype': 'radcloud' });
      check('request posted as change request (not a direct disable)', op.calls.slice(before).some(c => c.init.method === 'POST' && c.url === P + '/infra/changes'));
      negative('step 1 alone changes nothing: provider still active', (await db.query('SELECT status FROM owner_platform.infra_provider WHERE id=$1', [PID])).rows[0].status === 'active');
      check('history shows pending + «فقط مالک تأیید می‌کند»', !!$(op.doc, '[data-change-status="pending"]') && /فقط مالک تأیید می‌کند/.test($(op.doc, '#page').textContent));
    }
    const CID = (await db.query("SELECT id FROM owner_platform.infra_change_request WHERE action='disable_provider'")).rows[0].id;
    {
      const forged = await op.fetchImpl(`${P}/infra/changes/${CID}/approve`, { method: 'POST', headers: { authorization: 'Bearer ' + T.operator, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ reason: 'دور زدن UI برای تأیید' }) });
      const fj = await forged.json();
      negative('operator approving via tampered request ⇒ 403 role_forbidden', forged.status === 403 && fj.error === 'role_forbidden');
      await o.app.show('infra'); await settle(o.app);
      $(o.doc, `[data-action="infra-approve"][data-change="${CID}"]`).click();
      const before = o.calls.length;
      await dialog(o.doc, o.app, { '#dlg-reason': 'تأیید مالک برای نگه‌داری برنامه‌ریزی‌شده', '#dlg-retype': 'xxxx' });
      negative('approve: retype mismatch blocked', o.calls.length === before);
      await dialog(o.doc, o.app, { '#dlg-retype': PID.slice(0, 8) });
      check('owner approval executes once: provider disabled', (await db.query('SELECT status FROM owner_platform.infra_provider WHERE id=$1', [PID])).rows[0].status === 'disabled');
      check('history shows executed; enable request offered', !!$(o.doc, '[data-change-status="executed"]') && !!$(o.doc, `[data-action="infra-req-enable-provider"][data-provider="${PID}"]`));
      const acts = (await db.query("SELECT action FROM owner_platform.platform_audit WHERE action LIKE 'infra.change.%' ORDER BY sequence_id")).rows.map(r => r.action);
      check('both steps audited', acts.join(',') === 'infra.change.request,infra.change.approve');
    }
    {
      /* تغییر ارجاع Secret: مقدار خام رد، ارجاع تازه دومرحله‌ای */
      $(o.doc, `[data-action="infra-req-credential"][data-provider="${PID}"]`).click();
      const before = o.calls.length;
      await dialog(o.doc, o.app, { '#dlg-credref': CANARY, '#dlg-reason': 'چرخش توکن ارائه‌دهنده طبق برنامه' });
      negative('credential change with raw value blocked client-side', o.calls.length === before);
      await dialog(o.doc, o.app, { '#dlg-credref': 'secret:RADCLOUD_TOKEN_V2' });
      await dialog(o.doc, o.app, { '#dlg-reason': 'چرخش توکن ارائه‌دهنده طبق برنامه', '#dlg-retype': 'radcloud' });
      negative('pending credential change not applied yet', (await db.query('SELECT credential_ref FROM owner_platform.infra_provider WHERE id=$1', [PID])).rows[0].credential_ref === 'secret:RADCLOUD_API_TOKEN');
      const C2 = (await db.query("SELECT id FROM owner_platform.infra_change_request WHERE action='set_credential_ref'")).rows[0].id;
      $(o.doc, `[data-action="infra-approve"][data-change="${C2}"]`).click();
      await dialog(o.doc, o.app, { '#dlg-reason': 'تأیید چرخش توکن طبق برنامه', '#dlg-retype': PID.slice(0, 8) });
      check('approved credential change shows the new reference', $(o.doc, '[data-credential="reference"]').textContent === 'secret:RADCLOUD_TOKEN_V2');
      const audit = (await db.query('SELECT details::text AS d, reason FROM owner_platform.platform_audit')).rows.map(r => r.d + r.reason).join('\n');
      negative('secret value never in audit', !audit.includes(CANARY));
      negative('no request body ever carried the secret value', ![...o.calls, ...op.calls].some(c => String((c.init && c.init.body) || '').includes(CANARY) && !/dlg/.test(c.url)));
    }

    /* ── ۷. نقش support: فقط مشاهده ───────────────────────────────── */
    {
      const sp = await open(fast, T.support);
      check('support sees infra read-only (no register/check/request/approve)',
        !$(sp.doc, '[data-action^="infra-"]') && /فقط مشاهده/.test($(sp.doc, '#page').textContent) && !states(sp.doc).includes('error'));
    }

    /* ── ۸. ساخت مدرسه ─────────────────────────────────────────────── */
    {
      await op.app.show('schools'); await settle(op.app);
      check('operator has no create-school button', !$(op.doc, '[data-action="create-school"]'));
      await o.app.show('schools'); await settle(o.app);
      $(o.doc, '[data-action="create-school"]').click();
      const before = o.calls.length;
      await dialog(o.doc, o.app, { '#dlg-slug': 'Bad Slug', '#dlg-name': 'دبستان نمونه', '#dlg-manager': 'خانم رضایی', '#dlg-reason': 'ساخت مدرسهٔ تازه به درخواست مالک' });
      negative('invalid slug blocked client-side', o.calls.length === before);
      failNext = 1;
      await dialog(o.doc, o.app, { '#dlg-slug': 'school-12' });
      negative('school side failure ⇒ 502 Persian message, retry is safe', /تلاش دوباره/.test(flashText(o.doc, 'error')) && !$(o.doc, '#once'));
      $(o.doc, '[data-action="create-school"]').click();
      await dialog(o.doc, o.app, { '#dlg-slug': 'school-12', '#dlg-name': 'دبستان نمونه', '#dlg-manager': 'خانم رضایی', '#dlg-reason': 'ساخت مدرسهٔ تازه به درخواست مالک' });
      const posts = o.calls.filter(c => c.init.method === 'POST' && c.url === P + '/tenants').map(c => JSON.parse(c.init.body));
      check('retry reuses the same provision_op_id (no second school)', posts.length === 2 && posts[0].provision_op_id === posts[1].provision_op_id);
      check('one tenant in registry, active', (await count("SELECT count(*)::int AS n FROM owner_platform.tenant_registry WHERE slug='school-12' AND status='active'")) === 1
        && (await count('SELECT count(*)::int AS n FROM owner_platform.tenant_registry')) === 1);
      const code = codes[codes.length - 1];
      check('activation code shown once in a modal', !!$(o.doc, '#once') && $(o.doc, '#activation-code').textContent === code);
      negative('activation code not in flash message', !flashText(o.doc, 'ok').includes(code));
      $(o.doc, '[data-action="once-close"]').click();
      negative('after closing, the code is gone from the DOM', !o.doc.body.innerHTML.includes(code));
      let stored = ''; for (let i = 0; i < o.win.localStorage.length; i++) stored += o.win.localStorage.getItem(o.win.localStorage.key(i));
      negative('code not persisted in localStorage or URL', !stored.includes(code) && !String(o.win.location.href).includes(code));
      const aud = (await db.query("SELECT details::text AS d FROM owner_platform.platform_audit WHERE action LIKE 'tenant.%'")).rows.map(r => r.d).join('');
      negative('code never written to audit', !aud.includes(code) && /school-12/.test(aud));
      await o.app.show('infra'); await settle(o.app); await o.app.show('schools'); await settle(o.app);
      negative('code not shown again on revisit', !$(o.doc, '#once') && !o.doc.body.innerHTML.includes(code));
    }

    /* ── ۹. حالت error و loading ───────────────────────────────────── */
    {
      const dd = await open(deadPort, T.owner);
      const st = states(dd.doc);
      check(`no upstream ⇒ infra error state (${st.join(',')})`, st.includes('error') && !st.includes('loading') && /تنظیم نشده/.test($(dd.doc, '#page').textContent));
      const h = makeDom(fast);
      const hang = () => new Promise(() => {});
      const app = h.win.OwnerPanel.createApp({ document: h.doc, window: h.win, fetch: hang, session: T.owner });
      app.start(); await new Promise(r => setTimeout(r, 5));
      app.show('infra'); await new Promise(r => setTimeout(r, 5));
      check('loading state while infra request pending', states(h.doc).includes('loading'));
    }
  } finally {
    for (const s of servers) await close(s);
    await db.close();
    if (prevEnv === undefined) delete process.env.RADCLOUD_API_TOKEN; else process.env.RADCLOUD_API_TOKEN = prevEnv;
    if (hadWindow) global.window = previousWindow;
  }
  return { checks: CHECKS, negative: NEG };
}

module.exports = { run };

if (require.main === module) {
  run().then((r) => { console.log(`OWNER-SPA-INFRA-123 checks=${r.checks} negative_controls=${r.negative} failures=0`); })
    .catch((e) => { console.error('OWNER-SPA-INFRA-123 FAILED after checks=' + CHECKS + ':', e && e.stack || e); process.exit(1); });
}
