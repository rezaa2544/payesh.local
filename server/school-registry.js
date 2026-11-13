'use strict';
/* ═══════════════════════════════════════════════════════════════════
   مدارس، درخواست ثبت‌نام و اشتراک — برگردان از p2 (ردیف ۱۴۵ · ADR 126 §۱۶)
   ───────────────────────────────────────────────────────────────────
   پنل مالک فهرست مدارس و سیاست اشتراک را رمزشده در صندوقچه می‌نویسد؛ سرور مدرسه
   (که همین حالا تنظیم دیتابیس مالک را دنبال می‌کند، server/cloud-control.js) آن را
   می‌خواند. برنامهٔ کاربران هرگز کلید صندوقچه ندارد و فقط با سرور مدرسه حرف می‌زند.

   قرارداد schools v1 (Node = Dart؛ بردار مشترک docs/cloud/contracts/schools-vectors.json):
     <prefix>schools/registry.json        فهرست مدارس + سیاست اشتراک   kind=payesh-school-registry (پنل مالک)
     <prefix>schools/req/<id>.json        درخواست ثبت‌نام مدرسهٔ جدید  kind=payesh-school-request  (سرور مدرسه)
     <prefix>schools/pay/<id>.json        پرداخت اشتراک                 kind=payesh-sub-payment     (سرور مدرسه)
     <prefix>schools/ack/<school_id>.json رسید سرورِ میزبان مدرسه       kind=payesh-school-ack      (سرور مدرسه)
     <prefix>schools/trial/<key>.json     دفتر «آزمایشی یک بار برای هر دستگاه» kind=payesh-sub-trial (سرور مدرسه)
   پاکت: همان {v:1, kind, rev, alg:"HKDF-SHA256/A256GCM", nonce, ct} سرور کمکی، با نمک
   "payesh/schools". فقط دارندهٔ کلید همان صندوقچه (پنل مالک و سرورهای مدرسه) بازش می‌کند.

   قواعد p2 که بی‌تغییر آمده‌اند (src/js/23-subscription.js، 38-plans-backup.js، 09-schools.js):
     • پلن‌ها ماهانه/فصلی/سالانه (۱/۳/۱۲ ماه، هر ماه ۳۰ روز) با قیمت‌های پیش‌فرض p2؛
     • تمدید از تاریخ پایان فعلی (اگر هنوز فعال است) وگرنه از امروز؛ کد پیگیری SUB-xxxxxxxx؛
     • دورهٔ آزمایشی پیش‌فرض ۲۱ روز، «هدیه» (gift) و «بازنشانی» (reset) از پنل مالک؛
     • وضعیت‌ها trial / active / expired / none؛ غیرفعال کردن مدرسه ورود را می‌بندد.
   خواستهٔ مالک (افزوده بر p2):
     • برای هر نقش «اشتراکی» یا «رایگان»؛ نقش اشتراکی تا پرداخت و تأیید کار نمی‌کند؛
     • آزمایشی فقط یک بار برای هر دستگاه — حتی پس از حذف و نصب دوباره (شناسهٔ سخت‌افزاری
       دستگاه، درهم‌سازی‌شده، در دفتر سراسری صندوقچه)؛
     • درگاه پرداخت: مالک فقط «پیوند درگاه» (و در صورت وجود «پیوند تأیید») را در پنل وارد
       می‌کند؛ تا آن زمان «ثبت رسید» با تأیید مالک کار می‌کند.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const s3mem = require('./s3mem');
const { trustFetch } = require('./s3-https');
const { nowISO, verifySecret, normDigits } = require('./util');

const SALT = Buffer.from('payesh/schools', 'utf8');
const INFO = Buffer.from('v1', 'utf8');
const ALG = 'HKDF-SHA256/A256GCM';
const K = {
  registry: 'payesh-school-registry',
  request: 'payesh-school-request',
  payment: 'payesh-sub-payment',
  ack: 'payesh-school-ack',
  trial: 'payesh-sub-trial',
};
const DIR = { registry: 'schools/registry.json', req: 'schools/req/', pay: 'schools/pay/', ack: 'schools/ack/', trial: 'schools/trial/' };

/* p2 — SUB_PLANS / PLAN_DEFS / SUB_DEFAULTS */
const PLANS = [
  { key: 'monthly', title: 'ماهانه', months: 1, price: 250000 },
  { key: 'seasonal', title: 'فصلی', months: 3, price: 650000 },
  { key: 'yearly', title: 'سالانه', months: 12, price: 2200000 },
];
const ROLES = ['manager', 'deputy', 'teacher', 'student', 'parent'];
const DEFAULTS = {
  trial_enabled: true,
  trial_days: 21,
  paywall_enabled: true,
  roles: { manager: 'required', deputy: 'free', teacher: 'free', student: 'free', parent: 'required' },
  gateway: { pay_url: '', verify_url: '' },
  receipt_enabled: true,
  receipt_note: '',
};
const LEVELS = ['ابتدایی', 'متوسطه اول', 'متوسطه دوم'];
const DAY_MS = 24 * 3600_000;
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;
const ID_RE = /^[0-9]{13}-[0-9a-f]{16}$/;
const DEV_RE = /^[0-9a-f]{64}$/;
const PAY_RE = /^SUB-[0-9A-F]{8}$/;
const INTERVAL_MS = 60_000;

class RegistryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/* ── پاکت ─────────────────────────────────────────────────────────── */
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new RegistryError('bad_format');
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b64u(b) !== s || (len && b.length !== len)) throw new RegistryError('bad_format');
  return b;
}
const keyFor = (secret) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), SALT, INFO, 32));
const aadFor = (kind, rev) => Buffer.from(kind + '/v1/' + rev, 'utf8');

function seal(secret, kind, rev, plainText, nonce) {
  const n = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (n.length !== 12) throw new RegistryError('bad_nonce');
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(secret), n);
  c.setAAD(aadFor(kind, rev));
  const ct = Buffer.concat([c.update(Buffer.from(plainText, 'utf8')), c.final(), c.getAuthTag()]);
  return { v: 1, kind, rev, alg: ALG, nonce: b64u(n), ct: b64u(ct) };
}
function open(secret, kind, env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || env.kind !== kind || env.alg !== ALG) throw new RegistryError('bad_format');
  const rev = env.rev;
  if (!Number.isSafeInteger(rev) || rev <= 0) throw new RegistryError('bad_format');
  const n = unb64u(env.nonce, 12);
  const ct = unb64u(env.ct);
  if (ct.length < 17) throw new RegistryError('bad_format');
  let text;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), n);
    d.setAAD(aadFor(kind, rev));
    d.setAuthTag(ct.subarray(ct.length - 16));
    text = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
  } catch (e) { throw new RegistryError('open_failed'); }
  let plain;
  try { plain = JSON.parse(text); } catch (e) { throw new RegistryError('bad_plain'); }
  if (!plain || typeof plain !== 'object' || plain.v !== 1) throw new RegistryError('bad_plain');
  return { rev, plain };
}

async function readEnv(cfg, key, kind) {
  let text;
  try { text = await s3mem.get(cfg, key); } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
  try { return open(cfg.secret, kind, JSON.parse(text)); } catch (e) { return { invalid: true }; }
}
const writeEnv = (cfg, key, kind, rev, plain) =>
  s3mem.put(cfg, key, JSON.stringify(seal(cfg.secret, kind, rev, JSON.stringify(plain))));

/* ── تنظیمات و فهرست ──────────────────────────────────────────────── */
const META = { registry: 'schools:registry', bound: 'schools:bound', subs: 'sub:state', applied: 'sub:applied', mine: 'schools:my_requests', trials: 'sub:trials' };

function cloud(store) {
  const c = s3mem.usingMeta(store).get();
  return c && c.enabled ? c : null;
}

function settingsOf(plain) {
  const s = (plain && plain.settings) || {};
  const roles = Object.assign({}, DEFAULTS.roles);
  for (const [r, v] of Object.entries(s.roles || {})) if (v === 'required' || v === 'free') roles[r] = v;
  const plans = Array.isArray(s.plans) && s.plans.length
    ? s.plans.filter(p => p && PLANS.some(d => d.key === p.key)).map(p => {
      const d = PLANS.find(x => x.key === p.key);
      const price = Number(p.price);
      return { key: d.key, title: d.title, months: d.months, price: Number.isFinite(price) && price >= 0 ? Math.round(price) : d.price };
    })
    : PLANS.map(p => Object.assign({}, p));
  const days = Number(s.trial_days);
  const g = s.gateway || {};
  return {
    trial_enabled: s.trial_enabled === undefined ? DEFAULTS.trial_enabled : !!s.trial_enabled,
    trial_days: Number.isInteger(days) && days >= 0 && days <= 365 ? days : DEFAULTS.trial_days,
    paywall_enabled: s.paywall_enabled === undefined ? DEFAULTS.paywall_enabled : !!s.paywall_enabled,
    roles,
    plans,
    gateway: { pay_url: safeUrl(g.pay_url), verify_url: safeUrl(g.verify_url) },
    receipt_enabled: s.receipt_enabled === undefined ? true : !!s.receipt_enabled,
    receipt_note: String(s.receipt_note || '').slice(0, 400),
    domain: String((plain && plain.domain) || '').slice(0, 200),
  };
}
function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const x = new URL(s.replace(/\{[a-z_]+\}/g, 'x'));
    return x.protocol === 'https:' || x.protocol === 'http:' ? s.slice(0, 600) : '';
  } catch (e) { return ''; }
}

