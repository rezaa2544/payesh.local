'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف‌های ۲۰۵/۲۰۸/۲۰۹/۲۱۰ — قرارداد Helper v2 (افزودنی، سازگار با v1)
   ───────────────────────────────────────────────────────────────────
   v1 دست‌نخورده می‌ماند: پاکت (envelope) همان v:1 و AES-256-GCM/HKDF است؛
   متنِ داخل پاکت (plain) می‌تواند v:1 (قدیمی) یا v:2 (فیلدهای افزوده) باشد.
   خوانندهٔ v1 فیلدهای اضافه را نادیده می‌گیرد؛ خوانندهٔ v2 برای plainِ v1
   مقدار پیش‌فرض می‌گذارد (کلاس owner، capabilities = kinds، کلاس داده internal).

   کلاس‌های executor: owner | school | cloudflare | actions
   کلاس داده: public | internal | school-content
   قاعدهٔ سخت (تصمیم مالک ۲۰۲۶-۱۱-۲۸): school-content فقط روی owner یا
   همان مدرسه (school با school_id برابر فرستنده)؛ هرگز cloudflare/actions.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const EXECUTOR_CLASSES = ['owner', 'school', 'cloudflare', 'actions'];
const DATA_CLASSES = ['public', 'internal', 'school-content'];
const PRIORITIES = ['high', 'normal', 'low'];

/* ردیف ۲۰۸ — کاتالوگ نوع‌کارها: نگاشت نوع‌کار ← کلاس داده و executorهای مجاز */
const JOB_CATALOG = Object.freeze({
  'storage.usage':   { data_class: 'internal', executors: ['owner', 'school', 'cloudflare', 'actions'], idempotent: true,  max_ms: 120000 },
  'object.verify':   { data_class: 'internal', executors: ['owner', 'school', 'cloudflare', 'actions'], idempotent: true,  max_ms: 300000 },
  'endpoint.check':  { data_class: 'public',   executors: ['owner', 'school', 'cloudflare', 'actions'], idempotent: true,  max_ms: 30000 },
  'bucket.gc':       { data_class: 'internal', executors: ['owner', 'cloudflare', 'actions'],          idempotent: true,  max_ms: 180000 },
  'backup.verify':   { data_class: 'internal', executors: ['owner', 'school', 'actions'],               idempotent: true,  max_ms: 600000 },
  'report.aggregate':{ data_class: 'school-content', executors: ['owner', 'school'],                    idempotent: true,  max_ms: 600000 },
  'update.build':    { data_class: 'internal', executors: ['owner', 'actions'],                         idempotent: true,  max_ms: 900000 },
});
const catalogOf = (kind) => JOB_CATALOG[kind] || null;

const SCHOOL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

function normalizePresence(p) {
  if (!p || typeof p !== 'object') return null;
  const kinds = Array.isArray(p.kinds) ? p.kinds.filter(k => JOB_CATALOG[k] || ['storage.usage','object.verify','endpoint.check','bucket.gc'].includes(k)) : [];
  const caps = Array.isArray(p.caps) ? p.caps.filter(k => typeof k === 'string').slice(0, 32) : kinds;
  return {
    v: p.v === 2 ? 2 : 1,
    helper_id: String(p.helper_id || ''),
    cls: EXECUTOR_CLASSES.includes(p.cls) ? p.cls : 'owner',
    caps: caps.length ? caps : kinds,
    kinds,
    capacity: Number.isSafeInteger(p.capacity) && p.capacity > 0 ? Math.min(p.capacity, 64) : (Number(p.slots) || 1),
    slots: Number(p.slots) || 1,
    cpu_cap: Number.isInteger(p.cpu_cap) && p.cpu_cap >= 10 && p.cpu_cap <= 100 ? p.cpu_cap : null,
    region: typeof p.region === 'string' ? p.region.slice(0, 40) : '',
    contract: typeof p.contract === 'string' ? p.contract.slice(0, 20) : (p.v === 2 ? '2' : '1'),
    school_id: typeof p.school_id === 'string' && SCHOOL_ID_RE.test(p.school_id) ? p.school_id : null,
  };
}

