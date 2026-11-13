'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پشتیبانی — پیام و گزارش مشکل کاربران به مالک (ردیف ۱۵۲ · درخواست مالک ۲۰۲۶‑۱۱‑۱۳)
   ───────────────────────────────────────────────────────────────────
   مسیر همان پرداخت‌هاست: برنامهٔ کاربر ← سرور مدرسه ← صندوقچهٔ مالک (Arvan) ← پنل مالک.
   برنامهٔ کاربر هرگز کلید صندوقچه را ندارد.

   قرارداد support v1 (Node = Dart، همان پاکت و نمک «payesh/schools» قرارداد schools v1):
     <prefix>schools/support/<TKT-id>.json        تیکت + پیام‌های کاربر   kind=payesh-support-ticket (سرور مدرسه)
     <prefix>schools/support-reply/<TKT-id>.json  پاسخ‌ها و وضعیت مالک     kind=payesh-support-reply  (پنل مالک)
   هر پرونده فقط یک نویسنده دارد، پس دو طرف هیچ‌وقت نوشتهٔ هم را پاک نمی‌کنند.

   هیچ پیامی گم نمی‌شود: هر تیکت اول در پایگاه دادهٔ همین سرور ذخیره می‌شود؛ اگر صندوقچه در
   دسترس نبود «در صف ارسال» می‌ماند و در هر درخواست بعدی و هر چرخهٔ poll دوباره فرستاده می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const sr = require('./school-registry');
const s3mem = require('./s3mem');
const { nowISO } = require('./util');

const K = { ticket: 'payesh-support-ticket', reply: 'payesh-support-reply' };
const DIR = { ticket: 'schools/support/', reply: 'schools/support-reply/' };
const META = 'support:tickets';
const CATEGORIES = ['bug', 'question', 'payment', 'account', 'suggestion', 'other'];
const STATUSES = ['open', 'answered', 'closed'];
const ID_RE = /^TKT-[0-9A-F]{8}$/;
const LIMITS = { subject: [3, 120], text: [2, 2000], messages: 100, keep: 1000, perUser: 50 };

class SupportError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const newId = () => 'TKT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (s, max) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().slice(0, max);

function cloud(store) {
  const c = s3mem.usingMeta(store).get();
  return c && c.enabled ? c : null;
}

function state(store) {
  const s = store.getMeta(META);
  return Array.isArray(s) ? s : [];
}
function save(store, list) { store.setMeta(META, list.slice(-LIMITS.keep)); }

/* پاکت تیکت: فقط چیزهایی که مالک لازم دارد (بدون رمز/توکن) */
function envelopeOf(t) {
  return {
    v: 1, id: t.id, school_id: t.school_id, school: t.school, uid: t.uid, name: t.name, role: t.role,
    category: t.category, subject: t.subject, closed_by_user: !!t.closed_by_user,
    created_at: t.created_at, updated_at: t.updated_at,
    messages: t.messages.filter(m => m.from === 'user'),
  };
}

async function upload(store, t) {
  const cfg = cloud(store);
  if (!cfg) return false;
  try {
    await sr.writeEnv(cfg, cfg.prefix + DIR.ticket + t.id + '.json', K.ticket, Date.parse(t.updated_at) || Date.now(), envelopeOf(t));
    return true;
  } catch (e) { return false; }
}

/* تیکت‌های در صف ارسال (صندوقچه قبلاً در دسترس نبود) — بی‌صدا دوباره فرستاده می‌شوند */
async function flush(store) {
  const list = state(store);
  const due = list.filter(t => t.pending);
  if (!due.length) return 0;
  let sent = 0;
  for (const t of due) {
    if (await upload(store, t)) { t.pending = false; sent++; }
    else break;
  }
  if (sent) {
    const now = state(store);
    for (const t of due) {
      const row = now.find(x => x.id === t.id);
      if (row && !t.pending && row.updated_at === t.updated_at) row.pending = false;
    }
    save(store, now);
  }
  return sent;
}

function schoolInfo(store) {
  const b = sr.boundOf(store);
  let name = '';
  try { const s = sr.schoolOf(store); if (s) name = s.name || ''; } catch (e) { /* فقط نمایش */ }
  if (!name) {
    try { const row = store.get('schools', 1); if (row) name = row.name || ''; } catch (e) { /* فقط نمایش */ }
  }
  return { school_id: b ? b.school_id : null, school: name };
}

function publicTicket(t) {
  return {
    id: t.id, category: t.category, subject: t.subject, status: t.status || 'open',
    created_at: t.created_at, updated_at: t.updated_at, pending: !!t.pending,
    messages: t.messages.map(m => ({ at: m.at, from: m.from, text: m.text })),
  };
}