function registry(store) {
  const r = store.getMeta(META.registry, null);
  return r && r.plain && Array.isArray(r.plain.schools) ? r : null;
}
const boundOf = (store) => store.getMeta(META.bound, null);
function schoolOf(store) {
  const reg = registry(store);
  const b = boundOf(store);
  if (!reg || !b) return null;
  return reg.plain.schools.find(s => s.id === b.school_id) || null;
}

/* ── خواندن فهرست از صندوقچه ─────────────────────────────────────── */
async function pullRegistry(store, cfg) {
  const r = await readEnv(cfg, cfg.prefix + DIR.registry, K.registry);
  if (!r || r.invalid) return registry(store);
  const old = registry(store);
  if (!old || r.rev >= old.rev) store.setMeta(META.registry, { rev: r.rev, plain: r.plain, at: nowISO() });
  return registry(store);
}

/* ── اشتراک‌ها (روی همین سرور) ─────────────────────────────────────── */
function subsState(store) {
  const s = store.getMeta(META.subs, null);
  return s && typeof s === 'object' && s.users ? s : { users: {}, payments: [] };
}
const saveSubs = (store, s) => store.setMeta(META.subs, s);
const addDays = (fromMs, days) => new Date(fromMs + days * DAY_MS).toISOString();

/* p2 sub-pay: تمدید از پایان فعلی اگر هنوز فعال است، وگرنه از امروز؛ هر ماه ۳۰ روز */
function extend(rec, days, now) {
  const end = rec.end ? Date.parse(rec.end) : 0;
  const from = end > now ? end : now;
  rec.end = addDays(from, days);
  if (!rec.start || end <= now) rec.start = new Date(now).toISOString();
  return rec;
}

function userSub(state, uid) {
  return state.users[String(uid)] || null;
}

/* وضعیت دسترسی یک کاربر — همان «effectiveAccess» p2 با سیاست نقش مالک */
function gate(store, user, { now = Date.now() } = {}) {
  const reg = registry(store);
  const b = boundOf(store);
  if (!reg || !b || !user) return { managed: false, access: true, status: 'free' };
  const sch = reg.plain.schools.find(s => s.id === b.school_id);
  if (!sch) return { managed: true, access: false, status: 'school_removed' };
  if (sch.active === false) return { managed: true, access: false, status: 'school_inactive' };
  const st = settingsOf(reg.plain);
  const role = String(user.role || '');
  const policy = st.roles[role] || 'free';
  const base = {
    managed: true, role, policy, school: sch.name || '',
    plans: st.plans, trial_days: st.trial_days,
    gateway: !!st.gateway.pay_url, receipt: st.receipt_enabled, receipt_note: st.receipt_note,
  };
  if (!st.paywall_enabled || policy !== 'required') return Object.assign(base, { access: true, status: 'free' });
  const state = subsState(store);
  const rec = userSub(state, user.id);
  const active = !!(rec && rec.end && Date.parse(rec.end) > now);
  const pending = state.payments.filter(p => p.uid === user.id && p.status === 'pending').map(publicPayment);
  return Object.assign(base, {
    access: active,
    status: active ? (rec.status || 'active') : (rec ? 'expired' : 'none'),
    plan: rec ? rec.plan || null : null,
    end: rec ? rec.end || null : null,
    days_left: active ? Math.max(0, Math.ceil((Date.parse(rec.end) - now) / DAY_MS)) : 0,
    trial_available: st.trial_enabled && st.trial_days > 0 && !(rec && rec.trial_used),
    pending,
  });
}

function publicPayment(p) {
  return { id: p.id, plan: p.plan, amount: p.amount, method: p.method, status: p.status, ref: p.ref || null, created_at: p.created_at };
}

/* آزمایشی: یک بار برای هر کاربر و یک بار برای هر دستگاه (دفتر سراسری صندوقچه) */
const trialKey = (deviceHash) => crypto.createHash('sha256').update('payesh-trial/v1:' + deviceHash).digest('hex');

async function startTrial(store, user, deviceHash, { now = Date.now() } = {}) {
  const g = gate(store, user, { now });
  if (!g.managed || g.policy !== 'required' || g.status === 'free') return { ok: false, error: 'not_required' };
  if (g.access) return { ok: false, error: 'already_active' };
  if (!g.trial_available) return { ok: false, error: 'trial_unavailable' };
  const dh = String(deviceHash || '').toLowerCase();
  if (!DEV_RE.test(dh)) return { ok: false, error: 'bad_device' };
  const key = trialKey(dh);
  const local = store.getMeta(META.trials, []) || [];
  if (local.includes(key)) return { ok: false, error: 'trial_used_device' };
  const cfg = cloud(store);
  if (!cfg) return { ok: false, error: 'trial_check_unavailable' };
  try {
    const prev = await readEnv(cfg, cfg.prefix + DIR.trial + key + '.json', K.trial);
    if (prev) return { ok: false, error: 'trial_used_device' };
  } catch (e) { return { ok: false, error: 'trial_check_unavailable' }; }
  const b = boundOf(store);
  const days = g.trial_days;
  const rec = { v: 1, key, school_id: b.school_id, uid: user.id, role: user.role, started_at: new Date(now).toISOString(), ends_at: addDays(now, days) };
  try { await writeEnv(cfg, cfg.prefix + DIR.trial + key + '.json', K.trial, now, rec); } catch (e) { return { ok: false, error: 'trial_check_unavailable' }; }
  store.setMeta(META.trials, local.concat([key]).slice(-5000));
  const state = subsState(store);
  const cur = state.users[String(user.id)] || {};
  state.users[String(user.id)] = Object.assign(cur, { status: 'trial', plan: 'trial', start: rec.started_at, end: rec.ends_at, trial_used: true, role: user.role });
  saveSubs(store, state);
  store.audit({ user_id: user.id, role: user.role, action: 'sub_trial', collection: 'subscriptions', after: { days } });
  return { ok: true, sub: gate(store, user, { now }) };
}