function normalizeJobMeta(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    v: job.v === 2 ? 2 : 1,
    priority: PRIORITIES.includes(job.priority) ? job.priority : 'normal',
    data_class: DATA_CLASSES.includes(job.data_class) ? job.data_class : 'internal',
    idempotency_key: typeof job.idempotency_key === 'string' ? job.idempotency_key.slice(0, 128) : String(job.job_id || ''),
    school_id: typeof job.school_id === 'string' && SCHOOL_ID_RE.test(job.school_id) ? job.school_id : null,
    deadline_at: Number.isSafeInteger(job.deadline_at) ? job.deadline_at : null,
  };
}

/* آیا این executor حق برداشتن این کار را دارد؟ (دفاع دوطرفه: فرستنده و گیرنده) */
function canLease(presence, job) {
  const pr = normalizePresence(presence); const meta = normalizeJobMeta(job);
  if (!pr || !meta) return false;
  const cat = catalogOf(job.kind);
  const allowedCls = cat ? cat.executors : ['owner'];
  if (!allowedCls.includes(pr.cls)) return false;
  if (!pr.caps.includes(job.kind) && !pr.kinds.includes(job.kind)) return false;
  if (meta.data_class === 'school-content') {
    if (pr.cls === 'owner') return true;
    if (pr.cls === 'school' && meta.school_id && pr.school_id === meta.school_id) return true;
    return false;
  }
  if (pr.cls === 'school' && meta.school_id && pr.school_id !== meta.school_id && meta.data_class !== 'public') return false;
  return true;
}

/* انتخاب بهترین executor: توانایی > اولویت‌پذیری > بار کمتر > تازه‌تر > کلاس نزدیک‌تر */
function pickExecutor(candidates, job, now = Date.now()) {
  const meta = normalizeJobMeta(job);
  const ok = (candidates || []).filter(c => canLease(c, job) && c.online !== false);
  if (!ok.length) return null;
  const prioBoost = meta && meta.priority === 'high' ? 0 : 0;
  const score = (c) => {
    const pr = normalizePresence(c);
    let s = 0;
    s += Math.min(pr.capacity, 8) * 2;
    s -= (Number(c.load) || 0) * 20;                 /* بار لحظه‌ای ۰..۱ */
    s += Math.max(0, 10 - Math.floor((now - (Number(c.at) || 0)) / 10000)); /* تازگی حضور */
    if (pr.cls === 'owner') s += 3; else if (pr.cls === 'school') s += 2; else if (pr.cls === 'cloudflare') s += 1;
    return s + prioBoost;
  };
  return ok.slice().sort((a, b) => score(b) - score(a))[0];
}

/* ردیف ۲۱۰ — polling تطبیقی: صف خالی ⇒ backoff نمایی با jitter تا سقف؛ کار هست ⇒ کوتاه */
function nextPollDelay(attempt, { hasJob = false, baseMs = 5000, maxMs = 300000, rand = Math.random } = {}) {
  if (hasJob) return baseMs;
  const a = Math.max(0, Math.min(Number(attempt) || 0, 20));
  const d = Math.min(maxMs, baseMs * Math.pow(2, a));
  return Math.round(d * (0.8 + rand() * 0.4));
}

/* ردیف ۲۰۹ — توکن اختصاصی مدرسه: <school_id>.<b64u(HMAC-SHA256(secret, "school-helper:"+id))>
   توکن از همان سکرت صندوقچه مشتق می‌شود؛ سکرت هرگز به مدرسه داده نمی‌شود و
   ابطال = چرخش سکرت/فهرست ابطال در سیاست مالک (docs/cloud/209-...). */
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function schoolToken(secret, schoolId) {
  if (!SCHOOL_ID_RE.test(String(schoolId || ''))) throw new Error('bad_school_id');
  const mac = crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update('payesh/school-helper:' + schoolId).digest();
  return schoolId + '.' + b64u(mac);
}
function verifySchoolToken(secret, token) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i <= 0) return null;
  const id = t.slice(0, i);
  if (!SCHOOL_ID_RE.test(id)) return null;
  let want;
  try { want = schoolToken(secret, id); } catch (e) { return null; }
  const a = Buffer.from(want), b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

module.exports = {
  EXECUTOR_CLASSES, DATA_CLASSES, PRIORITIES, JOB_CATALOG, catalogOf,
  normalizePresence, normalizeJobMeta, canLease, pickExecutor, nextPollDelay,
  schoolToken, verifySchoolToken, SCHOOL_ID_RE,
};