async function create(store, user, body = {}) {
  const category = CATEGORIES.includes(body.category) ? body.category : 'other';
  const subject = clean(body.subject, LIMITS.subject[1]);
  const text = cleanText(body.text, LIMITS.text[1]);
  if (subject.length < LIMITS.subject[0]) throw new SupportError('bad_subject');
  if (text.length < LIMITS.text[0]) throw new SupportError('bad_text');
  const at = nowISO();
  const t = Object.assign({
    id: newId(), uid: user.id, name: user.name || '', role: user.role, category, subject,
    status: 'open', created_at: at, updated_at: at, pending: true,
    messages: [{ at, from: 'user', text }],
  }, schoolInfo(store));
  const list = state(store);
  list.push(t);
  save(store, list);
  store.audit({ user_id: user.id, role: user.role, action: 'support_open', collection: 'support', after: { id: t.id, category } });
  await flush(store);
  const row = state(store).find(x => x.id === t.id) || t;
  return { ok: true, ticket: publicTicket(row), reported: !row.pending };
}

function own(store, user, id) {
  if (!ID_RE.test(String(id || ''))) throw new SupportError('bad_id');
  const list = state(store);
  const t = list.find(x => x.id === id && x.uid === user.id);
  if (!t) throw new SupportError('not_found');
  return { list, t };
}

async function message(store, user, id, body = {}) {
  const { list, t } = own(store, user, id);
  const text = cleanText(body.text, LIMITS.text[1]);
  if (text.length < LIMITS.text[0]) throw new SupportError('bad_text');
  if (t.messages.length >= LIMITS.messages) throw new SupportError('too_many_messages');
  const at = nowISO();
  t.messages.push({ at, from: 'user', text });
  t.updated_at = at;
  t.status = 'open';
  t.closed_by_user = false;
  t.pending = true;
  save(store, list);
  await flush(store);
  const row = state(store).find(x => x.id === t.id) || t;
  return { ok: true, ticket: publicTicket(row), reported: !row.pending };
}

async function close(store, user, id) {
  const { list, t } = own(store, user, id);
  const at = nowISO();
  t.status = 'closed';
  t.closed_by_user = true;
  t.updated_at = at;
  t.pending = true;
  save(store, list);
  await flush(store);
  const row = state(store).find(x => x.id === t.id) || t;
  return { ok: true, ticket: publicTicket(row), reported: !row.pending };
}

/* پاسخ‌های مالک را می‌خواند و با پیام‌های کاربر به ترتیب زمان ادغام می‌کند */
async function pullReplies(store, tickets) {
  const cfg = cloud(store);
  if (!cfg || !tickets.length) return false;
  const list = state(store);
  let changed = false;
  for (const t of tickets) {
    let r;
    try { r = await sr.readEnv(cfg, cfg.prefix + DIR.reply + t.id + '.json', K.reply); } catch (e) { return false; }
    if (!r || r.invalid || !r.plain || r.plain.id !== t.id) continue;
    const row = list.find(x => x.id === t.id);
    if (!row) continue;
    const owner = (Array.isArray(r.plain.messages) ? r.plain.messages : [])
      .filter(m => m && typeof m.text === 'string' && typeof m.at === 'string')
      .map(m => ({ at: m.at, from: 'owner', text: cleanText(m.text, LIMITS.text[1]) }));
    const users = row.messages.filter(m => m.from === 'user');
    const merged = users.concat(owner).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const ownerAt = owner.length ? owner[owner.length - 1].at : '';
    const lastUser = users.length ? users[users.length - 1].at : '';
    /* وضعیت مالک فقط وقتی معتبر است که پس از آخرین پیام کاربر گذاشته شده باشد */
    const st = STATUSES.includes(r.plain.status) ? r.plain.status : null;
    const stAt = String(r.plain.updated_at || ownerAt || '');
    let status = row.status || 'open';
    if (st && stAt >= lastUser && !(row.closed_by_user && st !== 'closed' && stAt < row.updated_at)) status = st;
    if (JSON.stringify(merged) !== JSON.stringify(row.messages) || status !== row.status) {
      row.messages = merged;
      row.status = status;
      changed = true;
    }
  }
  if (changed) save(store, list);
  return true;
}

async function list(store, user) {
  await flush(store);
  const mine = state(store).filter(t => t.uid === user.id).slice(-LIMITS.perUser);
  const online = await pullReplies(store, mine.filter(t => t.status !== 'closed' || !t.closed_by_user));
  const out = state(store).filter(t => t.uid === user.id).slice(-LIMITS.perUser).reverse().map(publicTicket);
  return { ok: true, tickets: out, online, categories: CATEGORIES };
}

/* چرخهٔ پس‌زمینه (همراه poll مدارس): صف ارسال خالی می‌شود حتی اگر کاربر برنامه را باز نکند */
let timer = null;
function start(store, { every = 60_000 } = {}) {
  stop();
  timer = setInterval(() => { flush(store).catch(() => {}); }, every);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  K, DIR, META, CATEGORIES, STATUSES, ID_RE, LIMITS, SupportError,
  create, message, close, list, flush, pullReplies, envelopeOf, publicTicket, start, stop,
};