const newPaymentId = () => 'SUB-' + crypto.randomBytes(4).toString('hex').toUpperCase();

function planOf(store, key) {
  const reg = registry(store);
  return settingsOf(reg && reg.plain).plans.find(p => p.key === key) || null;
}

async function reportPayment(store, p) {
  const cfg = cloud(store);
  const b = boundOf(store);
  if (!cfg || !b) return false;
  try {
    await writeEnv(cfg, cfg.prefix + DIR.pay + p.id + '.json', K.payment, Date.now(), Object.assign({ v: 1, school_id: b.school_id }, p));
    return true;
  } catch (e) { return false; }
}

function newPayment(store, user, plan, method, extra = {}) {
  const state = subsState(store);
  const p = Object.assign({
    id: newPaymentId(), uid: user.id, name: user.name || '', role: user.role,
    plan: plan.key, months: plan.months, amount: plan.price, method, status: 'pending', created_at: nowISO(),
  }, extra);
  state.payments.push(p);
  state.payments = state.payments.slice(-2000);
  saveSubs(store, state);
  return p;
}

/* پرداخت از درگاه: پیوند درگاه با جای‌نگهدارها ساخته می‌شود */
function fill(tpl, vals) {
  return String(tpl).replace(/\{([a-z_]+)\}/g, (m, k) => (k in vals ? encodeURIComponent(String(vals[k])) : m));
}

async function startPayment(store, user, planKey, { callbackBase } = {}) {
  const g = gate(store, user);
  if (!g.managed || g.status === 'free') return { ok: false, error: 'not_required' };
  const plan = planOf(store, planKey);
  if (!plan) return { ok: false, error: 'bad_plan' };
  const reg = registry(store);
  const st = settingsOf(reg.plain);
  if (!st.gateway.pay_url) return { ok: false, error: 'gateway_not_configured' };
  const base = String(callbackBase || st.domain || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, error: 'no_callback_address' };
  const p = newPayment(store, user, plan, 'gateway');
  const callback = base + '/api/sub/callback?payment=' + p.id;
  const url = fill(st.gateway.pay_url, {
    amount: plan.price, amount_toman: Math.round(plan.price / 10), payment_id: p.id, callback,
    description: 'اشتراک ' + plan.title + ' پایش — ' + (g.school || ''), mobile: normDigits(user.phone || ''),
  });
  await reportPayment(store, p);
  return { ok: true, pay_url: url, payment: publicPayment(p) };
}

/* ثبت رسید (کارت‌به‌کارت و…) — تا تأیید مالک «در انتظار» */
async function submitReceipt(store, user, planKey, ref) {
  const g = gate(store, user);
  if (!g.managed || g.status === 'free') return { ok: false, error: 'not_required' };
  const plan = planOf(store, planKey);
  if (!plan) return { ok: false, error: 'bad_plan' };
  if (!g.receipt) return { ok: false, error: 'receipt_disabled' };
  const r = String(ref || '').trim();
  if (r.length < 4 || r.length > 40) return { ok: false, error: 'bad_ref' };
  const p = newPayment(store, user, plan, 'receipt', { ref: r });
  const sent = await reportPayment(store, p);
  return { ok: true, payment: publicPayment(p), reported: sent };
}

function markPaid(store, p, { gatewayRef = null, by = 'gateway', now = Date.now() } = {}) {
  const state = subsState(store);
  const row = state.payments.find(x => x.id === p.id);
  if (!row || row.status === 'paid') return row;
  row.status = 'paid';
  row.paid_at = new Date(now).toISOString();
  row.approved_by = by;
  if (gatewayRef) row.gateway_ref = String(gatewayRef).slice(0, 80);
  const rec = state.users[String(row.uid)] || { trial_used: false };
  extend(rec, (row.months || 1) * 30, now);
  rec.status = 'active';
  rec.plan = row.plan;
  rec.role = row.role;
  state.users[String(row.uid)] = rec;
  saveSubs(store, state);
  store.audit({ user_id: row.uid, role: row.role, action: 'sub_paid', collection: 'subscriptions', after: { id: row.id, plan: row.plan, amount: row.amount, by } });
  return row;
}

