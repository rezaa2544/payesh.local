'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمونهای PR-2 — API مستقل پلتفرم
   • auth(): جداسازی توکن/نقش، بدون دیتابیس
   • contract(): انطباق OpenAPI و allowlist خروجی، بدون دیتابیس
   • integration(): PGlite + migrations 001/002؛ آزمون منفی برای تکتک کنترلها
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const api = require('../server/platform-api');
const tenancy = require('../../../server/tenancy');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const SERVER_DIR = path.join(ROOT, 'apps', 'owner-panel', 'server');
/* رازهای صرفاً آزمایشی، در حافظه و تصادفی؛ هیچ راز/کلیدی در مخزن ذخیره نمیشود. */
const SECRET = crypto.randomBytes(32).toString('hex');
const SCHOOL_SECRET = crypto.randomBytes(32).toString('hex');
const uuid = () => crypto.randomUUID();
const P = '/api/platform/v1';

function token(sub, role, opts = {}) {
  return api.signPlatformToken(Object.assign({
    sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: uuid(),
  }, opts), SECRET);
}

/* ───────────────────────── ۱. احراز مستقل ───────────────────────────── */
function auth() {
  const sub = uuid();
  const good = token(sub, 'platform_owner');
  assert.deepStrictEqual(api.verifyPlatformToken(good, SECRET).sub, sub, 'valid platform token accepted');

  /* توکن مدرسه روی API پلتفرم ⇒ رد */
  const schoolToken = tenancy.signToken({ tid: uuid(), exp: Date.now() + 3600_000 }, SCHOOL_SECRET);
  assert.strictEqual(api.verifyPlatformToken(schoolToken, SECRET), null, 'school token is rejected by platform API');
  assert.strictEqual(api.verifyPlatformToken(schoolToken, SCHOOL_SECRET), null, 'school token is rejected even with school secret');

  /* توکن پلتفرم روی API مدرسه ⇒ رد */
  assert.throws(() => tenancy.verifyToken(good, SCHOOL_SECRET), /unauthorized/,
    'platform token is rejected by school API');
  assert.throws(() => tenancy.verifyToken(good, SECRET), /unauthorized/,
    'platform token is rejected by school API even with platform secret');

  assert.strictEqual(api.verifyPlatformToken('', SECRET), null, 'missing token rejected');
  assert.strictEqual(api.verifyPlatformToken('Bearer ' + good, SECRET), null, 'raw token must not include Bearer');
  assert.strictEqual(api.verifyPlatformToken(good.slice(0, -2) + 'xy', SECRET), null, 'tampered signature rejected');
  assert.strictEqual(api.verifyPlatformToken(token(sub, 'platform_owner', { exp: Date.now() - 1000 }), SECRET), null, 'expired token rejected');
  assert.strictEqual(api.verifyPlatformToken(token(sub, 'school_manager'), SECRET), null, 'unknown role rejected');
  assert.strictEqual(api.verifyPlatformToken('v1.abc.def', SECRET), null, 'wrong namespace rejected');
  assert.strictEqual(api.verifyPlatformToken(good, 'short'), null, 'weak secret fails closed');

  /* تغییر نقش داخل بدنهٔ توکن بدون امضای دوباره باید رد شود */
  const parts = good.split('.');
  const forgedBody = Buffer.from(JSON.stringify(Object.assign(
    JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8')), { role: 'platform_support' }))).toString('base64url');
  assert.strictEqual(api.verifyPlatformToken(`platform.v1.${forgedBody}.${parts[3]}`, SECRET), null,
    'unsigned role escalation rejected');

  /* هیچ وابستگی به احراز مدرسه در کد API نباید باشد */
  const src = fs.readFileSync(path.join(SERVER_DIR, 'platform-api.js'), 'utf8');
  const gw = fs.readFileSync(path.join(ROOT, 'server', 'gateway.js'), 'utf8');
  assert.ok(!/require\(['"][^'"]*(server\/auth|tenancy|\.\/auth|\.\.\/index)['"]\)/.test(src),
    'platform API does not import school auth modules');
  assert.ok(!/tenancy\.verifyToken/.test(src), 'platform API does not call school token verifier');
  assert.ok(!/postgres:\/\//.test(src + gw), 'no hard-coded database URL');
  assert.ok(!/PAYESH_PLATFORM_TOKEN_SECRET\s*=\s*['"][^'"]+['"]/.test(gw), 'no hard-coded platform secret');
  assert.ok(gw.includes('PAYESH_PLATFORM_PGURL'), 'dedicated platform pool is configuration-driven');
}

/* ─────────────── ۲. قرارداد OpenAPI و allowlist خروجی ───────────────── */
function contract() {
  const spec = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'openapi.json'), 'utf8'));
  assert.strictEqual(spec.openapi, '3.0.3');
  assert.strictEqual(spec.servers[0].url, api.PREFIX);
  assert.strictEqual(spec['x-default-deny'], true);

  const actual = api.PLATFORM_ROUTES.map(r => `${r.method} ${r.path}`).sort();
  const documented = [];
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const m of Object.keys(ops)) if (/^(get|post|put|patch|delete)$/i.test(m)) documented.push(`${m.toUpperCase()} ${p}`);
  }
  assert.deepStrictEqual(documented.sort(), actual, 'OpenAPI paths/methods exactly match the router');
  assert.ok(spec.components.securitySchemes.PlatformToken, 'platform security scheme documented');

  /* allowlist: حتی اگر فیلد ممنوع در لیست خروجی بیاید، بیرون نمیرود */
  const row = { id: 'u1', login_id: 'owner', national_id: '0012345678',
    password_hash: 'x', password_enc: 'y', token: 't', access_token: 'a',
    secret: 's', authorization: 'z', cookie: 'c', api_key: 'k' };
  const out = api.project(row, Object.keys(row));
  assert.deepStrictEqual(Object.keys(out).sort(), ['id', 'login_id'],
    'forbidden fields are never emitted');
  assert.deepStrictEqual(api.projectRows([row, row], api.FIELDS.user).length, 2);
  assert.ok(api.FIELDS.user.every(k => !/password|token|secret|national_id/i.test(k)),
    'declared user allowlist contains no forbidden field');

  /* namespace جدا، بدون لمس client/pages.js */
  assert.ok(api.PREFIX.startsWith('/api/platform/'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'apps', 'owner-panel', 'server', 'pages.js')));
}

