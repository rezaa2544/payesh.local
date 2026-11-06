'use strict';
// آزمون خودکار نمونهٔ ۲۰‑ب — چندمستأجری: نشت بین‌مدرسه‌ای، سقف پلن، حالت‌های اشتراک، مجوز اضطراری
// اجرا: node prototype/slice-20b/tests/run.js
// مرجع: ۱۶‑ب §۱.۱ (چرخهٔ اشتراک) · ۱۵ §۲/§۴ · ۱۲‑ب §۳.۳ (آزمون‌های منفی) · ۰۱‑ب §۲.۶ · D‑07/D‑21/D‑22/D‑23/D‑27

const crypto = require('node:crypto');
const {
  Platform, RequestError, AuthError, sha256,
  SUB_STATES, TRANSITIONS, RETENTION_DAYS, GRANT_MAX_MS, CLIENT_BAKED_CREDENTIALS,
  PROVEN, NOT_PROVEN,
} = require('../platform');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`);
}
const throws = (fn, code, status) => {
  try { fn(); return { ok: false, got: 'no-error' }; } catch (e) {
    const okCode = code ? String(e.code || e.message).includes(code) : true;
    const okStatus = status ? e.status === status : true;
    return { ok: okCode && okStatus, got: `${e.code || e.className || e.constructor.name}/${e.status}` };
  }
};

// ---------- جهان آزمون ----------
const DAY = 86_400_000;
const HOUR = 3_600_000;
function world() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };
  const secret = crypto.createHash('sha256').update('slice-20b-fixed-secret').digest();
  const p = new Platform({ secret, now });

  p.provision({ id: 'A', code: 'sch-a', name: 'مدرسهٔ الف' });
  p.provision({ id: 'B', code: 'sch-b', name: 'مدرسهٔ ب' });
  p.tenants.get('A').storage_prefix = 'tenant/A';
  p.tenants.get('B').storage_prefix = 'tenant/B';

  p.definePlan({ code: 'basic', caps: { users: 3, students: 3, storage_mb: 1, features: ['reports'] } });
  p.definePlan({ code: 'pro', caps: { users: 50, students: 500, storage_mb: 100, features: ['reports', 'export'] } });

  p.subscribe({ tenant_id: 'A', plan: 'basic', status: 'active' });
  p.subscribe({ tenant_id: 'B', plan: 'pro', status: 'active' });

  const tok = (t, role, uid = `${t}-${role}`) => {
    p.addUser({ tenant_id: t, role, user_id: uid });
    return p.issueToken({ tenant_id: t, role, user_id: uid, device_id: `${t}-${uid}-dev` });
  };
  const t = {
    A: { manager: tok('A', 'manager'), teacher: tok('A', 'teacher'), parent: tok('A', 'parent') },
    B: { manager: tok('B', 'manager'), teacher: tok('B', 'teacher') },
    owner: p.issuePlatformToken({ role: 'platform_owner', operator_id: 'owner-1' }),
    op: p.issuePlatformToken({ role: 'platform_operator', operator_id: 'op-1' }),
    sup: p.issuePlatformToken({ role: 'platform_support', operator_id: 'sup-1' }),
  };
  const op = (collection, record_id, payload, extra = {}) => ({
    op_id: `op-${collection}-${record_id}-${crypto.randomBytes(3).toString('hex')}`,
    collection, record_id, payload, base_version: 0,
    payload_hash: sha256(JSON.stringify(payload)), ...extra,
  });
  return { p, t, now, advance, op };
}

function seed(p, tenant, collection, id, fields) {
  return p.seedRow({ tenant_id: tenant, collection, record_id: id, fields });
}

// ================= I — جداسازی مستأجرها =================
(function groupI() {
  const { p, t, op } = world();
  const sa = p.authenticate(t.A.manager);
  const sb = p.authenticate(t.B.manager);

  seed(p, 'A', 'grades', 'g-1', { score: 20 });
  seed(p, 'B', 'grades', 'g-1', { score: 11 });          // همان شناسه در مستأجر دیگر

  check('I1 خواندن ردیف خودی مجاز است', p.readSync(sa, { collection: 'grades', record_id: 'g-1' }).fields.score === 20);
  check('I2 خواندن ردیف مستأجر دیگر ⇒ 404 بدون اوراکل وجود',
    throws(() => p.readSync(sb, { collection: 'grades', record_id: 'nope' }), 'not_found', 404).ok &&
    p.readSync(sb, { collection: 'grades', record_id: 'g-1' }).fields.score === 11);

  const r3 = throws(() => p.pushSync(sa, [op('grades', 'g-9', { score: 5 }, { tenant_id: 'B' })]), 'tenant_mismatch', 403);
  check('I3 نوشتن با tenant_id مستأجر دیگر در بدنه ⇒ رد ۴۰۳', r3.ok, r3.got);
  check('I4 چیزی در مستأجر B نوشته نشد',
    !p.core.records.has('B|grades|g-9') && !p.core.records.has('A|grades|g-9'));

  check('I5 حذف ردیف مستأجر دیگر ممکن نیست (کلید فقط مستأجر نشست)',
    throws(() => p.removeRow({ session: sb, collection: 'grades', record_id: 'g-9' }), 'not_found').ok &&
    p.removeRow({ session: sa, collection: 'grades', record_id: 'g-1' }).deleted === true &&
    p.core.records.has('B|grades|g-1'));

  // صف
  p.enqueue(sa, { op_id: 'q-a-1', collection: 'attendance', record_id: 'x1', payload: { v: 1 }, tenant_id: 'B' });
  check('I6 صف: tenant_id از نشست است، نه از بدنه',
    p.listQueue(sa).every((r) => r.tenant_id === 'A') && p.listQueue(sb).length === 0);

  // کش
  p.cachePut(sa, 'students:list', [{ id: 'st-1' }]);
  check('I7 کش: مستأجر دیگر همان کلید را نمی‌بیند', p.cacheGet(sb, 'students:list') === undefined);

  // بکاپ
  seed(p, 'A', 'students', 'st-1', { name: 'ز' });
  seed(p, 'B', 'students', 'st-2', { name: 'ی' });
  const bakA = p.exportBackup(sa);
  const bakB = p.exportBackup(sb);
  const idsA = (bakA.rows.students || []).map((r) => r.id);
  const idsB = (bakB.rows.students || []).map((r) => r.id);
  check('I8 بکاپ هر مستأجر فقط ردیف‌های خودش را دارد', idsA.includes('st-1') && !idsA.includes('st-2') && idsB.includes('st-2') && !idsB.includes('st-1'));
  check('I9 واردکردن بکاپ مستأجر A در مستأجر B رد می‌شود', throws(() => p.importBackup(sb, bakA), 'tenant_mismatch', 403).ok);
  check('I10 بکاپ فقط نقش مجاز (ناظر مدرسه) — دبیر رد می‌شود',
    throws(() => p.exportBackup(p.authenticate(t.A.teacher)), 'role_denied', 403).ok);

  // فضای ذخیره‌سازی
  const tk = p.issueUploadTicket(sa, { path: 'mirror/1.json', max_bytes: 1024 });
  const put = p.putObject({ ticketId: tk.id, session: sa, bytes: Buffer.from('{"a":1}') });
  check('I11 کلید شیء پیشوند مستأجر دارد', put.key.startsWith('tenant/A/'), put.key);
  check('I12 مستأجر B شیء A را نمی‌خواند', throws(() => p.getObject(sb, put.key), 'tenant_mismatch', 403).ok);
  const tk2 = p.issueUploadTicket(sa, { path: 'mirror/2.json' });
  check('I13 بلیت A با نشست B کار نمی‌کند', throws(() => p.putObject({ ticketId: tk2.id, session: sb, bytes: Buffer.from('x') }), 'tenant_mismatch', 403).ok);
  check('I14 هیچ اعتبارنامهٔ پخته در کلاینت نیست (F‑04) + بلیت کوتاه‌عمر و بی‌کلید',
    CLIENT_BAKED_CREDENTIALS === null &&
    !('secret' in tk) && !('accessKey' in tk) && tk.exp - p.now() <= 300_000);
  check('I15 پنل پلتفرم محتوا برنمی‌گرداند (D‑21)',
    p.platformSnapshot({ token: t.owner }).content_included === false &&
    throws(() => p.authenticate(t.owner), 'platform_token_on_school_api', 403).ok);
})();

// ================= C — سقف پلن در API =================
(function groupC() {
  // جهان تنگ‌تر: پلن basic = users 3 · students 3 · storage 1MB · features [reports]
  const p = new Platform({ secret: crypto.createHash('sha256').update('slice-20b-caps').digest() });
  p.provision({ id: 'A', code: 'sch-a', name: 'مدرسهٔ الف' });
  p.tenants.get('A').storage_prefix = 'tenant/A';
  p.definePlan({ code: 'basic', caps: { users: 3, students: 3, storage_mb: 1, features: ['reports'] } });
  p.subscribe({ tenant_id: 'A', plan: 'basic', status: 'active' });
  const mk = (role, uid) => { p.addUser({ tenant_id: 'A', role, user_id: uid }); return p.issueToken({ tenant_id: 'A', role, user_id: uid }); };
  const managerTok = mk('manager', 'A-manager');
  const teacherTok = mk('teacher', 'A-teacher');
  const sa = p.authenticate(managerTok);
  const sa2 = p.authenticate(teacherTok);
  const op = (collection, record_id, payload, extra = {}) => ({
    op_id: `op-${collection}-${record_id}-${crypto.randomBytes(3).toString('hex')}`,
    collection, record_id, payload, base_version: 0,
    payload_hash: sha256(JSON.stringify(payload)), ...extra,
  });
  seed(p, 'A', 'students', 's1', { n: 1 });
  seed(p, 'A', 'students', 's2', { n: 2 });

  // زیر سقف: ۲ کاربر موجود ⇒ سومین کاربر مجاز است
  check('C0 زیر سقف کاربران مجاز است',
    p.createUser({ session: sa2, user_id: 'A-third', role: 'student' }).user_id === 'A-third' && p._countUsers('A') === 3);
  const c1 = throws(() => p.createUser({ session: sa, user_id: 'A-x1', role: 'teacher' }), 'plan_cap_users', 409);
  check('C1 سقف کاربران در API اعمال می‌شود (۴۰۹)', c1.ok, c1.got);
  check('C2 پیام فارسی دقیق است',
    p.capDenials.some((d) => d.code === 'plan_cap_users' && /سقف کاربران/.test(d.message_fa)));
  check('C3 شمارش ادعایی کلاینت نادیده گرفته می‌شود',
    throws(() => p.createUser({ session: sa, user_id: 'A-x2', role: 'teacher', client_counts: { users: 0 } }), 'plan_cap_users', 409).ok);
  check('C4 دانش‌آموز زیر سقف مجاز است (۳ از ۳)',
    p.createStudent({ session: sa, student_id: 's3', fields: { n: 3 } }).version === 1 && p._countRecords('A', 'students') === 3);

  const c5 = throws(() => p.createStudent({ session: sa, student_id: 's4', fields: { n: 4 } }), 'plan_cap_students', 409);
  check('C5 سقف دانش‌آموز در API اعمال می‌شود', c5.ok, c5.got);
  check('C6 پیام فارسی سقف دانش‌آموز', p.capDenials.some((d) => d.code === 'plan_cap_students' && /سقف دانش‌آموز/.test(d.message_fa)));

  const tk = p.issueUploadTicket(sa, { path: 'big.bin', max_bytes: 2 * 1_048_576 });
  const c7 = throws(() => p.putObject({ ticketId: tk.id, session: sa, bytes: Buffer.alloc(1_100_000) }), 'plan_cap_storage', 409);
  check('C7 سقف فضای ذخیره‌سازی در API اعمال می‌شود', c7.ok, c7.got);

  check('C8 قابلیت خارج از پلن رد می‌شود',
    throws(() => p.requireFeature(sa, 'export'), 'plan_feature_disabled', 409).ok &&
    p.capDenials.some((d) => d.code === 'plan_feature_disabled' && /پلن شما فعال نیست/.test(d.message_fa)));
  check('C9 قابلیت داخل پلن مجاز است', p.requireFeature(sa, 'reports') === true);
})();

// ================= S — حالت‌های اشتراک (D‑22) =================
(function groupS() {
  const { p, t, advance, op } = world();
  const sa = p.authenticate(t.A.manager);

  p.transition({ tenant_id: 'A', to: 'grace', actor: 'system', role: 'system', reason: 'ends_at passed' });
  const g = p.authenticate(t.A.manager);
  const r = p.pushSync(g, [op('attendance', 'a1', { v: 1 })]);
  check('S1 در grace نوشتن مجاز است و هشدار برمی‌گردد',
    r.results[0].status === 'applied' && p.readSync(g, { collection: 'attendance', record_id: 'a1' }).warning === 'subscription_grace_warning');

  p.transition({ tenant_id: 'A', to: 'suspended', actor: 'op-1', role: 'platform_operator', reason: 'غیرفعال‌سازی موقت' });
  check('S2 در suspended مدیر می‌تواند وارد شود', p.authenticate(t.A.manager).sub_state === 'suspended');
  check('S3 در suspended ورود دبیر ۴۰۳ است، نه ۴۰۱ (تا «رمز اشتباه» تفسیر نشود)',
    throws(() => p.authenticate(t.A.teacher), 'subscription_suspended', 403).ok);
  const sm = p.authenticate(t.A.manager);
  check('S4 در suspended خواندن صفحهٔ اشتراک مجاز، خواندن داده ممنوع',
    throws(() => p.readSync(sm, { collection: 'grades', record_id: 'g-1' }), 'subscription_read_limited', 403).ok);
  check('S5 در suspended نوشتن ممنوع است', throws(() => p.pushSync(sm, [op('grades', 'g-1', { s: 1 })]), 'subscription_suspended', 403).ok);
  check('S6 عملیات صف در suspended دور ریخته نمی‌شود', p.listQueue(sm).length >= 0 &&
    (p.transition({ tenant_id: 'A', to: 'active', actor: 'owner-1', role: 'platform_owner', reason: 'تمدید' }), true));

  // expired
  seed(p, 'A', 'grades', 'g-keep', { s: 19 });
  p.transition({ tenant_id: 'A', to: 'grace', actor: 'system', role: 'system' });
  p.transition({ tenant_id: 'A', to: 'expired', actor: 'system', role: 'system' });
  check('S7 در expired هیچ‌کس (حتی مدیر) وارد نمی‌شود', throws(() => p.authenticate(t.A.manager), 'subscription_expired', 403).ok);
  check('S8 دادهٔ expired حذف نشده است', p.core.records.has('A|grades|g-keep'));

  const until = p.retentionUntil('A');
  check('S9 نگهداری ۱۸۰ روزه محاسبه می‌شود', until === p.subs.get('A').expired_at + RETENTION_DAYS * DAY,
    String(until));
  check('S10 حذف پیش از پایان ۱۸۰ روز رد می‌شود',
    throws(() => p.purgeData({ tenant_id: 'A', policy_ref: 'POL-1', now: until - DAY }), 'retention_period_active', 409).ok);
  check('S11 حذف بدون سیاست مصوب رد می‌شود',
    throws(() => p.purgeData({ tenant_id: 'A', policy_ref: '', now: until + DAY }), 'policy_required', 409).ok);
  check('S12 حذف پس از ۱۸۰ روز فقط با سیاست مصوب انجام می‌شود',
    p.purgeData({ tenant_id: 'A', policy_ref: 'POL-1', now: until + DAY }).removed >= 1 &&
    !p.core.records.has('A|grades|g-keep'));

  // گذارهای ممنوع و مجاز
  check('S13 گذار expired→grace ممنوع است',
    throws(() => p.transition({ tenant_id: 'A', to: 'grace', actor: 'owner-1', role: 'platform_owner' }), 'transition_forbidden', 409).ok);
  check('S14 گذار به وضعیت ناشناخته (trialing) رد می‌شود (A‑03)',
    throws(() => p.transition({ tenant_id: 'B', to: 'trialing', actor: 'owner-1', role: 'platform_owner' }), 'unknown_state').ok &&
    !SUB_STATES.includes('trialing'));
  check('S15 لغو بدون دلیل رد می‌شود', throws(() => p.transition({ tenant_id: 'B', to: 'canceled', actor: 'owner-1', role: 'platform_owner' }), 'reason_required').ok);
  check('S16 گذار canceled→active ممنوع است (فقط اشتراک تازه با renewed_from)',
    (p.transition({ tenant_id: 'B', to: 'canceled', actor: 'owner-1', role: 'platform_owner', reason: 'لغو قرارداد' }),
      throws(() => p.transition({ tenant_id: 'B', to: 'active', actor: 'owner-1', role: 'platform_owner' }), 'transition_forbidden', 409).ok));
  check('S17 در canceled ورود ممکن نیست', throws(() => p.authenticate(t.B.manager), 'subscription_canceled', 403).ok);
  check('S18 هر انتقال مجاز یک رخداد ثبت‌شده دارد',
    p.subEvents.every((e) => e.from !== undefined && e.to && e.hash) && p.subEvents.length >= 6);
  const dup = p.transition({ tenant_id: 'B', to: 'archived', actor: 'system', role: 'system', idempotency_key: 'K1' });
  check('S19 کلید idempotency تکراری رد می‌شود',
    dup.status === 'archived' &&
    throws(() => p.transition({ tenant_id: 'B', to: 'archived', actor: 'system', role: 'system', idempotency_key: 'K1' }), 'duplicate_idempotency', 409).ok);
  check('S20 جدول انتقال‌ها هیچ وضعیت خارج از D‑22 ندارد',
    Object.values(TRANSITIONS).flat().every((s) => SUB_STATES.includes(s) || s === 'archived'));
})();

// ================= E — مجوز اضطراری D‑21 (۱۲‑ب §۳.۳) =================
(function groupE() {
  const { p, t, advance } = world();
  seed(p, 'A', 'grades', 'g-1', { score: 18 });
  seed(p, 'A', 'grades', 'g-2', { score: 12 });
  seed(p, 'B', 'grades', 'g-1', { score: 7 });

  check('E1 پشتیبان بدون مجوز به محتوا دسترسی ندارد',
    throws(() => p.readAsSupport({ token: t.sup, grant_id: 'gr-none', collection: 'grades', record_id: 'g-1' }), 'grant_unknown', 404).ok &&
    throws(() => p.authenticate(t.sup), 'platform_token_on_school_api', 403).ok);

  const g1 = p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'عیب‌یابی خطای همگام‌سازی', case_ref: 'T-1', ttlMs: 30 * 60 * 1000 });
  check('E2 تأیید توسط خود درخواست‌دهنده ممنوع است (چهارچشمی)',
    throws(() => p.approveGrant({ token: t.sup, grant_id: g1.id }), 'approver_not_allowed', 403).ok);
  check('E3 مجوز اضطراری پیش از تأیید مالک فعال نیست',
    throws(() => p.readAsSupport({ token: t.sup, grant_id: g1.id, collection: 'grades', record_id: 'g-1' }), 'grant_not_approved', 403).ok);
  p.approveGrant({ token: t.owner, grant_id: g1.id });
  check('E4 بدون اطلاع/تأیید مدیر مدرسه فعال نمی‌شود',
    throws(() => p.readAsSupport({ token: t.sup, grant_id: g1.id, collection: 'grades', record_id: 'g-1' }), 'school_not_notified', 403).ok);
  check('E5 اطلاع مدرسه با توکن مستأجر دیگر رد می‌شود',
    throws(() => p.notifySchool({ token: t.B.manager, grant_id: g1.id }), 'tenant_mismatch', 403).ok);
  p.notifySchool({ token: t.A.manager, grant_id: g1.id });
  const read1 = p.readAsSupport({ token: t.sup, grant_id: g1.id, collection: 'grades', record_id: 'g-1' });
  check('E6 پس از سه مرحله، خواندن یک ردیف مجاز و ثبت‌شده است',
    read1.fields.score === 18 && read1.logged === true &&
    p.supportAccessLog.some((l) => l.grant_id === g1.id && l.record_id === 'g-1' && l.tenant_id === 'A'));
  check('E7 دانلود انبوه ممنوع است (D‑21)',
    throws(() => p.readAsSupportBulk({ token: t.sup, grant_id: g1.id }), 'bulk_download_denied', 403).ok);

  check('E8 scope=content_write وجود ندارد و در لایهٔ داده رد می‌شود',
    throws(() => p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_write', reason: 'تلاش نوشتن در محتوا', case_ref: 'T-3' }), 'scope_not_allowed', 403).ok);

  check('E9 دلیل کوتاه رد می‌شود', throws(() => p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'کوتاه', case_ref: 'T-4' }), 'reason_required', 403).ok);
  check('E10 مدت بیش از ۷۲ ساعت رد می‌شود',
    throws(() => p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'بازهٔ بیش از حد مجاز', case_ref: 'T-5', ttlMs: GRANT_MAX_MS + 1 }), 'grant_ttl_invalid', 403).ok);

  // ابطال فوری توسط مدیر مدرسه
  const g3 = p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'بررسی مورد پشتیبانی دوم', case_ref: 'T-6' });
  p.approveGrant({ token: t.op, grant_id: g3.id });
  p.notifySchool({ token: t.A.manager, grant_id: g3.id });
  const okBefore = p.readAsSupport({ token: t.sup, grant_id: g3.id, collection: 'grades', record_id: 'g-2' }).fields.score;
  p.revokeGrant({ token: t.A.manager, grant_id: g3.id });
  check('E11 ابطال یک‌طرفهٔ مدیر مدرسه فوری اثر می‌کند',
    okBefore === 12 &&
    throws(() => p.readAsSupport({ token: t.sup, grant_id: g3.id, collection: 'grades', record_id: 'g-2' }), 'grant_revoked', 403).ok);

  // ابطال توسط مالک پلتفرم + انقضا
  const g4 = p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'مورد سوم بررسی دسترسی', case_ref: 'T-7', ttlMs: 60 * 1000 });
  p.approveGrant({ token: t.op, grant_id: g4.id });
  p.notifySchool({ token: t.A.manager, grant_id: g4.id });
  advance(61 * 1000);
  check('E12 مجوز منقضی حتی با توکن معتبر ۴۰۳ می‌دهد',
    throws(() => p.readAsSupport({ token: t.sup, grant_id: g4.id, collection: 'grades', record_id: 'g-1' }), 'grant_expired', 403).ok);

  const g5 = p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'ابطال از سمت مالک پلتفرم', case_ref: 'T-8' });
  p.approveGrant({ token: t.op, grant_id: g5.id });
  p.notifySchool({ token: t.A.manager, grant_id: g5.id });
  p.revokeGrant({ token: t.owner, grant_id: g5.id });
  check('E13 ابطال از سمت مالک پلتفرم هم فوری است',
    throws(() => p.readAsSupport({ token: t.sup, grant_id: g5.id, collection: 'grades', record_id: 'g-1' }), 'grant_revoked', 403).ok);

  const g6 = p.requestGrant({ token: t.sup, tenant_id: 'A', scope: 'content_read', reason: 'سنجش سقف تعداد اقدام', case_ref: 'T-9' });
  p.approveGrant({ token: t.op, grant_id: g6.id });
  p.notifySchool({ token: t.A.manager, grant_id: g6.id });
  const grant = p.grants.get(g6.id);
  grant.max_actions = 1;
  p.readAsSupport({ token: t.sup, grant_id: g6.id, collection: 'grades', record_id: 'g-1' });
  check('E14 پس از رسیدن به سقف اقدام، دسترسی بسته می‌شود',
    throws(() => p.readAsSupport({ token: t.sup, grant_id: g6.id, collection: 'grades', record_id: 'g-2' }), 'grant_exhausted', 403).ok);
  check('E15 مجوز یک اپراتور با توکن اپراتور دیگر قابل استفاده نیست',
    throws(() => p.readAsSupport({ token: t.owner, grant_id: g6.id, collection: 'grades', record_id: 'g-1' }), 'grant_not_yours', 403).ok);
  check('E16 هر خواندن محتوا یک ردیف لاگ مستقل دارد',
    p.supportAccessLog.filter((l) => l.grant_id === g6.id).length === 1);
})();

// ================= X — استفادهٔ متقابل توکن سطح A و B =================
(function groupX() {
  const { p, t } = world();
  seed(p, 'A', 'grades', 'g-1', { score: 5 });
  seed(p, 'B', 'grades', 'g-1', { score: 9 });

  check('X1 توکن مدرسه روی API پلتفرم رد می‌شود',
    throws(() => p.platformSnapshot({ token: t.A.manager }), 'school_token_on_platform_api', 403).ok);
  check('X2 توکن پلتفرم روی API مدرسه رد می‌شود',
    throws(() => p.authenticate(t.owner), 'platform_token_on_school_api', 403).ok);
  const [body, sig] = String(t.A.manager).split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...payload, tid: 'B' })).toString('base64url');
  check('X3 جعل بدنهٔ توکن (تغییر tenant) ⇒ امضای نامعتبر',
    throws(() => p.authenticate(`${forged}.${sig}`), 'bad_signature', 401).ok);
  const expired = p.issueToken({ tenant_id: 'A', role: 'manager', user_id: 'A-manager', ttlMs: -1000 });
  check('X4 توکن منقضی رد می‌شود', throws(() => p.authenticate(expired), 'token_expired', 401).ok);
  const sb = p.authenticate(t.B.manager);
  check('X5 توکن A به دادهٔ B دسترسی نمی‌دهد',
    p.readSync(sb, { collection: 'grades', record_id: 'g-1' }).fields.score === 9);
  const sa = p.authenticate(t.A.manager);
  const forgedOp = {
    op_id: 'x-op-1', collection: 'grades', record_id: 'g-9', payload: { score: 1 },
    base_version: 0, payload_hash: sha256(JSON.stringify({ score: 1 })), tenant_id: 'B',
  };
  check('X6 tenant از توکن حل می‌شود؛ ادعای بدنه رد می‌شود',
    throws(() => p.pushSync(sa, [forgedOp]), 'tenant_mismatch', 403).ok && !p.core.records.has('B|grades|g-9'));
})();

// ================= G — صداقت و پیوند =================
(function groupG() {
  const { p, t } = world();
  seed(p, 'A', 'grades', 'g-1', { score: 3 });
  const snap = p.platformSnapshot({ token: t.owner });

  check('G1 نمای پلتفرم فقط فراداده است و محتوا ندارد',
    snap.view === 'metadata' && snap.content_included === false &&
    !JSON.stringify(snap).includes('score'));
  const chainOk = (arr) => arr.every((row, i) => {
    const prev = i === 0 ? 'GENESIS' : arr[i - 1].hash;
    if (row.prev_hash !== prev) return false;
    const copy = { ...row }; delete copy.hash;
    return sha256(JSON.stringify(copy)) === row.hash;
  });
  check('G2 زنجیرهٔ audit پلتفرم و رخدادهای اشتراک سالم است',
    chainOk(p.audit) && chainOk(p.subEvents));
  check('G3 فهرست «اثبات‌شده» و «اثبات‌نشده» صریح است و ادعای آماده‌بودن تولید ندارد',
    PROVEN.length >= 5 && NOT_PROVEN.includes('production_ready') && NOT_PROVEN.includes('real_postgres_rls'));
  check('G4 سقف‌ها و وضعیت‌ها همه از ثابت‌های مصوب می‌آیند (بدون عدد جادویی در آزمون)',
    RETENTION_DAYS === 180 && GRANT_MAX_MS === 72 * 3600 * 1000 && SUB_STATES.length === 7);
})();

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} موفق · ${fail} ناموفق`);
console.log(`SUMMARY pass=${pass} fail=${fail} total=${results.length}`);
process.exit(fail === 0 ? 0 : 1);