/* بازگشت از درگاه: فقط با «پیوند تأیید» مالک قطعی می‌شود؛ بدون آن، پرداخت به تأیید مالک می‌رود */
function verifyOk(j) {
  if (!j || typeof j !== 'object') return false;
  const d = j.data && typeof j.data === 'object' ? j.data : {};
  return j.ok === true || j.status === 'paid' || j.status === 'OK' || j.status === 100 || j.code === 100 ||
    d.code === 100 || d.code === 101 || j.result === 100 || j.Status === 100;
}
async function callback(store, query, { fetchImpl } = {}) {
  const id = String(query.get('payment') || '');
  if (!PAY_RE.test(id)) return { ok: false, error: 'bad_payment' };
  const state = subsState(store);
  const p = state.payments.find(x => x.id === id);
  if (!p) return { ok: false, error: 'not_found' };
  if (p.status === 'paid') return { ok: true, status: 'paid', payment: publicPayment(p) };
  const reg = registry(store);
  const st = settingsOf(reg && reg.plain);
  const params = {};
  for (const [k, v] of query.entries()) if (k !== 'payment') params[k] = String(v).slice(0, 200);
  if (!st.gateway.verify_url) {
    p.gateway_params = params;
    p.status = 'pending';
    p.awaiting_owner = true;
    saveSubs(store, state);
    await reportPayment(store, p);
    return { ok: true, status: 'pending', payment: publicPayment(p) };
  }
  let j = null;
  try {
    const f = fetchImpl || trustFetch;
    const r = await f(fill(st.gateway.verify_url, { amount: p.amount, amount_toman: Math.round(p.amount / 10), payment_id: p.id }), {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ payment_id: p.id, amount: p.amount, params }),
    });
    j = await r.json().catch(() => null);
  } catch (e) { j = null; }
  if (verifyOk(j)) {
    const d = (j && j.data) || {};
    const row = markPaid(store, p, { gatewayRef: j.ref_id || d.ref_id || j.ref || j.RefID || null, by: 'gateway' });
    await reportPayment(store, row);
    return { ok: true, status: 'paid', payment: publicPayment(row) };
  }
  p.status = 'failed';
  p.gateway_params = params;
  saveSubs(store, state);
  await reportPayment(store, p);
  return { ok: false, status: 'failed', payment: publicPayment(p) };
}

/* ── دستورهای مالک: هدیه، بازنشانی، تأیید/رد پرداخت ───────────────── */
function applyOwner(store, plain, { now = Date.now() } = {}) {
  const b = boundOf(store);
  if (!b) return { applied: 0 };
  const done = new Set(store.getMeta(META.applied, []) || []);
  const state = subsState(store);
  const users = store.all('users') || [];
  let n = 0;
  for (const g of Array.isArray(plain.grants) ? plain.grants : []) {
    if (!g || !g.id || done.has('g:' + g.id) || g.school_id !== b.school_id) continue;
    const targets = users.filter(u => (g.user_id ? Number(u.id) === Number(g.user_id) : true) && (g.role ? u.role === g.role : true));
    for (const u of targets) {
      const k = String(u.id);
      if (g.kind === 'reset') {
        const prev = state.users[k];
        delete state.users[k];
        /* بازنشانی p2: رکورد اشتراک پاک می‌شود؛ دفتر دستگاه (آزمایشی) دست‌نخورده می‌ماند */
        if (prev && prev.trial_used) state.users[k] = { trial_used: true };
      } else if (g.kind === 'gift') {
        const days = Math.max(1, Math.min(3650, Number(g.days) || 0));
        const rec = state.users[k] || { trial_used: false };
        extend(rec, days, now);
        rec.status = 'active';
        rec.plan = rec.plan && rec.plan !== 'trial' ? rec.plan : 'gift';
        rec.role = u.role;
        state.users[k] = rec;
      }
    }
    done.add('g:' + g.id);
    n++;
  }
  saveSubs(store, state);
  const dec = plain.decisions && typeof plain.decisions === 'object' ? plain.decisions : {};
  for (const [pid, d] of Object.entries(dec)) {
    if (done.has('d:' + pid) || !d) continue;
    const p = subsState(store).payments.find(x => x.id === pid);
    if (!p) continue;
    if (d.status === 'approved') markPaid(store, p, { by: 'owner', now });
    else if (d.status === 'rejected') {
      const s2 = subsState(store);
      const row = s2.payments.find(x => x.id === pid);
      if (row && row.status !== 'paid') { row.status = 'rejected'; row.reason = String(d.reason || '').slice(0, 200); saveSubs(store, s2); }
    }
    done.add('d:' + pid);
    n++;
  }
  store.setMeta(META.applied, [...done].slice(-5000));
  return { applied: n };
}