/* ─────────────────── ۳. یکپارچگی با PGlite ──────────────────────────── */
function pgliteAdapter(db) {
  return {
    async withTransaction(fn) {
      await db.exec('BEGIN');
      try {
        /* شبیهسازی لاگین واقعی سرویس پلتفرم؛ RLS واقعاً اعمال میشود */
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

async function integration() {
  /* jsdom در tests/run.js متغیر global.window میگذارد؛ PGlite باید آن را نبیند */
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  if (hadWindow) delete global.window;

  const db = new PGlite();
  let checks = 0;
  const negative = (label, condition) => { checks++; assert.ok(condition, 'negative control: ' + label); };

  try {
    const up1 = fs.readFileSync(path.join(MIG, '001_owner_panel.up.sql'), 'utf8');
    const up2 = fs.readFileSync(path.join(MIG, '002_owner_panel_api.up.sql'), 'utf8');
    const down1 = fs.readFileSync(path.join(MIG, '001_owner_panel.down.sql'), 'utf8');
    const down2 = fs.readFileSync(path.join(MIG, '002_owner_panel_api.down.sql'), 'utf8');

    /* جدول محتوای مدرسه پیش از migration 002 ساخته میشود تا grant شرطی اعمال شود */
    await db.exec(`CREATE TABLE public.product_records (
      tenant_id uuid NOT NULL, collection text NOT NULL, record_id bigint NOT NULL,
      version integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}'::jsonb,
      deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, collection, record_id))`);
    await db.exec(`ALTER TABLE public.product_records ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.product_records FORCE ROW LEVEL SECURITY;
      CREATE POLICY product_records_isolation ON public.product_records
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
    await db.exec(up1);
    await db.exec(up2);

    const A = uuid(), B = uuid();
    const OWNER = uuid(), OPERATOR = uuid();
    const SUPPORT = uuid(), SUPPORT2 = uuid(), SUPPORT3 = uuid(), SUPPORT4 = uuid();
    const RATE = uuid();
    const users = [
      [OWNER, 'owner-1', 'platform_owner'], [OPERATOR, 'operator-1', 'platform_operator'],
      [SUPPORT, 'support-1', 'platform_support'], [SUPPORT2, 'support-2', 'platform_support'],
      [SUPPORT3, 'support-3', 'platform_support'], [SUPPORT4, 'support-4', 'platform_support'],
      [RATE, 'rate-only', 'platform_support'],
    ];
    for (const [id, login, role] of users) {
      await db.query('INSERT INTO owner_platform.platform_users(id,login_id,role) VALUES ($1,$2,$3)', [id, login, role]);
    }
    await db.query(`INSERT INTO owner_platform.plans(code,name,storage_mb)
      VALUES ('basic','پایه',1024)`);
    const subs = {};
    for (const t of [A, B]) {
      const r = await db.query(`INSERT INTO owner_platform.subscriptions
        (tenant_id,plan_code,status,starts_at,ends_at) VALUES ($1,'basic','active',now()-interval '1 day',now()+interval '30 days')
        RETURNING id`, [t]);
      subs[t] = r.rows[0].id;
      await db.query('INSERT INTO owner_platform.tenant_limits(tenant_id,storage_bytes) VALUES ($1,$2)', [t, 1024]);
      await db.query('INSERT INTO owner_platform.tenant_usage(tenant_id,users_count,students_count,storage_bytes) VALUES ($1,2,30,100)', [t]);
    }
    await db.query(`INSERT INTO public.product_records(tenant_id,collection,record_id,data)
      VALUES ($1,'people',1,'{"name":"A"}'),($2,'people',1,'{"name":"B"}')`, [A, B]);

    const now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    const window = { starts_at: iso(now - 60_000), ends_at: iso(now + 3600_000), school_notified_at: iso(now - 120_000) };
    const grants = {};
    async function grant(operator, tenant, overrides = {}) {
      const id = uuid();
      const g = Object.assign({ id, tenant_id: tenant, operator_id: operator, approved_by: OWNER,
        case_ref: 'case-' + id.slice(0, 6), scope: 'content_read',
        reason: 'رسیدگی به درخواست پشتیبانی مدرسه', max_actions: 3, open_slot: 1 }, window, overrides);
      await db.query(`INSERT INTO owner_platform.support_grant
        (id,tenant_id,operator_id,approved_by,case_ref,scope,reason,starts_at,ends_at,school_notified_at,max_actions,open_slot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [g.id, g.tenant_id, g.operator_id, g.approved_by, g.case_ref, g.scope, g.reason,
        g.starts_at, g.ends_at, g.school_notified_at, g.max_actions, g.open_slot]);
      return id;
    }
    grants.active = await grant(SUPPORT, A);
    grants.crossTenant = await grant(SUPPORT2, B);
    grants.expired = await grant(SUPPORT3, A, {
      starts_at: iso(now - 4 * 3600_000), ends_at: iso(now - 3 * 3600_000),
      school_notified_at: iso(now - 5 * 3600_000),
    });
    grants.revoked = await grant(SUPPORT4, A);
    await db.query('UPDATE owner_platform.support_grant SET revoked_at=clock_timestamp() WHERE id=$1', [grants.revoked]);

    const dbAdapter = pgliteAdapter(db);
    const platform = api.createPlatformApi({ db: dbAdapter, secret: SECRET, instance: 'test-platform' });
    const limited = api.createPlatformApi({ db: dbAdapter, secret: SECRET,
      rateLimitMax: 3, rateLimitWindowSec: 60, instance: 'test-platform-limited' });
    const T = {
      owner: token(OWNER, 'platform_owner'),
      operator: token(OPERATOR, 'platform_operator'),
      support: token(SUPPORT, 'platform_support'),
      support2: token(SUPPORT2, 'platform_support'),
      support3: token(SUPPORT3, 'platform_support'),
      support4: token(SUPPORT4, 'platform_support'),
      rate: token(RATE, 'platform_support'),
    };
    const call = (a, method, suffix, tok, body, rid) => a.dispatch({
      method, path: P + suffix,
      headers: Object.assign(tok ? { authorization: 'Bearer ' + tok } : {}, rid ? { 'x-request-id': rid } : {}),
      body: body || {},
    });

    /* ── کنترل ۱: namespace و مسیر ناشناخته ─────────────────────────── */
    const inside = await call(platform, 'GET', '/dashboard', T.owner);
    assert.strictEqual(inside.status, 200, 'dashboard is served only inside /api/platform/v1');
    const outside = await platform.dispatch({ method: 'GET', path: '/api/school/v1/me', headers: {} });
    negative('school namespace not served by platform API', outside.status === 404);
    const unknown = await call(platform, 'GET', '/does-not-exist', T.owner);
    negative('unknown platform route is 404', unknown.status === 404);

    /* ── کنترل ۲: بدون توکن / توکن مدرسه / امضای جعلی ────────────────── */
    const noToken = await call(platform, 'GET', '/dashboard', null);
    negative('no token ⇒ 401', noToken.status === 401);
    const schoolTok = tenancy.signToken({ tid: A, exp: Date.now() + 3600_000 }, SCHOOL_SECRET);
    const schoolOnPlatform = await call(platform, 'GET', '/dashboard', schoolTok);
    negative('school token on platform API ⇒ 401', schoolOnPlatform.status === 401);
    const forged = await call(platform, 'GET', '/dashboard', T.owner.slice(0, -2) + 'xy');
    negative('forged signature ⇒ 401', forged.status === 401);
    const expired = await call(platform, 'GET', '/dashboard', token(OWNER, 'platform_owner', { exp: Date.now() - 1000 }));
    negative('expired token ⇒ 401', expired.status === 401);

    /* ── کنترل ۳: request-id ─────────────────────────────────────────── */
    const withRid = await call(platform, 'GET', '/dashboard', T.owner, null, 'req-fixed-0001');
    assert.strictEqual(withRid.headers['x-request-id'], 'req-fixed-0001', 'valid request-id is echoed');
    const badRid = await call(platform, 'GET', '/dashboard', T.owner, null, 'bad id with spaces');
    assert.ok(/^[0-9a-f-]{36}$/i.test(badRid.headers['x-request-id']), 'malformed request-id replaced');
    assert.strictEqual(withRid.status, 200, 'authenticated metadata read succeeds');

    /* ── کنترل ۴: rate-limit ─────────────────────────────────────────── */
    /* سوژهٔ اختصاصی تا شمارندهٔ سایر آزمونها در آن دخیل نباشد */
    for (let i = 0; i < 3; i++) {
      const r = await call(limited, 'GET', '/dashboard', T.rate);
      negative('rate-limit allows request ' + (i + 1) + ' ' + JSON.stringify(r.body), r.status === 200);
    }
    const throttled = await call(limited, 'GET', '/dashboard', T.rate);
    negative('4th request over a max of 3 ⇒ 429', throttled.status === 429 && throttled.body.error === 'rate_limited');
    assert.strictEqual(throttled.headers['x-ratelimit-limit'], '3');
    assert.ok(throttled.body.retry_after_ms > 0, 'retry_after_ms present');

    /* ── کنترل ۵: allowlist خروجی در پاسخ واقعی ──────────────────────── */
    const usersResp = await call(platform, 'GET', '/platform-users', T.owner);
    assert.strictEqual(usersResp.status, 200);
    const flat = JSON.stringify(usersResp.body);
    negative('no password/token/national_id in a real response',
      !/password|token|secret|national_id|authorization|cookie|api_key/i.test(flat));
    assert.ok(usersResp.body.users.every(u => Object.keys(u).every(k => api.FIELDS.user.includes(k))),
      'response keys are exactly the declared allowlist');

    /* ── کنترل ۶: محتوا پیشفرض رد ────────────────────────────────────── */
    const bulk = await call(platform, 'GET', `/tenants/${A}/content`, T.support);
    negative('bulk content list ⇒ 403', bulk.status === 403 && bulk.body.error === 'bulk_content_forbidden');
    const noGrant = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.operator);
    negative('no grant ⇒ 403 on content point', noGrant.status === 403 && noGrant.body.error === 'grant_required');
    const wrongTenant = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support2);
    negative('grant of another tenant ⇒ 403', wrongTenant.status === 403);
    const expiredGrant = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support3);
    negative('expired grant ⇒ 403', expiredGrant.status === 403);
    const revokedGrant = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support4);
    negative('revoked grant ⇒ 403', revokedGrant.status === 403);
    const badRef = await call(platform, 'GET', `/tenants/${A}/content/people/../../etc`, T.support);
    negative('path traversal in record_ref ⇒ 404/400', badRef.status === 404 || badRef.status === 400);

    /* ── کنترل ۷: خواندن تکرکورد مجاز، لاگ و سقف اعمال ───────────────── */
    const c1 = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support);
    assert.strictEqual(c1.status, 200, 'one record with an active grant succeeds: ' + JSON.stringify(c1.body));
    assert.deepStrictEqual(c1.body.content.data, { name: 'A' }, 'RLS returns only this tenant\'s record');
    assert.strictEqual(c1.body.content.found, true);
    const c2 = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support);
    assert.strictEqual(c2.status, 200, 'second counted read succeeds');
    const logCount = await db.query('SELECT count(*)::int AS n, max(used_reads)::int AS used FROM owner_platform.support_access_log l JOIN owner_platform.support_grant g ON g.id=l.grant_id WHERE g.id=$1', [grants.active]);
    /* max(used_reads) روی grant جداگانه خوانده میشود */
    const used = await db.query('SELECT used_reads FROM owner_platform.support_grant WHERE id=$1', [grants.active]);
    assert.strictEqual(logCount.rows[0].n, 2, 'each content read creates one log row');
    assert.strictEqual(used.rows[0].used_reads, 2, 'used_reads incremented per read');
    const c3 = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support);
    assert.strictEqual(c3.status, 200, 'third read within cap succeeds');
    const overCap = await call(platform, 'GET', `/tenants/${A}/content/people/1`, T.support);
    negative('read beyond action cap ⇒ 403', overCap.status === 403);

    /* ── کنترل ۸: content_write و window/reason/notice ───────────────── */
    const grantBody = {
      tenant_id: A, scope: 'metadata', reason: 'رسیدگی به خطای سامانه مدرسه',
      starts_at: window.starts_at, ends_at: window.ends_at,
      school_notified_at: window.school_notified_at, max_actions: 1,
    };
    const cw = await call(platform, 'POST', '/support-grants', T.support, Object.assign({}, grantBody, { scope: 'content_write' }));
    negative('content_write scope ⇒ 400', cw.status === 400 && cw.body.error === 'invalid_scope');
    const shortReason = await call(platform, 'POST', '/support-grants', T.support, Object.assign({}, grantBody, { reason: 'کوتاه' }));
    negative('reason shorter than 10 ⇒ 400', shortReason.status === 400);
    const longWindow = await call(platform, 'POST', '/support-grants', T.support,
      Object.assign({}, grantBody, { ends_at: iso(Date.now() + 73 * 3600_000) }));
    negative('window over 72h ⇒ 400', longWindow.status === 400);
    const lateNotice = await call(platform, 'POST', '/support-grants', T.support,
      Object.assign({}, grantBody, { school_notified_at: iso(Date.now() + 60_000) }));
    negative('school notice after start ⇒ 400', lateNotice.status === 400);
    const ownerRequest = await call(platform, 'POST', '/support-grants', T.owner, grantBody);
    negative('owner may not request a grant (four eyes) ⇒ 403', ownerRequest.status === 403);

    /* ── کنترل ۹: درخواست → تأیید مالک (چهارچشم) ─────────────────────── */
    const reqResp = await call(platform, 'POST', '/support-grants', T.operator, grantBody);
    assert.strictEqual(reqResp.status, 201, 'operator can file a pending grant request');
    const requestId = reqResp.body.request.id;
    const selfApprove = await call(platform, 'POST', `/support-grants/${requestId}/approve`, T.operator, { reason: 'تأیید توسط خود درخواستکننده' });
    negative('operator cannot approve ⇒ 403', selfApprove.status === 403);
    const approve = await call(platform, 'POST', `/support-grants/${requestId}/approve`, T.owner, { reason: 'تأیید مالک پس از بررسی درخواست' });
    assert.strictEqual(approve.status, 200, 'active owner approves: ' + JSON.stringify(approve.body));
    const approved = await db.query('SELECT approved_by, operator_id, status FROM owner_platform.support_grant_request WHERE id=$1', [requestId]);
    assert.strictEqual(approved.rows[0].approved_by, OWNER, 'approver is the owner');
    assert.notStrictEqual(approved.rows[0].approved_by, approved.rows[0].operator_id, 'four eyes holds');

    /* ── کنترل ۱۰: اپراتور مجاز به تمدید/حذف نیست ─────────────────────── */
    const renewByOperator = await call(platform, 'POST', `/subscriptions/${subs[A]}/renew`, T.operator, { reason: 'تمدید توسط اپراتور ممنوع است' });
    negative('operator renew ⇒ 403', renewByOperator.status === 403 && renewByOperator.body.error === 'role_forbidden');
    const renewByOwner = await call(platform, 'POST', `/subscriptions/${subs[A]}/renew`, T.owner,
      { reason: 'تمدید اشتراک توسط مالک پلتفرم' });
    assert.strictEqual(renewByOwner.status, 200, 'owner renew succeeds: ' + JSON.stringify(renewByOwner.body));
    const renewAgain = await call(platform, 'POST', `/subscriptions/${subs[A]}/renew`, T.owner,
      { reason: 'تمدید تکراری همان درخواست', idempotency_key: 'fixed-key' });
    const renewAgain2 = await call(platform, 'POST', `/subscriptions/${subs[A]}/renew`, T.owner,
      { reason: 'تمدید تکراری همان درخواست', idempotency_key: 'fixed-key' });
    assert.strictEqual(renewAgain2.body.transition.idempotent, true, 'idempotency key is honoured');
    assert.ok(renewAgain.status === 200);
    const del = await call(platform, 'DELETE', `/tenants/${A}`, T.owner);
    negative('tenant deletion always 403', del.status === 403 && del.body.error === 'tenant_deletion_disabled');
    const planByOperator = await call(platform, 'POST', '/plans', T.operator,
      { code: 'evil', name: 'غیرمجاز', storage_mb: 1 });
    negative('operator cannot create a plan', planByOperator.status === 403);
    const planByOwner = await call(platform, 'POST', '/plans', T.owner,
      { code: 'pro', name: 'حرفهای', storage_mb: 4096, reason: 'تعریف طرح جدید توسط مالک' });
    assert.strictEqual(planByOwner.status, 201, 'owner creates a plan: ' + JSON.stringify(planByOwner.body));

    /* ── کنترل ۱۱: تعلیق اپراتور با دلیل، بدون دلیل رد ────────────────── */
    const suspendNoReason = await call(platform, 'POST', `/tenants/${A}/suspend`, T.operator, { reason: 'کم' });
    negative('suspend without a 10-char reason ⇒ 400', suspendNoReason.status === 400);
    const suspend = await call(platform, 'POST', `/tenants/${A}/suspend`, T.operator,
      { reason: 'تعلیق به دلیل نقض سقف مصرف مدرسه' });
    assert.strictEqual(suspend.status, 200, 'operator suspension with reason succeeds: ' + JSON.stringify(suspend.body));

    /* ── کنترل ۱۲: زنجیرهٔ هش حسابرسی قابل بازتولید ──────────────────── */
    const auditResp = await call(platform, 'GET', '/audit', T.owner);
    assert.strictEqual(auditResp.status, 200);
    assert.ok(auditResp.body.events.length >= 6, 'mutations appended audit events');
    const rows = await db.query(`SELECT event_id, actor_id, actor_ref, action, subject_type,
      subject_ref, tenant_id, reason, details, created_at,
      encode(previous_hash,'hex') AS previous_hash, encode(event_hash,'hex') AS event_hash
      FROM owner_platform.platform_audit ORDER BY sequence_id`);
    let previous = '00'.repeat(32);
    for (const r of rows.rows) {
      assert.strictEqual(r.previous_hash, previous, 'previous_hash equals the real chain head');
      const expected = crypto.createHash('sha256')
        .update(Buffer.from(previous, 'hex'))
        .update(Buffer.from(api.auditPayload(r), 'utf8')).digest('hex');
      assert.strictEqual(r.event_hash, expected, 'event_hash is reproducible from the stored row');
      previous = r.event_hash;
    }
    const auditFlat = JSON.stringify(auditResp.body);
    negative('audit response has no secrets', !/password|national_id|token|secret/i.test(auditFlat));

    /* ── کنترل ۱۳: عدم تنظیم ⇒ 503 (fail-closed) ──────────────────────── */
    const unconfigured = api.createPlatformApi({ db: null, secret: '' });
    const u1 = await call(unconfigured, 'GET', '/dashboard', T.owner);
    negative('no db/secret ⇒ 503', u1.status === 503 && u1.body.error === 'not_configured');
    const u2 = await call(unconfigured, 'GET', '/health/summary', null);
    assert.strictEqual(u2.status, 200);
    assert.strictEqual(u2.body.configured, false, 'health reports the unconfigured state honestly');

    /* ── کنترل ۱۴: مسیرهای متادیتا و OpenAPI ─────────────────────────── */
    for (const suffix of ['/dashboard', '/tenants', `/tenants/${A}`, `/tenants/${A}/limits`,
      `/tenants/${A}/usage`, '/plans', '/subscriptions', '/support-grants', '/openapi.json']) {
      const r = await call(platform, 'GET', suffix, T.owner);
      assert.strictEqual(r.status, 200, 'metadata route ' + suffix + ' works');
    }
    const cross = await call(platform, 'GET', `/tenants/${B}`, T.owner);
    assert.strictEqual(cross.status, 200, 'platform metadata is cross-tenant by design');
    negative('cross-tenant metadata never exposes content',
      !/national_id|password|"data"/.test(JSON.stringify(cross.body)));

    /* ── کنترل ۱۵: grantهای runtime همچنان محدودند ───────────────────── */
    const priv = await db.query(`SELECT
      has_table_privilege('payesh_platform_runtime','public.product_records','SELECT') AS content_read,
      has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','INSERT') AS sub_insert,
      has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','UPDATE') AS sub_update,
      has_table_privilege('payesh_platform_runtime','owner_platform.invoice','SELECT') AS invoice_read,
      has_table_privilege('payesh_platform_owner','public.product_records','SELECT') AS owner_content_read`);
    negative('runtime still has no content/subscription/invoice grant',
      !priv.rows[0].content_read && !priv.rows[0].sub_insert && !priv.rows[0].sub_update && !priv.rows[0].invoice_read);
    assert.strictEqual(priv.rows[0].owner_content_read, true,
      'only the SECURITY DEFINER owner holds the narrow content SELECT');

    /* ── کنترل ۱۶: معکوسپذیری migration 002 ──────────────────────────── */
    await db.exec(down2);
    const afterDown2 = await db.query(`SELECT to_regprocedure('owner_platform.read_school_record(uuid,uuid,text,text)') IS NULL AS gone,
      to_regclass('owner_platform.api_rate_limit') IS NULL AS rate_gone,
      to_regclass('owner_platform.support_grant_request') IS NULL AS req_gone`);
    assert.ok(Object.values(afterDown2.rows[0]).every(Boolean), 'down 002 removes only its own objects');
    const stillThere = await db.query(`SELECT to_regclass('owner_platform.support_grant') IS NOT NULL AS kept`);
    assert.strictEqual(stillThere.rows[0].kept, true, 'down 002 leaves migration 001 intact');
    await db.exec(up2);
    await db.exec(down2);
    await db.exec(down1);
    const gone = await db.query("SELECT to_regnamespace('owner_platform') IS NULL AS gone");
    assert.strictEqual(gone.rows[0].gone, true, 'down 001 removes the schema after 002 rollback');

    assert.ok(checks >= 25, 'negative control count recorded: ' + checks);
  } finally {
    try { await db.close(); } catch (_) { /* noop */ }
    if (hadWindow) global.window = previousWindow;
    else delete global.window;
  }
  return { negative_controls: checks };
}

module.exports = { auth, contract, integration };
