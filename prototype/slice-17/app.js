'use strict';
// نمونهٔ فنی ۱۷ — vertical slice: login → API محافظت‌شده → پنل نقش‌محور
// مرجع: ۰۱ §۳.۲ (ماتریس نقش×داده)، ۱۲ §۱–۲ (Tenant Resolver + DAL)، ۱۲ §۳ (sessions/audit)
// قاعدهٔ سخت: tenant_id فقط از نشست؛ tenant_id در بدنه/کوئری/هدر نادیده گرفته می‌شود.

const http = require('node:http');
const crypto = require('node:crypto');
const { can, isPlatformRole, ROLES } = require('./policy');
const { Store, Denied, withTenant, uuid } = require('./store');
const { hashPassword, verifyPassword, Sessions, AuditLog } = require('./auth');

const PLATFORM_TENANT = '00000000-0000-4000-8000-000000000001'; // مستأجر مجازی سطح پلتفرم

function build({ now } = {}) {
  const store = new Store();
  const audit = new AuditLog();
  const sessions = new Sessions(store, crypto.randomBytes(32), now ? { now } : {});

  const tenantA = store.createTenant({ id: uuid(), code: 'sch-a', name: 'مدرسهٔ الف' });
  const tenantB = store.createTenant({ id: uuid(), code: 'sch-b', name: 'مدرسهٔ ب' });

  function addUser({ tenant_id, username, password, role, class_ids = [], child_ids = [], student_id = null }) {
    return store.insertRow({ tenant_id }, 'users', {
      id: uuid(), tenant_id, username, role,
      password_hash: hashPassword(password),
      class_ids, child_ids, student_id, disabled: false,
    });
  }

  // --- دادهٔ نمونه: دو مستأجر با ساختار یکسان (برای آزمون جداسازی) ---
  const seed = {};
  for (const [key, tenant] of [['A', tenantA], ['B', tenantB]]) {
    const s1 = store.insertRow({ tenant_id: tenant.id }, 'students', {
      id: uuid(), tenant_id: tenant.id, class_id: `${key}-10-1`, name: `هنرجو ${key}۱`,
    });
    const s2 = store.insertRow({ tenant_id: tenant.id }, 'students', {
      id: uuid(), tenant_id: tenant.id, class_id: `${key}-11-2`, name: `هنرجو ${key}۲`,
    });
    const manager = addUser({ tenant_id: tenant.id, username: `manager.${key.toLowerCase()}`, password: 'Manager!Pass1', role: 'manager' });
    const teacher = addUser({ tenant_id: tenant.id, username: `teacher.${key.toLowerCase()}`, password: 'Teacher!Pass1', role: 'teacher', class_ids: [`${key}-10-1`] });
    const parent = addUser({ tenant_id: tenant.id, username: `parent.${key.toLowerCase()}`, password: 'Parent!Pass1', role: 'parent', child_ids: [s1.student_id || s1.id] });
    const student = addUser({ tenant_id: tenant.id, username: `student.${key.toLowerCase()}`, password: 'Student!Pass1', role: 'student', student_id: s1.id });
    const guard = addUser({ tenant_id: tenant.id, username: `guard.${key.toLowerCase()}`, password: 'Guard!Pass1', role: 'guard' });
    const grades = [
      store.insertRow({ tenant_id: tenant.id }, 'grades', { id: uuid(), tenant_id: tenant.id, student_id: s1.id, class_id: s1.class_id, subject: 'ریاضی', score: 18 }),
      store.insertRow({ tenant_id: tenant.id }, 'grades', { id: uuid(), tenant_id: tenant.id, student_id: s2.id, class_id: s2.class_id, subject: 'ریاضی', score: 12 }),
    ];
    seed[key] = { tenant, students: [s1, s2], manager, teacher, parent, student, guard, grades };
  }

  const platformSupport = store.insertRow({ tenant_id: PLATFORM_TENANT }, 'users', {
    id: uuid(), tenant_id: PLATFORM_TENANT, username: 'support', role: 'platform_support',
    password_hash: hashPassword('Support!Pass1'), class_ids: [], child_ids: [], student_id: null, disabled: false,
  });

  // --- کمکی‌ها ---
  const json = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(data);
  };

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  }

  // scopedIds: دامنهٔ S0..S3 را به فیلتر ردیف ترجمه می‌کند (بدون دامنه ⇒ صفر ردیف)
  function rowAllowed(session, user, row, scope) {
    if (row.tenant_id !== session.tenant_id) return false;         // لایهٔ RLS
    if (scope === 'S3') return true;
    if (scope === 'S2') return user.class_ids.includes(row.class_id);
    if (scope === 'S1') return user.child_ids.includes(row.student_id);
    if (scope === 'S0') return user.student_id === row.student_id || row.id === user.student_id;
    return false;                                                  // S4 در دادهٔ مدرسه معنا ندارد
  }

  function log(session, action, decision, extra = {}) {
    return audit.append({
      at: new Date().toISOString(), tenant_id: session?.tenant_id || null,
      user_id: session?.user_id || null, role: session?.role || null,
      action, decision, ...extra,
    });
  }

  async function handleLogin(req, res, body) {
    const { username, password, tenant_id: bodyTenant } = body || {};
    if (!username || !password) return json(res, 400, { error: 'credentials_required' });
    // tenant از ورودی پذیرفته نمی‌شود برای تصمیم؛ فقط برای «هینت» و همان بررسی می‌شود
    const candidates = [...store.tables.get('users') || []];
    const user = candidates.find((u) => u.username === username && !u.disabled);
    const generic = { error: 'invalid_credentials' };
    if (!user) { log(null, 'login', 'deny', { reason: 'unknown_user' }); return json(res, 401, generic); }
    if (bodyTenant && bodyTenant !== user.tenant_id) { log(user, 'login', 'deny', { reason: 'tenant_hint_mismatch' }); return json(res, 401, generic); }
    if (!verifyPassword(password, user.password_hash)) { log(user, 'login', 'deny', { reason: 'bad_password' }); return json(res, 401, generic); }
    const { token, session } = sessions.issue(user);
    log(session, 'login', 'allow');
    return json(res, 200, {
      token, role: session.role, tenant_id: session.tenant_id,
      absolute_expires_at: session.absolute_expires_at,
    });
  }

  async function listGrades(res, session, user, query) {
    const perm = can(session.role, 'grades', 'r');
    if (!perm.allowed) { log(session, 'grades.read', 'deny', { reason: perm.reason }); return json(res, 403, { error: 'forbidden', reason: perm.reason }); }
    return withTenant(session, (ctx) => {
      const rows = store.select(ctx, 'grades', (r) => rowAllowed(session, user, r, perm.scope));
      log(session, 'grades.read', 'allow', { count: rows.length, scope: perm.scope });
      return json(res, 200, { scope: perm.scope, count: rows.length, items: rows.map((r) => ({ id: r.id, subject: r.subject, score: r.score })) });
    });
  }

  async function addGrade(res, session, user, body) {
    const perm = can(session.role, 'grades', 'w');
    if (!perm.allowed) { log(session, 'grades.write', 'deny', { reason: perm.reason }); return json(res, 403, { error: 'forbidden', reason: perm.reason }); }
    const { student_id, subject, score } = body || {};
    if (!student_id || !subject || typeof score !== 'number') return json(res, 400, { error: 'invalid_body' });
    return withTenant(session, (ctx) => {
      const [student] = store.select(ctx, 'students', (s) => s.id === student_id);
      if (!student) { log(session, 'grades.write', 'deny', { reason: 'student_not_in_tenant' }); return json(res, 404, { error: 'not_found' }); }
      if (!rowAllowed(session, user, { tenant_id: student.tenant_id, class_id: student.class_id, student_id: student.id, id: student.id }, perm.scope)) {
        log(session, 'grades.write', 'deny', { reason: 'out_of_scope', scope: perm.scope });
        return json(res, 403, { error: 'forbidden', reason: 'out_of_scope' });
      }
      const row = store.insertRow(ctx, 'grades', { id: uuid(), tenant_id: ctx.tenant_id, student_id, class_id: student.class_id, subject, score });
      log(session, 'grades.write', 'allow', { grade_id: row.id });
      return json(res, 201, { id: row.id });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad_json' }); } }

    if (req.method === 'POST' && url.pathname === '/api/login') return handleLogin(req, res, body);

    // ---- Tenant Resolver: تنها منبع tenant، نشست است. هدر/کوئری نادیده گرفته می‌شود ----
    const token = bearer(req);
    if (!token) return json(res, 401, { error: 'unauthenticated' });
    const v = sessions.verify(token);
    if (!v.ok) return json(res, 401, { error: 'unauthenticated', reason: v.reason });
    const session = v.session;
    const user = [...store.tables.get('users') || []].find((u) => u.id === session.user_id);

    // هدر متخاصم: اگر کلاینت تلاش کند مستأجر را عوض کند، نادیده گرفته می‌شود (نه خطا)
    if (url.searchParams.get('tenant_id') && url.searchParams.get('tenant_id') !== session.tenant_id) {
      log(session, 'tenant_spoof_attempt', 'ignored', { attempted: url.searchParams.get('tenant_id') });
    }
    if (req.headers['x-tenant'] && req.headers['x-tenant'] !== session.tenant_id) {
      log(session, 'tenant_spoof_attempt', 'ignored', { attempted: req.headers['x-tenant'] });
    }
    if (body && body.tenant_id && body.tenant_id !== session.tenant_id) {
      log(session, 'tenant_spoof_attempt', 'ignored', { attempted: body.tenant_id });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      return json(res, 200, { user_id: session.user_id, role: session.role, tenant_id: session.tenant_id });
    }
    if (req.method === 'GET' && url.pathname === '/api/grades') return listGrades(res, session, user, url.searchParams);
    if (req.method === 'POST' && url.pathname === '/api/grades') return addGrade(res, session, user, body);
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const perm = can(session.role, 'audit', 'r');
      if (!perm.allowed) { log(session, 'audit.read', 'deny', { reason: perm.reason }); return json(res, 403, { error: 'forbidden', reason: perm.reason }); }
      const rows = audit.list(session.tenant_id);
      return json(res, 200, { count: rows.length, chain_ok: audit.verifyChain(session.tenant_id) });
    }
    if (req.method === 'GET' && url.pathname === '/api/platform/health') {
      const perm = can(session.role, 'platform_health', 'r');
      if (!perm.allowed) return json(res, 403, { error: 'forbidden', reason: perm.reason });
      return json(res, 200, { ok: true, tenants: store.tenants.size, note: 'metadata_only' });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sessions.revoke(token);
      log(session, 'logout', 'allow');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/panel') return panel(res, session, url.searchParams);

    return json(res, 404, { error: 'not_found' });
  }

  // پنل نقش‌محور: منو از همان سیاست تولید می‌شود، هیچ منوی دستی‌ای وجود ندارد
  function panel(res, session) {
    const items = [
      ['نمرات', can(session.role, 'grades', 'r').allowed],
      ['ثبت نمره', can(session.role, 'grades', 'w').allowed],
      ['حضور و غیاب', can(session.role, 'attendance', 'r').allowed],
      ['گزارش رویدادها', can(session.role, 'audit', 'r').allowed],
      ['اطلاعات مدرسه', can(session.role, 'tenant_meta', 'r').allowed],
      ['سلامت پلتفرم', can(session.role, 'platform_health', 'r').allowed],
    ].filter(([, ok]) => ok).map(([label]) => label);
    const html = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>پنل ${session.role}</title>` +
      `<h1>پنل ${session.role}</h1><nav><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></nav>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof Denied) return json(res, err.reason === 'not_found' ? 404 : 403, { error: err.reason });
      return json(res, 500, { error: 'internal', detail: String(err && err.message) });
    });
  });

  return { server, store, sessions, audit, seed, tenants: [tenantA, tenantB], platformSupport, PLATFORM_TENANT, ROLES, isPlatformRole };
}

module.exports = { build, PLATFORM_TENANT };