/* ── میزبانی مدرسه: سرور تازه با ورود مدیر، مدرسهٔ ساخته‌شده در پنل مالک را می‌گیرد ── */
/* ردیف ۱۴۶: شکل نام کاربری در ورود نخستین مدیر روی سرور تازه همان قاعدهٔ همه‌جاست
   (auth.findUserByLogin، client/app.js doLogin، LanServerRules.loginProblem در برنامهٔ بومی):
   حرف لاتین ⇒ USERNAME_RE؛ وگرنه فقط رقم و دقیقاً ۱۱ (همراه) یا ۱۰ (کد ملی). شکل نادرست
   ⇒ null، پیش از هر مقایسه با فهرست مالک. */
function loginShape(login) {
  const raw = String(login == null ? '' : login).trim();
  if (/[A-Za-z]/.test(raw)) {
    const name = raw.toLowerCase();
    return USERNAME_RE.test(name) ? { name } : null;
  }
  const digits = normDigits(raw);
  return digits.length === 11 || digits.length === 10 ? { digits } : null;
}

function findManager(plain, login) {
  const k = loginShape(login);
  if (!k) return null;
  return (plain.schools || []).find(s => s && s.manager && (k.name
    ? String(s.manager.username || '').toLowerCase() === k.name
    : normDigits(s.manager.phone || '') === k.digits)) || null;
}

function adoptSchool(store, sch, { instance } = {}) {
  const m = sch.manager || {};
  store.insert('schools', {
    name: sch.name, code: sch.code || '', level: sch.level || '', type: sch.type || 'عادی',
    school_type: sch.school_type || 'governmental', gender: sch.gender || '', shift: sch.shift || 'صبح',
    province: sch.province || '', county: sch.county || '', district: sch.district || '', city: sch.county || '',
    phone: normDigits(sch.phone || ''), landline: normDigits(sch.landline || ''), address: sch.address || '',
    capacity: sch.capacity || 300, work_days: sch.work_days || [0, 1, 2, 3, 4],
    excuse_window_minutes: sch.excuse_window_minutes != null ? sch.excuse_window_minutes : 15,
    branches: sch.branches || [], fields: sch.fields || [],
    capabilities: Object.assign({}, sch.capabilities || {}),
    boom_goals: sch.boom_goals || '', public_goals: !!sch.public_goals,
    owner_school_id: sch.id, created_at: nowISO(),
  }, { id: 1 });
  const year = new Date().toLocaleDateString('fa-IR');
  store.insert('school_years', { title: year, active: true, school_id: 1, created_at: nowISO() }, { id: 1 });
  const manager = store.insert('users', {
    name: m.name || 'مدیر مدرسه', role: 'manager', phone: normDigits(m.phone || ''),
    national_id: normDigits(m.national_id || ''), username: String(m.username || '').toLowerCase(),
    active: true, school_id: 1, title: 'مدیر مدرسه', created_at: nowISO(),
    password_hash: m.password_hash, phone_hash: m.password_hash, password_enc: null,
  });
  store.setMeta(META.bound, { school_id: sch.id, at: nowISO(), manager_rev: m.rev || 1, username: String(m.username || '').toLowerCase(), instance: instance || null });
  store.audit({ user_id: manager.id, role: 'manager', action: 'school_adopt', collection: 'schools', record_id: 1, after: { owner_school_id: sch.id } });
  return manager;
}

/* ورود روی سرور تازه: اگر نام کاربری و رمز با مدیر یکی از مدارس پنل مالک یکی است، همین سرور
   میزبان آن مدرسه می‌شود (فقط یک بار؛ سرور دیگری که قبلاً میزبان شده باشد رد می‌شود). */
async function adoptOnLogin(store, login, password, { needsSetup, instance, now = Date.now() } = {}) {
  if (!needsSetup) return { ok: false, error: 'not_fresh' };
  /* شکل نادرست: نه سراغ صندوقچه می‌رویم نه رمز را می‌سنجیم (همان bad_phone ورود عادی) */
  if (!loginShape(login)) return { ok: false, error: 'bad_shape' };
  const cfg = cloud(store);
  if (!cfg) return { ok: false, error: 'not_managed' };
  let reg;
  try { reg = await pullRegistry(store, cfg); } catch (e) { reg = registry(store); }
  if (!reg) return { ok: false, error: 'not_managed' };
  const sch = findManager(reg.plain, login);
  if (!sch || !sch.manager || !sch.manager.password_hash) return { ok: false, error: 'not_found' };
  if (!verifySecret(String(password || ''), sch.manager.password_hash)) return { ok: false, error: 'bad_credentials' };
  if (sch.active === false) return { ok: false, error: 'school_inactive' };
  try {
    const ack = await readEnv(cfg, cfg.prefix + DIR.ack + sch.id + '.json', K.ack);
    if (ack && !ack.invalid && ack.plain.instance && ack.plain.instance !== instance) {
      return { ok: false, error: 'school_hosted_elsewhere' };
    }
  } catch (e) { /* صندوقچه در دسترس نیست: نمی‌توانیم مطمئن شویم */ return { ok: false, error: 'registry_unreachable' }; }
  const manager = adoptSchool(store, sch, { instance });
  await writeAck(store, { instance, now }).catch(() => {});
  return { ok: true, manager };
}

/* مالک رمز یا نام کاربری مدیر را عوض کرد ⇒ روی سرور میزبان اعمال شود */
function applySchool(store, sch) {
  const b = boundOf(store);
  if (!b || !sch) return false;
  const m = sch.manager || {};
  const rev = Number(m.rev || 1);
  let changed = false;
  if (rev > Number(b.manager_rev || 0) && m.password_hash) {
    const managers = (store.all('users') || []).filter(u => u.role === 'manager');
    const mgr = managers.find(u => u.username && u.username === String(b.username || '')) || managers[0];
    if (mgr) {
      store.update('users', mgr.id, { password_hash: m.password_hash, phone_hash: m.password_hash, password_enc: null, username: String(m.username || mgr.username || '').toLowerCase(), name: m.name || mgr.name });
      store.audit({ user_id: mgr.id, role: 'manager', action: 'owner_manager_reset', collection: 'users' });
    }
    store.setMeta(META.bound, Object.assign({}, b, { manager_rev: rev, username: String(m.username || '').toLowerCase() }));
    changed = true;
  }
  const s1 = store.get('schools', 1);
  if (s1 && (s1.name !== sch.name || s1.level !== sch.level)) {
    store.update('schools', 1, { name: sch.name, level: sch.level, capabilities: Object.assign({}, s1.capabilities || {}, sch.capabilities || {}) });
    changed = true;
  }
  return changed;
}

async function writeAck(store, { instance, publicUrl, version, now = Date.now() } = {}) {
  const cfg = cloud(store);
  const b = boundOf(store);
  if (!cfg || !b) return false;
  const users = store.all('users') || [];
  const byRole = {};
  for (const u of users) byRole[u.role] = (byRole[u.role] || 0) + 1;
  const state = subsState(store);
  const subs = [];
  for (const [uid, rec] of Object.entries(state.users)) {
    const u = users.find(x => String(x.id) === uid);
    if (!rec.end) continue;
    subs.push({ uid: Number(uid), name: u ? u.name || '' : '', role: rec.role || (u && u.role) || '', status: Date.parse(rec.end) > now ? rec.status || 'active' : 'expired', plan: rec.plan || null, start: rec.start || null, end: rec.end });
  }
  await writeEnv(cfg, cfg.prefix + DIR.ack + b.school_id + '.json', K.ack, now, {
    v: 1, school_id: b.school_id, instance: instance || b.instance || null, at: new Date(now).toISOString(),
    public_url: publicUrl || null, version: version || null,
    users: { total: users.length, by_role: byRole }, subs: subs.slice(0, 2000),
  });
  return true;
}

/* ── درخواست ثبت‌نام مدرسهٔ جدید (عمومی، بدون نشست) ─────────────── */
const newReqId = (now) => String(now).padStart(13, '0') + '-' + crypto.randomBytes(8).toString('hex');
function validRequest(b) {
  const t = (v, a, z) => { const s = String(v == null ? '' : v).trim(); return s.length >= a && s.length <= z ? s : null; };
  const n = (v, z) => {
    const d = String(v == null ? '' : v).trim().replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06F0)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660));
    if (!/^[0-9]{1,6}$/.test(d)) return null;
    const x = Number(d);
    return x <= z ? x : null;
  };
  const out = {
    school_name: t(b.school_name, 2, 120),
    level: LEVELS.includes(String(b.level || '')) ? String(b.level) : null,
    province: t(b.province, 2, 40),
    county: t(b.county, 2, 60),
    village: t(b.village == null ? '' : b.village, 0, 60),
    phone: /^0\d{10}$/.test(normDigits(b.phone)) ? normDigits(b.phone) : null,
    staff_count: n(b.staff_count, 10000),
    student_count: n(b.student_count, 100000),
    manager_name: t(b.manager_name, 3, 80),
    username: USERNAME_RE.test(String(b.username || '').trim().toLowerCase()) ? String(b.username).trim().toLowerCase() : null,
  };
  for (const [k, v] of Object.entries(out)) if (v === null) return { error: 'bad_' + k };
  if (String(b.password || '').length < 6) return { error: 'bad_password' };
  return { value: out };
}

async function register(store, body, { now = Date.now(), instance, publicUrl, hash } = {}) {
  const v = validRequest(body || {});
  if (v.error) return { ok: false, error: v.error };
  const cfg = cloud(store);
  if (!cfg) return { ok: false, error: 'not_connected' };
  let reg = null;
  try { reg = await pullRegistry(store, cfg); } catch (e) { reg = registry(store); }
  if (reg && findManager(reg.plain, v.value.username)) return { ok: false, error: 'username_taken' };
  const id = newReqId(now);
  const token = crypto.randomBytes(16).toString('hex');
  const dh = String(body.device_hash || '').toLowerCase();
  const plain = Object.assign({ v: 1, id, at: new Date(now).toISOString() }, v.value, {
    password_hash: hash(String(body.password)),
    device: DEV_RE.test(dh) ? trialKey(dh) : null,
    server: { instance: instance || null, public_url: publicUrl || null },
  });
  try { await writeEnv(cfg, cfg.prefix + DIR.req + id + '.json', K.request, now, plain); } catch (e) { return { ok: false, error: 'registry_unreachable' }; }
  const mine = store.getMeta(META.mine, {}) || {};
  mine[id] = crypto.createHash('sha256').update(token).digest('hex');
  store.setMeta(META.mine, mine);
  store.audit({ role: 'system', action: 'school_register_request', collection: 'schools', after: { id, school: v.value.school_name } });
  return { ok: true, id, token, status: 'pending' };
}

async function requestStatus(store, id, token) {
  if (!ID_RE.test(String(id || ''))) return { ok: false, error: 'bad_id' };
  const mine = store.getMeta(META.mine, {}) || {};
  const h = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  if (!mine[id] || mine[id] !== h) return { ok: false, error: 'not_found' };
  const cfg = cloud(store);
  let reg = registry(store);
  if (cfg) { try { reg = await pullRegistry(store, cfg); } catch (e) { /* از نسخهٔ ذخیره */ } }
  const plain = reg ? reg.plain : { schools: [] };
  const sch = (plain.schools || []).find(s => s.request_id === id);
  if (sch) return { ok: true, status: sch.active === false ? 'inactive' : 'approved', school: sch.name, username: (sch.manager || {}).username || null };
  const rj = (Array.isArray(plain.rejected) ? plain.rejected : []).find(x => x && x.id === id);
  if (rj) return { ok: true, status: 'rejected', reason: rj.reason || '' };
  return { ok: true, status: 'pending' };
}

/* ── دور تناوبی ─────────────────────────────────────────────────────── */
async function poll(store, { instance, publicUrl, version, now = Date.now() } = {}) {
  const cfg = cloud(store);
  if (!cfg) return { ok: false, error: 'not_configured' };
  const reg = await pullRegistry(store, cfg);
  if (!reg) return { ok: true, managed: false };
  const sch = schoolOf(store);
  if (sch) applySchool(store, sch);
  const a = applyOwner(store, reg.plain, { now });
  if (boundOf(store)) await writeAck(store, { instance, publicUrl, version, now });
  return { ok: true, managed: true, bound: !!boundOf(store), applied: a.applied };
}

let timer = null;
function start(store, { everyMs = INTERVAL_MS, instance = () => null, publicUrl = () => null, version = () => null, log = (m) => console.log(m) } = {}) {
  if (timer) return;
  const tick = async () => {
    try { await poll(store, { instance: instance(), publicUrl: publicUrl(), version: version() }); } catch (e) { /* دفعهٔ بعد */ }
  };
  setTimeout(tick, 5_000).unref();
  timer = setInterval(tick, everyMs);
  timer.unref();
  log('[schools] پیروی از فهرست مدارس و اشتراک پنل مالک روشن شد');
}
function stop() { if (timer) clearInterval(timer); timer = null; }

/* صفحهٔ کوچک بازگشت از درگاه (بدون اسکریپت) */
function callbackPage(r) {
  const ok = r && r.status === 'paid';
  const pend = r && r.status === 'pending';
  const title = ok ? 'پرداخت موفق بود' : pend ? 'پرداخت ثبت شد و پس از تأیید فعال می‌شود' : 'پرداخت انجام نشد';
  const id = r && r.payment ? r.payment.id : '';
  return '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>پایش</title><body style="font-family:Tahoma,sans-serif;text-align:center;padding:40px">' +
    '<h2>' + title + '</h2>' + (id ? '<p>کد پیگیری: <b dir="ltr">' + id + '</b></p>' : '') +
    '<p>به برنامهٔ پایش برگردید و «بررسی دوباره» را بزنید.</p></body></html>';
}

module.exports = {
  K, DIR, SALT: SALT.toString('utf8'), PLANS, ROLES, DEFAULTS, LEVELS, USERNAME_RE,
  RegistryError, seal, open, keyFor, readEnv, writeEnv, trialKey, settingsOf, verifyOk, fill,
  registry, boundOf, schoolOf, gate, startTrial, startPayment, submitReceipt, callback, callbackPage,
  applyOwner, adoptOnLogin, adoptSchool, findManager, loginShape, register, requestStatus, validRequest,
  pullRegistry, writeAck, poll, start, stop, subsState, markPaid,
};
