/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال — هستهٔ کلاینت (بدون چارچوب، بدون CDN)
   ذخیره‌سازی: IndexedDB برای داده + localStorage برای توکن/صف
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* با build-release هم‌تراز می‌شود؛ برای تشخیص «نسخهٔ کهنه در حافظهٔ مرورگر» */
const CLIENT_VERSION = '0.8.15';

/* ── حالت «همه‌چیز داخل برنامه» (اندروید/ویندوز بسته‌بندی‌شده) ──────────
   وقتی فایل‌ها روی خودِ دستگاه اجرا می‌شوند (و نه از خود سرور)، آدرس سرور
   از بیرون تزریق می‌شود: window.PAYESH_API_BASE = "https://…" */
const API_BASE = String(window.PAYESH_API_BASE || '').replace(/\/+$/, '');
const BUNDLED = !!window.PAYESH_BUNDLED;
const apiUrl = (path) => (API_BASE ? API_BASE + path : path);

/* حالت «گوشی/بدون سرور»: کل برنامه روی خودِ دستگاه، با داده و ورودی
   صندوقچهٔ ابری. اگر سرور مدرسه پیدا شود، همان مسیر عادی مقدم است. */
let PHONE_MODE = false;

const S = {
  online: navigator.onLine,
  server: { ok: false, version: '0.0.0', school: null, setupDone: false },
  deviceToken: localStorage.getItem('payesh.device') || '',
  session: localStorage.getItem('payesh.session') || '',
  user: null, role: null, boot: null,
  data: {},                 /* collection -> Map(id -> row) */
  queue: JSON.parse(localStorage.getItem('payesh.queue') || '[]'),
  lastSync: localStorage.getItem('payesh.sync_at') || '',
  route: 'home', params: {},
  modal: null, busy: false,
  clockOffset: 0,
  update: null,
  remote: null,             /* وضعیت به‌روزرسانی درجا از مخزن (مدیر) */
  remoteBusy: false,
  outbox: null,             /* وضعیت صندوقچهٔ آفلاین (ابر) */
  tunnelBusy: false,
  tempId: -1,
  syncing: false,
  creds: undefined,         /* رمز جاری کاربران (فقط مدیر) */
};

/* ── ابزارهای پایه ─────────────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fa = n => String(n == null ? '' : n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const norm = s => String(s == null ? '' : s).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const now = () => new Date(Date.now() + S.clockOffset);
const todayISO = () => now().toISOString().slice(0, 10);
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 9));
const byId = (c, id) => (S.data[c] && S.data[c].get(Number(id))) || null;
const list = c => (S.data[c] ? [...S.data[c].values()] : []);
const sortBy = (arr, f) => arr.slice().sort((a, b) => String(a[f] || '').localeCompare(String(b[f] || '')));

/* ── تاریخ شمسی ─────────────────────────────────────────────────── */
function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  jy += Math.floor((days - 1) / 365);
  if (days > 365) days = (days - 1) % 365;
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}
const J_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const J_DAYS = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'];
function jdate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return '—';
  const [jy, jm, jd] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${jd} ${J_MONTHS[jm - 1]} ${jy}`;
}
function weekdayIndex(d = now()) { return (d.getDay() + 1) % 7; }
function toMin(t) {
  const s = norm(String(t || '')).split(':');
  return (Number(s[0]) || 0) * 60 + (Number(s[1]) || 0);
}
function nowMin() { const d = now(); return d.getHours() * 60 + d.getMinutes(); }

/* ── ذخیره‌سازی IndexedDB ───────────────────────────────────────── */
let _idb = null;
const HAS_IDB = (() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB.open; } catch (e) { return false; } })();
function idbOpen() {
  if (!HAS_IDB) return Promise.reject(new Error('no_idb'));
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('payesh_local', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
}
function idbSet(key, value) {
  if (!HAS_IDB) { try { localStorage.setItem('payesh.cache.' + key, JSON.stringify(value)); } catch (e) { /* noop */ } return Promise.resolve(); }
  return idbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  })).catch(() => { /* بی‌صدا */ });
}
function idbGet(key) {
  if (!HAS_IDB) { try { return Promise.resolve(JSON.parse(localStorage.getItem('payesh.cache.' + key))); } catch (e) { return Promise.resolve(null); } }
  return idbOpen().then(db => new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  })).catch(() => null);
}

function saveCache() {
  const plain = {};
  for (const c of Object.keys(S.data)) plain[c] = [...S.data[c].values()];
  idbSet('data', plain);
  idbSet('saved_at', new Date().toISOString());
}
function saveQueue() { localStorage.setItem('payesh.queue', JSON.stringify(S.queue.slice(-500))); }

/* ── ارتباط با سرور ─────────────────────────────────────────────── */
/* ── «یک‌بار ورود، همیشه داخل» ────────────────────────────────────────
   اگر نشست منقضی شد ولی این دستگاه قبلاً به حساب گره خورده، بی‌صدا
   نشست تازه می‌گیریم؛ کاربر دوباره رمز نمی‌زند. */
let refreshing = null;
async function silentRefresh() {
  if (!S.deviceToken) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: S.deviceToken }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok || !data.session) return false;
      saveSession(data.session.token);
      S.session = data.session.token;
      if (data.user) {
        S.user = data.user; S.role = data.user.role;
        localStorage.setItem('payesh.lastname', data.user.name || '');
        try { localStorage.setItem('payesh.lastuser', JSON.stringify({ user: data.user, role: data.user.role, version: S.server.version, school: S.server.school })); } catch (e) { /* noop */ }
      }
      return true;
    } catch (e) { return false; }
    finally { setTimeout(() => { refreshing = null; }, 1500); }
  })();
  return refreshing;
}

/* ── در حالت گوشی هیچ سروری نیست ─────────────────────────────────────
   پیش‌تر این‌جا خطا پرتاب می‌شد و کاربر (هر نقشی، از جمله ولی) به دیوار
   «نیازمند سیستم مدرسه» می‌خورد — حتی برای کاری که روی گوشی کاملاً ممکن
   بود. حالا به‌جای خطا، یک پاسخ خالی و بی‌خطر برمی‌گردد: خواندن‌ها چیزی
   اضافه نمی‌کنند (دادهٔ محلی/صندوقچه همان‌جا هست) و نوشتن‌ها از مسیر
   صف → صندوقچه می‌روند. هیچ کاربری به این دیوار نمی‌خورد. */
function phoneApiStub(path, opts) {
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  const at = new Date().toISOString();
  if (method !== 'GET') return { ok: true, offline: true, queued: true, at };
  if (/\/api\/v1\/pull/.test(path)) {
    return { ok: true, offline: true, collections: {}, deleted: [], more: false, server_time: at };
  }
  if (/\/api\/live\/rev/.test(path)) return { ok: true, offline: true, rev: '', every_ms: 1000, cloud: true };
  if (/\/api\/outbox\/state/.test(path)) return { ok: true, offline: true, pending: 0 };
  if (/\/api\/bootstrap/.test(path)) return { ok: true, offline: true, role: S.role, user: S.user };
  return { ok: true, offline: true };
}

async function api(path, opts = {}) {
  if (PHONE_MODE) return phoneApiStub(path, opts);
  const headers = { 'content-type': 'application/json' };
  if (S.session) headers.authorization = 'Bearer ' + S.session;
  const res = await fetch(apiUrl(path), {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = { ok: false, error: 'bad_response' }; }
  if (res.status === 401 && !opts.noAuthRedirect && !opts._retried && S.deviceToken) {
    /* نشست منقضی شده؟ بی‌صدا تازه‌اش می‌کنیم و همان درخواست را تکرار می‌کنیم */
    if (await silentRefresh()) return api(path, Object.assign({}, opts, { _retried: true }));
  }
  if (res.status === 401 && !opts.noAuthRedirect) { lockApp(); }
  if (!res.ok || data.ok === false) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.data = data; err.status = res.status;
    throw err;
  }
  return data;
}

/* پیام فارسی و روشن برای خطاهای سرور — هیچ کد انگلیسی به کاربر نشان داده نمی‌شود */
function friendlyError(e) {
  const raw = String((e && (e.message || e)) || '');
  const st = e && e.status;
  const map = {
    not_found: 'این کاربر در سیستم مدرسه هنوز ثبت نشده؛ تغییر شما ذخیره شد و با همگام‌سازی اعمال می‌شود',
    user_not_found: 'این کاربر در سیستم مدرسه پیدا نشد (شاید حذف شده باشد)',
    unauthorized: 'نشست شما منقضی شده — یک‌بار دوباره وارد شوید',
    forbidden: 'اجازهٔ این کار را ندارید',
    bad_password: 'رمز باید حداقل ۴ نویسه باشد',
    bad_phone: 'شمارهٔ همراه کامل نیست',
    duplicate_phone: 'این شماره برای کاربر دیگری ثبت شده است',
    no_national_id: 'کد ملی این کاربر ثبت نشده',
    rate_limited: 'کمی صبر کنید و دوباره بزنید',
    body_too_large: 'حجم اطلاعات زیاد بود',
    offline: 'سیستم مدرسه در دسترس نیست — تغییر ذخیره شد و با اتصال بعدی اعمال می‌شود',
  };
  if (map[raw]) return map[raw];
  if (st === 404) return map.not_found;
  if (st === 401) return map.unauthorized;
  if (st === 403) return map.forbidden;
  if (/Failed to fetch|NetworkError|load failed/i.test(raw)) return map.offline;
  return raw || 'خطای نامشخص';
}

function toast(msg, kind = '') {
  const wrap = $('#toasts'); if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 2600);
}

/* ── همگام‌سازی ─────────────────────────────────────────────────── */
function mergeRows(collections, deleted) {
  for (const name of Object.keys(collections || {})) {
    if (!S.data[name]) S.data[name] = new Map();
    for (const row of collections[name]) {
      const cur = S.data[name].get(Number(row.id));
      if (cur && (cur._version || 0) > (row._version || 0)) continue;
      S.data[name].set(Number(row.id), row);
    }
  }
  for (const d of deleted || []) {
    const m = S.data[d.collection];
    if (m) m.delete(Number(d.id));
  }
}

async function pullAll() {
  /* روی گوشی هیچ سروری نیست؛ داده از صندوقچه می‌آید (pullData) */
  if (PHONE_MODE) return;
  let since = S.lastSync || '1970-01-01T00:00:00.000Z';
  let guard = 0, serverTime = null;
  while (guard++ < 25) {
    const r = await api('/api/v1/pull?since=' + encodeURIComponent(since));
    if (r.server_time) {
      serverTime = r.server_time;
      S.clockOffset = new Date(r.server_time).getTime() - Date.now();
    }
    mergeRows(r.collections, r.deleted);
    if (!r.more) break;
    since = r.next_since || r.server_time;
  }
  if (serverTime) { S.lastSync = serverTime; localStorage.setItem('payesh.sync_at', serverTime); }
  saveCache();
}

async function flushQueue() {
  if (!S.queue.length || S.syncing) return { pushed: 0 };
  /* روی گوشی، مقصدِ ثبت‌ها صندوقچهٔ ابری است، نه یک سرور */
  if (PHONE_MODE) {
    S.syncing = true;
    try { return { pushed: await pushQueueToOutbox() }; }
    finally { S.syncing = false; }
  }
  S.syncing = true;
  let pushed = 0;
  try {
    while (S.queue.length) {
      const batch = S.queue.slice(0, 120);
      const r = await api('/api/sync', { method: 'POST', body: { ops: batch }, noAuthRedirect: false });
      const appliedIds = new Map((r.applied || []).map(a => [a.uid, a]));
      for (const op of batch) {
        const ap = appliedIds.get(op.uid);
        if (ap && ap.id != null && op.localId && op.localId < 0) remapLocal(op, ap.id, ap.version);
        if (ap) pushed++;
      }
      const rejected = r.rejected || [];
      const conflicts = r.conflicts || [];
      if (rejected.length) {
        const dead = new Set(rejected.map(x => x.uid));
        S.queue = S.queue.filter(op => !dead.has(op.uid));
        toast(fa(rejected.length) + ' تغییر رد شد (دسترسی یا اعتبار)', 'err');
      } else {
        const done = new Set(batch.map(o => o.uid));
        S.queue = S.queue.filter(op => !done.has(op.uid));
      }
      if (conflicts.length) {
        for (const c of conflicts) {
          if (c.server) {
            if (!S.data[c.collection]) S.data[c.collection] = new Map();
            S.data[c.collection].set(Number(c.id), c.server);
          }
          S.queue = S.queue.filter(op => op.uid !== c.uid && !(op.collection === c.collection && c.id != null && Number(op.id) === Number(c.id)));
        }
        toast('تعارض در ' + fa(conflicts.length) + ' رکورد — نسخهٔ سرور اعمال شد', 'err');
      }
      saveQueue();
    }
    saveCache();
  } catch (e) {
    /* سرور در دسترس نیست: اگر روی گوشی هستیم، ثبت‌ها را مستقیم در
       صندوقچهٔ ابری می‌گذاریم تا اولین دستگاهِ روشن اعمالشان کند. */
    if (PHONE_MODE || BUNDLED) pushed += await pushQueueToOutbox();
  } finally {
    S.syncing = false;
  }
  return { pushed };
}

/* ── صف → صندوقچهٔ ابری (بدون سرور) ─────────────────────────────── */
async function pushQueueToOutbox() {
  if (!S.session && !(S.user && S.user.id)) return 0;
  if (!window.PayeshPhone) return 0;
  let sent = 0;
  for (const op of S.queue.slice()) {
    try {
      await window.PayeshPhone.send({
        uid: op.uid, user_id: S.user ? S.user.id : null, role: S.role || null,
        device_id: localStorage.getItem('payesh.device') || null, op,
      });
      S.queue = S.queue.filter(q => q.uid !== op.uid);
      sent++;
    } catch (e) {
      break; /* اینترنت نیست — صف دست‌نخورده می‌ماند */
    }
  }
  if (sent) { saveQueue(); saveCache(); }
  return sent;
}

function remapLocal(op, serverId, version) {
  const col = S.data[op.collection];
  if (!col) return;
  const row = col.get(op.localId);
  if (row) { col.delete(op.localId); row.id = serverId; row._version = version; col.set(serverId, row); }
  S.queue.forEach(q => {
    if (q.collection === op.collection && Number(q.id) === Number(op.localId)) q.id = serverId;
    if (q.data && Number(q.data.id) === Number(op.localId)) q.data.id = serverId;
  });
}

/* وضعیت صندوقچهٔ ابری — اگر اینترنت/ابر نبود، بی‌صدا نادیده گرفته می‌شود */
const SERVER_ROLES = ['manager', 'vice', 'teacher', 'staff'];
async function loadOutbox(silent = true) {
  if (!S.session || !S.online) return null;
  if (PHONE_MODE) {
    try {
      const pending = await window.PayeshPhone.pendingCount();
      S.outbox = { ok: true, phone: true, cloud: true, pending, last_drain: S.outbox && S.outbox.last_drain };
    } catch (e) { S.outbox = { ok: false, phone: true, pending: null }; }
    return S.outbox;
  }
  try {
    const r = await api('/api/outbox/state');
    S.outbox = r || {};
    if (SERVER_ROLES.includes(S.role) && (r.pending || 0) > 0) {
      const d = await api('/api/outbox/drain', { method: 'POST', body: {} });
      if (d && d.applied) {
        S.outbox = Object.assign({}, S.outbox, { pending: 0, last_drain: new Date().toISOString() });
        await pullAll();
        if (!silent) toast('ثبت‌های صندوقچه اعمال شد', 'ok');
      }
      const again = await api('/api/outbox/state').catch(() => null);
      if (again) S.outbox = again;
    }
    return S.outbox;
  } catch (e) { return null; }
}

async function syncNow(silent = true) {
  if (!S.online) { if (!silent) toast('اینترنت/شبکه در دسترس نیست — تغییرات در صف می‌مانند', 'err'); return; }
  if (PHONE_MODE) {
    await flushQueue();
    try {
      const data = await window.PayeshPhone.pullData(S.user);
      if (data && !data.missing) {
        for (const c of Object.keys(data.collections || {})) {
          const rows = data.collections[c] || [];
          if (!S.data[c]) S.data[c] = new Map();
          for (const r of rows) S.data[c].set(Number(r.id), r);
        }
        S.lastSync = data.at || S.lastSync;
        saveCache();
        if (!silent) toast('اطلاعات تازه شد', 'ok');
      } else if (!silent) toast('صندوقچهٔ ابری هنوز چیزی ندارد', 'err');
    } catch (e) { if (!silent) toast('به صندوقچه نرسیدیم', 'err'); }
    render();
    return;
  }
  try {
    await flushQueue();
    await pullAll();
    await loadOutbox(silent);
    if (!silent) toast('همگام‌سازی انجام شد', 'ok');
    render();
  } catch (e) {
    if (!silent) toast('همگام‌سازی ناموفق: ' + e.message, 'err');
  }
}

/* ══════════════════════════════════════════════════════════════════
   همگام‌سازی زنده — هر ۱ ثانیه، برای همه (مدیر، عوامل اجرایی، دبیر،
   دانش‌آموز، ولی) و روی همهٔ دستگاه‌ها.

   • هر تغییری که کاربر می‌دهد، همان لحظه به حافظهٔ مشترک می‌رود.
   • هر دستگاه هر ثانیه یک «مُهر» کوچک می‌خواند؛ اگر عوض شده باشد،
     همان لحظه دادهٔ تازه را می‌گیرد و صفحه را تازه می‌کند.
   • اگر دستگاه مقصد خاموش/آفلاین باشد، داده در حافظه می‌ماند و اولین
     ثانیه‌ای که آنلاین شود تحویلش می‌گیرد.
   ══════════════════════════════════════════════════════════════════ */
const LIVE_MS = 1000;
let liveTimer = null;
let liveBusy = false;
let liveServerRev = null;
const liveState = { at: null, changes: 0, error: null };

/* «فرزندان من» برای ولی — دادهٔ گوشی فقط فرزندان همان ولی را می‌آورد
   (data/person/<id>.json → children)، پس همان‌جا پیوند والد ساخته می‌شود
   تا همهٔ صفحه‌های ولی (خانه، مرخصی، پرونده) درست کار کنند. */
function applyChildren(children) {
  if (!Array.isArray(children) || !children.length) return false;
  const me = S.user && S.user.id != null ? Number(S.user.id) : null;
  if (me == null) return false;
  if (!S.data.users) S.data.users = new Map();
  if (!S.data.parent_links) S.data.parent_links = new Map();
  let changed = false;
  for (const child of children) {
    if (!child || child.id == null) continue;
    const id = Number(child.id);
    if (!S.data.users.has(id)) { S.data.users.set(id, Object.assign({ role: 'student' }, child)); changed = true; }
    const linkId = -(id);   /* شناسهٔ محلی پایدار و منفی: با سرور تعارض ندارد */
    if (!S.data.parent_links.has(linkId)) {
      S.data.parent_links.set(linkId, { id: linkId, parent_id: me, student_id: id, _local: true });
      changed = true;
    }
  }
  return changed;
}

function applyPulled(data) {
  if (!data || data.missing) return false;
  let changed = false;
  for (const c of Object.keys(data.collections || {})) {
    if (!S.data[c]) S.data[c] = new Map();
    for (const r of data.collections[c] || []) {
      const id = Number(r.id);
      const prev = S.data[c].get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(r)) changed = true;
      S.data[c].set(id, r);
    }
  }
  if (data.school) {
    S.server.school = data.school;
    S.data.schools = new Map([[1, Object.assign({ id: 1 }, data.school)]]);
  }
  if (data.me && S.user) S.user = Object.assign({}, S.user, data.me);
  if (applyChildren(data.children)) changed = true;
  if (data.at) S.lastSync = data.at;
  return changed;
}

async function liveTick() {
  if (liveBusy) return;
  if (!S.user || !S.role) return;
  if (typeof document !== 'undefined' && document.hidden) return;  /* صفحه در پس‌زمینه: بی‌دلیل باتری/داده نسوزد */
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  liveBusy = true;
  try {
    /* ۱) ثبت‌های خودمان بی‌درنگ بروند */
    if (S.queue.length) await flushQueue();

    if (PHONE_MODE) {
      const r = await window.PayeshPhone.readRev();
      if (!r || !r.ok) { liveState.error = (r && r.error) || 'net'; return; }
      const seenRev = localStorage.getItem('payesh.live.rev') || '';
      const seenCore = localStorage.getItem('payesh.live.core') || '';
      const seenPersons = localStorage.getItem('payesh.live.persons') || '';
      const first = !seenRev;
      const coreChanged = !!r.core && r.core !== seenCore;
      const personsChanged = !!r.persons && r.persons !== seenPersons;
      if (r.rev && (r.rev !== seenRev)) {
        localStorage.setItem('payesh.live.rev', r.rev);
        if (first || coreChanged || personsChanged) {
          if (r.core) localStorage.setItem('payesh.live.core', r.core);
          if (r.persons) localStorage.setItem('payesh.live.persons', r.persons);
          const data = await window.PayeshPhone.pullData(S.user);
          if (applyPulled(data)) {
            liveState.changes++;
            saveCache();
            render();
            if (!first) toast('اطلاعات تازه شد', 'ok');
          } else if (data && !data.missing) saveCache();
        } else {
          render();
        }
      }
      liveState.at = new Date().toISOString();
      liveState.error = null;
    } else {
      /* روی سیستم مدرسه: سرور خودش هر ثانیه با حافظه حرف می‌زند؛
         ما هم هر ثانیه از سرور می‌پرسیم آیا چیزی عوض شده */
      const r = await api('/api/live/rev', { noAuthRedirect: true });
      if (!r || !r.ok) return;
      if (liveServerRev === null) { liveServerRev = r.rev; }
      else if (r.rev !== liveServerRev) {
        liveServerRev = r.rev;
        await pullAll();
        await loadOutbox(true).catch(() => {});
        saveCache();
        render();
        liveState.changes++;
      }
      liveState.at = new Date().toISOString();
      liveState.error = null;
    }
  } catch (e) {
    liveState.error = String((e && e.message) || e).slice(0, 120);
  } finally {
    liveBusy = false;
  }
}

function startLive() {
  if (liveTimer) return;
  liveTimer = setInterval(() => { liveTick().catch(() => {}); }, LIVE_MS);
  setTimeout(() => { liveTick().catch(() => {}); }, 400);
}
function stopLive() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }
function liveKick() { setTimeout(() => { liveTick().catch(() => {}); }, 0); }

/* ── نوشتن محلی + صف ───────────────────────────────────────────── */
function putLocal(collection, row, { sync = true } = {}) {
  if (!S.data[collection]) S.data[collection] = new Map();
  let id = Number(row.id);
  if (!id) { id = S.tempId--; row.id = id; row._version = 0; }
  const existing = S.data[collection].get(id);
  row._version = existing ? existing._version : (row._version || 0);
  S.data[collection].set(id, row);
  if (sync) {
    S.queue.push({
      uid: uid(), collection, type: 'put', id: id > 0 ? id : undefined,
      localId: id < 0 ? id : undefined, data: Object.assign({}, row), base_version: row._version || 0,
      at: new Date().toISOString(),
    });
    saveQueue();
    liveKick();
  }
  return row;
}
function removeLocal(collection, id, { sync = true } = {}) {
  const m = S.data[collection];
  if (m) m.delete(Number(id));
  /* هر عملیاتِ در انتظار برای همین ردیف هم باید برود؛ وگرنه ردیفی که
     آفلاین ساخته و بعد حذف شده، با اولین همگام‌سازی برمی‌گردد. */
  const numId = Number(id);
  try {
    if (Array.isArray(S.queue) && S.queue.length) {
      const before = S.queue.length;
      S.queue = S.queue.filter(op => !(op.collection === collection && (Number(op.id) === numId || Number(op.localId) === numId)));
      if (S.queue.length !== before) saveQueue();
    }
  } catch (e) { /* بی‌صدا */ }
  if (sync && numId > 0) {
    S.queue.push({ uid: uid(), collection, type: 'del', id: numId, at: new Date().toISOString() });
    saveQueue();
    liveKick();
  }
  return true;
}

/* ── حذف کاربر: در همه حالت‌ها کار می‌کند ─────────────────────────────
   اگر سیستم مدرسه هست، مستقیم حذف می‌شود؛ اگر نبود یا پاسخ نداد، از مسیر
   صف (که همهٔ نسخه‌ها دارند) حذف می‌شود و روی گوشی هم فقط محلی پاک
   می‌شود. هیچ‌وقت «حذف نشد» به کاربر نشان نمی‌دهیم. */
async function deleteUserEverywhere(id) {
  const nid = Number(id);
  if (!PHONE_MODE) {
    try { await api('/api/admin/users/' + nid, { method: 'DELETE' }); }
    catch (e) { /* مسیر صف جایگزین است */ }
  }
  removeLocal('users', nid);
  if (S.data && S.data.users) S.data.users.delete(nid);
  return true;
}

/* ارقام فارسی/عربی و فاصله‌ها را به رقم انگلیسی تبدیل می‌کند
   (باگ مهم: PIN با ارقام فارسی ذخیره نمی‌شد و راه‌اندازی تکرار می‌شد) */
function digitsOnly(v) {
  return String(v == null ? '' : v)
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\d]/g, '');
}

/* ── کاربر و نشست ───────────────────────────────────────────────── */
function saveSession(token) { S.session = token; localStorage.setItem('payesh.session', token); }
function saveDevice(token) { S.deviceToken = token; localStorage.setItem('payesh.device', token); }

function lockApp() {
  S.session = ''; localStorage.removeItem('payesh.session');
  S.user = null; S.role = null;
  stopLive();
  renderLock();
}

async function doSetup(form) {
  const pass = String(form.password.value || '');
  const pass2 = String(form.password2.value || '');
  const body = {
    school_name: form.school_name.value.trim(),
    manager_name: form.manager_name.value.trim(),
    phone: digitsOnly(form.phone.value),
    pin: digitsOnly(form.pin.value) || '',
    password: pass,
    school_type: form.school_type.value,
    school_year: form.school_year.value.trim(),
  };
  if (body.phone.length !== 11) return toast('شمارهٔ همراه باید ۱۱ رقم باشد', 'err');
  if (pass.length < 4) return toast('رمز عبور حداقل ۴ نویسه باشد', 'err');
  if (pass !== pass2) return toast('رمز عبور و تکرارش یکی نیست', 'err');
  if (body.pin && !/^\d{4,6}$/.test(body.pin)) return toast('PIN باید ۴ تا ۶ رقم باشد', 'err');
  try {
    const r = await api('/api/setup', { method: 'POST', body });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    localStorage.setItem('payesh.authmode', body.pin ? 'pin' : 'password');
    localStorage.setItem('payesh.lastname', body.manager_name);
    S.user = r.user; S.role = r.user.role;
    toast('مدرسه ساخته شد — از این پس با شمارهٔ همراه و رمز عبور وارد می‌شوید', 'ok');
    await start();
  } catch (e) { toast('راه‌اندازی ناموفق: ' + e.message, 'err'); }
}

/* نجاتِ مدیر روی خودِ رایانهٔ مدرسه: ساختن شماره + رمز وقتی حساب مدیر رمز ندارد */
async function doClaim(form) {
  if (!form) return;
  const phone = digitsOnly(form.phone.value);
  const password = String(form.password.value || '');
  if (phone.length !== 11) return toast('شمارهٔ همراه باید ۱۱ رقم باشد', 'err');
  if (password.length < 4) return toast('رمز عبور حداقل ۴ نویسه باشد', 'err');
  try {
    const r = await api('/api/auth/claim', { method: 'POST', body: { phone, password } });
    if (r.device_token) saveDevice(r.device_token);
    if (r.session && r.session.token) saveSession(r.session.token);
    localStorage.setItem('payesh.authmode', 'password');
    localStorage.setItem('payesh.lastname', (r.user && r.user.name) || '');
    S.user = r.user || S.user; S.role = (r.user && r.user.role) || S.role;
    toast('رمز ساخته شد');
    await start();
  } catch (e) {
    toast(/local_only/.test(e.message) ? 'این کار فقط از رایانهٔ خود مدرسه ممکن است' : 'ثبت نشد: ' + e.message, 'err');
  }
}

async function doLogin(form) {
  const phone = digitsOnly(form.phone.value);
  const password = String(form.password.value || '');
  if (phone.length !== 11) return toast('شمارهٔ همراه باید ۱۱ رقم باشد', 'err');
  if (!password) return toast('رمز عبور را وارد کنید', 'err');
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { phone, password, platform: 'web' } });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    localStorage.setItem('payesh.authmode', 'password');
    localStorage.setItem('payesh.lastname', (r.user && r.user.name) || '');
    S.user = r.user; S.role = r.user.role;
    await start();
  } catch (e) {
    const em = String((e && e.message) || '');
    if (/no_password/.test(em)) return toast('این حساب هنوز رمز ندارد — مدیر باید از «کاربران ← ویرایش» یک رمز بسازد', 'err');
    if (/bad_credentials/.test(em)) return toast('شماره یا رمز عبور درست نیست', 'err');
    toast('ورود ناموفق: ' + em, 'err');
  }
}

/* ── ورود بدون سرور: همان شماره+رمزی که مدیر تعریف کرده ───────────── */
/* نسخهٔ قابل‌بررسی رمز (PBKDF2) — روی گوشی ساخته می‌شود و همان روی سرور
   به‌عنوان رمز ذخیره می‌شود؛ پس رمز هیچ‌جا به‌صورت متن نمی‌ماند. */
function makeVerifier(plain) {
  const iter = 150000;
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = window.PayeshHash.hex(window.PayeshHash.pbkdf2(String(plain), salt, iter, 32));
  return 'pbkdf2$' + iter + '$' + salt + '$' + hash;
}

async function doPhoneLogin(f) {
  const phone = digitsOnly(f.phone.value);
  const password = String(f.password.value || '');
  if (phone.length !== 11) return toast('شمارهٔ همراه باید ۱۱ رقم باشد', 'err');
  if (!password) return toast('رمز عبور را وارد کنید', 'err');
  const el = f.password;
  const form = (el && el.closest && el.closest('form')) || null;
  const btn = form ? form.querySelector('button[type="submit"]') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'در حال بررسی…'; }
  try {
    /* اگر سیستم مدرسه در دسترس باشد (شبکهٔ مدرسه یا آدرس عمومی)، نشانی
       حافظه را از آن یاد می‌گیریم و نگه می‌داریم؛ بعد در خانه هم کار می‌کند. */
    const learnBase = API_BASE || (/^https?:/.test(location.protocol) ? location.origin : '');
    if (learnBase) {
      await Promise.race([
        window.PayeshPhone.learnFromServer(learnBase),
        new Promise(res => setTimeout(res, 2500)),
      ]);
    }
    const r = await window.PayeshPhone.login(phone, password);
    if (!r.ok) {
      const map = {
        bad_credentials: 'شماره یا رمز عبور درست نیست',
        no_password: 'این حساب هنوز رمز ندارد — از مدیر بخواهید رمز بسازد',
        not_registered: 'این شماره در مدرسه ثبت نشده — از مدیر بخواهید حساب بسازد (و یک‌بار با سیستم مدرسه همگام شود)',
        user_inactive: 'حساب غیرفعال است',
        bad_phone: 'شمارهٔ همراه کامل نیست',
        bad_password: 'رمز عبور خیلی کوتاه است',
        net: 'به حافظهٔ مدرسه نرسیدیم — اینترنت گوشی را بررسی کنید و دوباره بزنید',
        cors: 'حافظهٔ مدرسه هنوز اجازهٔ خواندن به برنامه نداده — یک‌بار در سیستم مدرسه، «حافظهٔ ابری ← تنظیم خودکار CORS» را بزنید',
        denied: 'دسترسی به حافظهٔ مدرسه باز نیست — در سیستم مدرسه «حافظهٔ ابری ← تنظیم خودکار CORS» را بزنید',
        no_bucket: 'حافظهٔ مدرسه هنوز ساخته نشده — یک‌بار با سیستم مدرسه همگام شوید',
        no_config: 'برنامه بدون تنظیم حافظه ساخته شده — نسخهٔ تازه را نصب کنید',
      };
      toast(map[r.error] || ('ورود ناموفق: ' + r.error), 'err');
      /* اگر به حافظه نرسیدیم، همان‌جا خودمان بررسی می‌کنیم و می‌گوییم کجا گیر است */
      if (r.error === 'net' || r.error === 'cors' || r.error === 'denied') {
        const box = document.getElementById('diag-out');
        if (box) {
          box.innerHTML = '<div class="muted">در حال بررسی اتصال…</div>';
          try {
            const steps = await window.PayeshPhone.diagnose(phone);
            box.innerHTML = steps.map(st => `<div>${st.ok ? '✅' : '❌'} ${st.text}${st.detail ? ' — <span class="ltr small">' + String(st.detail).replace(/[<>&]/g, '') + '</span>' : ''}</div>`).join('');
          } catch (e) { box.innerHTML = ''; }
        }
      }
      return;
    }
    await enterPhone(r.user);
  } catch (e) {
    toast('ورود ناموفق: ' + (e.message || e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'ورود'; }
  }
}

/* بالا آوردن کل برنامه از دادهٔ صندوقچه، با نقشِ همان کاربر */
async function enterPhone(user) {
  PHONE_MODE = true;
  S.server = Object.assign({}, S.server, { version: CLIENT_VERSION });
  S.session = 'phone';            /* نشست محلی؛ هیچ سروری در کار نیست */
  S.user = user; S.role = user.role;
  S.offline = true;
  S.boot = Object.assign({}, S.boot || {}, { user, role: user.role });
  S.creds = {};   /* روی گوشی رمزها نمایش داده نمی‌شوند */
  S.server = Object.assign({}, S.server, { ok: false, offline: true, setupDone: true, school: S.server.school || null });
  toast('در حال آوردن اطلاعات…');
  let data = null;
  try { data = await window.PayeshPhone.pullData(user); } catch (e) { data = null; }
  if (data) {
    S.data = {};
    for (const c of Object.keys(data.collections || {})) {
      S.data[c] = new Map((data.collections[c] || []).map(r => [Number(r.id), r]));
    }
    if (data.school) {
      S.server.school = data.school;
      S.data.schools = new Map([[1, Object.assign({ id: 1 }, data.school)]]);
    }
    /* ولی: فرزندانش از پروندهٔ خودش ساخته می‌شوند (نه از جدول parent_links
       که روی گوشی وجود ندارد) */
    if (data.me) S.user = Object.assign({}, S.user, data.me);
    applyChildren(data.children);
    S.lastSync = data.at || null;
    saveCache();
  } else {
    const cached = await idbGet('data');
    if (cached) {
      S.data = {};
      for (const c of Object.keys(cached)) S.data[c] = new Map((cached[c] || []).map(r => [Number(r.id), r]));
    }
  }
  try { localStorage.setItem('payesh.lastuser', JSON.stringify({ user, role: user.role, version: CLIENT_VERSION, school: S.server.school })); } catch (e) { /* noop */ }
  routeFromHash();
  render();
  scheduleSync();
  startLive();                   /* هر ۱ ثانیه از حافظهٔ مشترک تازه‌سازی */
  toast('خوش آمدید ' + (user.name || ''), 'ok');
}

async function doPair(form) {
  const code = form.code.value.trim();
  const pin = digitsOnly(form.pin.value);
  if (!/^\d{4,6}$/.test(pin)) return toast('PIN باید ۴ تا ۶ رقم باشد', 'err');
  try {
    const r = await api('/api/auth/pair', { method: 'POST', body: { code, pin, platform: platformName(), name: deviceName() } });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    await start();
  } catch (e) {
    const map = { bad_code: 'کد پیوند نامعتبر است', code_used: 'این کد قبلاً استفاده شده', code_expired: 'کد منقضی شده — از مدیر کد تازه بگیرید', bad_pin: 'PIN نامعتبر', user_inactive: 'حساب غیرفعال است' };
    toast(map[e.message] || 'ورود ناموفق: ' + e.message, 'err');
  }
}

async function doTransfer(form) {
  const code = form.code.value.trim();
  const pin = digitsOnly(form.pin.value);
  if (!/^\d{4,6}$/.test(pin)) return toast('PIN باید ۴ تا ۶ رقم باشد', 'err');
  try {
    const r = await api('/api/auth/transfer/redeem', { method: 'POST', body: { code, pin, platform: platformName(), name: deviceName() } });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    go('home');
    await start();
  } catch (e) {
    const map = { bad_code: 'کد انتقال نامعتبر است', code_used: 'این کد قبلاً استفاده شده', code_expired: 'کد انتقال منقضی شده', bad_pin: 'PIN نامعتبر' };
    toast(map[e.message] || 'انتقال ناموفق: ' + e.message, 'err');
  }
}

async function doUnlock(form) {
  const usePw = form.password !== undefined;
  const body = { device_token: S.deviceToken };
  if (usePw) body.password = String(form.password.value || '');
  else body.pin = digitsOnly(form.pin.value);
  try {
    const r = await api('/api/auth/unlock', { method: 'POST', body });
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    await start();
  } catch (e) {
    if (e.message === 'device_unknown' || e.message === 'user_inactive' || e.message === 'bad_device') {
      localStorage.removeItem('payesh.device');
      S.deviceToken = '';
      toast('این دستگاه ثبت نشده — دوباره وارد شوید', 'err');
      renderPair();
      return;
    }
    if (e.message === 'no_password') {
      S.unlockMode = 'pin'; toast('برای این حساب رمز عبور تنظیم نشده — با PIN وارد شوید', 'err');
      renderLock(); return;
    }
    if (e.message === 'locked') { toast('چند بار اشتباه زدید — ۱۰ دقیقه صبر کنید', 'err'); return; }
    toast(usePw ? 'رمز عبور نادرست است' : 'PIN نادرست است', 'err');
    const inp = form.password || form.pin;
    if (inp) { inp.value = ''; inp.focus(); }
  }
}

function platformName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'web';
}
function deviceName() {
  const p = platformName();
  return p === 'ios' ? 'آیفون/آیپد' : p === 'android' ? 'گوشی اندروید' : 'مرورگر';
}

/* ── شروع ───────────────────────────────────────────────────────── */
/* ── گزارش تغییرات: فقط یک‌بار برای هر نسخه ─────────────────────────── */
async function maybeShowReleaseNotes() {
  try {
    const info = (S.boot && S.boot.update) || null;
    if (!info || !info.version) return;
    const notes = Array.isArray(info.notes) ? info.notes : [];
    if (!notes.length) return;
    const key = 'payesh.notes.' + info.version;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    const body = `<div class="small muted" style="margin-bottom:8px">نسخهٔ <b>${esc(info.version)}</b> نصب شد (${esc(jdate(info.at))}) — چه چیزی تازه شد:</div>
      <ul class="small" style="line-height:2;padding-inline-start:18px">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
      <button class="btn primary block" data-act="modal-close" style="margin-top:10px">باشه، متوجه شدم</button>`;
    S.modalTitle = 'تازه‌های برنامه';
    modal(body);
  } catch (e) { /* بی‌اهمیت */ }
}

async function start() {
  try {
    const boot = await api('/api/bootstrap');
    S.boot = boot; S.user = boot.user; S.role = boot.role;
    S.server = Object.assign({}, S.server, {
      ok: true, version: boot.version, school: boot.school, setupDone: true,
      publicUrl: boot.public_url || S.server.publicUrl || null,
    });
    S.clockOffset = new Date(boot.server_time).getTime() - Date.now();
    try { localStorage.setItem('payesh.lastuser', JSON.stringify({ user: boot.user, role: boot.role, version: boot.version, school: boot.school })); } catch (e) { /* noop */ }
    const cached = await idbGet('data');
    if (cached) {
      S.data = {};
      for (const c of Object.keys(cached)) S.data[c] = new Map(cached[c].map(r => [Number(r.id), r]));
    }
    /* پیکربندی صندوقچه را روی همین دستگاه نگه می‌داریم: اگر روزی سیستم مدرسه خاموش بود،
       همین گوشی می‌تواند مستقیم روی صندوقچه بنویسد (بدون این‌که کسی کلیدی تایپ کند). */
    api('/api/cloud/config').then(r => {
      if (r && r.ready && r.config) { try { localStorage.setItem('payesh.cloudcfg', JSON.stringify(r.config)); } catch (e) { /* noop */ } }
    }).catch(() => { /* بی‌اهمیت */ });
    try { await pullAll(); await flushQueue(); S.offline = false; }
    catch (e) { /* آفلاین: با کش ادامه می‌دهیم */ S.offline = true; }
    routeFromHash();
    render();
    scheduleSync();
    startLive();                 /* هر ۱ ثانیه با حافظه هم‌گام شو */
    checkUpdate(true);
    maybeShowReleaseNotes();
    maybeFixPhoneAccess();
    if (S.role === 'manager') loadRemoteUpdate(false).then(() => { updateTopChrome(); if (S.remote && S.remote.available) render(); });
  } catch (e) {
    toast('اتصال به سرور برقرار نشد: ' + e.message, 'err');
    renderLock();
  }
}

let syncTimer = null, updateTimer = null, remoteTimer = null;
function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (S.online && S.session) syncNow(true); }, 90_000);
  /* بررسی دوره‌ای آپدیت — سبک و بی‌صدا */
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => { if (S.online) checkUpdate(true); }, 5 * 60_000);
  /* نسخهٔ منتشرشده در مخزن را هم دوره‌ای ببین (فقط مدیر) */
  if (remoteTimer) clearInterval(remoteTimer);
  remoteTimer = setInterval(() => {
    if (S.online && S.role === 'manager' && !S.remoteBusy) loadRemoteUpdate(false).then(() => updateTopChrome());
  }, 20 * 60_000);
}
window.addEventListener('online', () => { S.online = true; syncNow(true); if (S.session) checkUpdate(true); render(); });
window.addEventListener('offline', () => { S.online = false; render(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.session) return;
  syncNow(true);
  checkUpdate(true);          /* هر بار که کاربر برمی‌گردد: نسخه چک می‌شود */
  if (S.role === 'manager' && !S.remoteBusy && !$('#upd-overlay')) {
    loadRemoteUpdate(false).then(() => updateTopChrome());
  }
});

/* ── مسیریابی ───────────────────────────────────────────────────── */
function hashParts() {
  const h = String(location.hash || '#/home').replace(/^#\/?/, '');
  const [r, ...rest] = h.split('/');
  return { route: r || 'home', params: rest };
}
function routeFromHash() {
  const { route, params } = hashParts();
  S.route = route; S.params = params;
}
function go(route) { location.hash = '#/' + route; }
window.addEventListener('hashchange', async () => {
  routeFromHash();
  render();
  window.scrollTo(0, 0);
  if (S.route === 'network' && S.role === 'manager') { await loadNetwork(false); render(); }
});

/* ── وضعیت شبکه/تونل (فقط مدیر) ─────────────────────────────────── */
async function loadNetwork(force) {
  if (PHONE_MODE) { S.network = { phone: true, lan_urls: [], public: {} }; return S.network; }
  try {
    const r = await api('/api/admin/network' + (force ? '?force=1' : ''), { noAuthRedirect: true });
    S.network = r;
    if (r.public_url) S.server.publicUrl = r.public_url;
    return r;
  } catch (e) {
    S.network = S.network || {};
    return null;
  }
}

/* ── رندر ───────────────────────────────────────────────────────── */

/* ── حفظ فوکوس و صفحه‌کلید هنگام بازسازی صفحه ─────────────────────────
   روی گوشی، اگر کادرِ در حال تایپ از DOM برداشته شود، صفحه‌کلید بسته می‌شود
   و کاربر باید برای هر رقم دوباره روی کادر بزند. پس هر بار که صفحه بازسازی
   می‌شود: کادرِ فعال و جای نشانگر را نگه می‌داریم و بعد برمی‌گردانیم. */
function focusSnapshot() {
  const el = document.activeElement;
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;
  const key = el.getAttribute('name') || el.getAttribute('data-focus-key') || el.id || '';
  if (!key) return null;
  const form = el.form && el.form.getAttribute ? (el.form.getAttribute('data-form') || '') : '';
  let start = null, end = null;
  try { start = el.selectionStart; end = el.selectionEnd; } catch (e) { /* بعضی کادرها ندارند */ }
  return { key, form, start, end, value: el.value };
}

function focusRestore(snap) {
  if (!snap) return;
  let el = null;
  const scope = snap.form ? document.querySelector('form[data-form="' + snap.form + '"]') : document;
  if (scope && scope.elements) {
    el = scope.elements[snap.key] || null;
  }
  if (!el && document.querySelector) {
    const all = document.querySelectorAll('input, textarea, select');
    for (const cand of all) {
      if (cand.getAttribute('name') === snap.key) { el = cand; break; }
    }
  }
  if (!el || typeof el.focus !== 'function') return;
  try {
    if (el.value !== snap.value) el.value = snap.value;
    el.focus({ preventScroll: true });
    if (snap.start != null && el.setSelectionRange) el.setSelectionRange(snap.start, snap.end);
  } catch (e) { /* بی‌صدا */ }
}

/* جایگزینی محتوای صفحه با نگه‌داشتن فوکوس/صفحه‌کلید */
function paintApp(html) {
  const root = $('#app');
  if (!root) return;
  const snap = focusSnapshot();
  root.innerHTML = html;
  if (snap) focusRestore(snap);
}

function render() {
  const root = $('#app');
  if (!root) return;
  if (!S.session || !S.user) return;
  const page = (window.PAGES && window.PAGES[S.route]) || null;
  const view = page ? page(S.params) : `<div class="card"><h3>صفحه پیدا نشد</h3><p class="muted">مسیر «${esc(S.route)}» وجود ندارد.</p></div>`;
  paintApp(shellHtml(view));
  /* بارگذاری تنبل وضعیت شبکه در صفحهٔ «شبکه» */
  if (S.route === 'network' && S.role === 'manager' && !S.network && !S._netLoading) {
    S._netLoading = true;
    loadNetwork(false).then(() => { S._netLoading = false; if (S.route === 'network') render(); });
  }
  if (S.route === 'users' && S.role === 'manager' && S.creds === undefined && !S._credsLoading && !PHONE_MODE) {
    S._credsLoading = true;
    api('/api/admin/users/credentials')
      .then(r => {
        const m = {};
        (r.users || []).forEach(u => { m[u.id] = u; });
        S.creds = m;
      })
      .catch(() => { S.creds = {}; })
      .then(() => { S._credsLoading = false; render(); });
  }

  if (S.route === 'cloud' && S.role === 'manager' && S.cloud === undefined && !S._cloudLoading) {
    S._cloudLoading = true;
    loadCloud().then(() => { S._cloudLoading = false; if (S.route === 'cloud') render(); });
  }
  updateTopChrome();
}


/* ── حافظهٔ ابری ────────────────────────────────────────────────── */
async function loadCloud() {
  if (PHONE_MODE) { S.cloud = { phone: true }; return S.cloud; }
  try { const r = await api('/api/admin/cloud'); S.cloud = r.config; }
  catch (e) { S.cloud = { configured: false }; toast('خواندن تنظیمات حافظهٔ ابری ناموفق: ' + e.message, 'err'); }
}
function cloudForm() {
  /* فقط فیلدهای پرشده فرستاده می‌شوند تا مقادیر فعلی/پیش‌فرض پاک نشوند */
  const v = id => (($('#' + id) || {}).value || '').trim();
  const map = [['endpoint', 'cl-endpoint'], ['bucket', 'cl-bucket'], ['region', 'cl-region'], ['accessKey', 'cl-access'], ['secret', 'cl-secret']];
  const out = {};
  for (const [k, id] of map) { const val = v(id); if (val) out[k] = val; }
  return out;
}
function cloudStepsHtml(r) {
  const rows = (r.steps || []).map(s => `<div class="row" style="gap:8px;align-items:center;margin-top:4px">
    <span>${s.ok ? '✅' : '⛔'}</span><span>${esc(s.name)}</span>
    ${s.ms ? `<span class="muted">${fa(s.ms)}ms</span>` : ''}
    ${s.note ? `<span class="muted">— ${esc(s.note)}</span>` : ''}</div>`).join('');
  const head = r.ok
    ? `<b style="color:#15803d">حافظهٔ ابری سالم است</b> <span class="muted">(${fa(r.ms)}ms)</span>`
    : `<b style="color:#b91c1c">وصل نشد</b> <span class="muted">${esc(r.error || '')}</span>`;
  return head + rows;
}

/* ── آپدیت ──────────────────────────────────────────────────────── */
/* نسخهٔ نصب‌شده روی همین دستگاه را از سرویس‌ورکر می‌پرسیم
   (نه از سرور — وگرنه بعد از آپدیت سرور، کلاینت کهنه هرگز آپدیت نمی‌بیند) */
function swAsk(msg, timeout = 1200) {
  return new Promise(resolve => {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.controller) return resolve(null);
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => resolve(e.data || null);
      sw.controller.postMessage(msg, [ch.port2]);
      setTimeout(() => resolve(null), timeout);
    } catch (e) { resolve(null); }
  });
}

async function checkUpdate(silent = false) {
  if (!navigator.serviceWorker) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
    const v = await swAsk({ type: 'GET_VERSION' });
    const current = (v && v.version) || S.server.version || '0.0.0';
    const r = await api('/api/update/check?current=' + encodeURIComponent(current), { noAuthRedirect: true });
    S.update = r.up_to_date ? null : r;
    if (!silent && !r.up_to_date) toast('نسخهٔ جدید آماده است — از «سیستم» به‌روزرسانی کنید', 'ok');
    const bar = $('#update-bar');
    if (bar) bar.outerHTML = updateBarHtml();
    return r;
  } catch (e) { return null; }
}

async function applyUpdate() {
  if (!navigator.serviceWorker) { location.reload(); return; }
  toast('در حال دریافت تغییرات…');
  S.wantReload = true;
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg && reg.active) reg.active.postMessage({ type: 'CHECK_UPDATE', reload: true });
  /* اگر سرویس‌ورکر پاسخ نداد، حداکثر پس از ۱۲ ثانیه بازخوانی کن */
  setTimeout(() => { if (S.wantReload) location.reload(); }, 12000);
}

/* ── به‌روزرسانی درجا (فقط مدیر) ───────────────────────────────────
   خود سرور مدرسه نسخهٔ منتشرشده را می‌بیند و فقط فایل‌های تغییرکرده را
   می‌گیرد؛ کلاینت هم کش خودش را با دلتا تازه می‌کند. */
async function loadRemoteUpdate(force = false) {
  if (S.role !== 'manager') { S.remote = null; return null; }
  try {
    S.remoteBusy = true;
    const r = force
      ? (await api('/api/admin/update/check', { method: 'POST', body: { force: true } })).plan
      : null;
    const info = force ? null : await api('/api/admin/update');
    const plan = r || (info && info.plan) || null;
    S.remote = Object.assign({}, plan || { ok: false, error: 'unavailable' }, {
      last: (info && info.last) || (S.remote && S.remote.last) || null,
      auto: info ? info.auto : (S.remote && S.remote.auto),
      auto_apply: info ? info.auto_apply : (S.remote && S.remote.auto_apply),
      base: info ? info.base : (S.remote && S.remote.base),
      bases: (info && info.bases) || (S.remote && S.remote.bases) || [],
    });
    if (S.remote && S.remote.available && !force) {
      toast('نسخهٔ ' + fa(S.remote.remote_version) + ' منتشر شده — فقط فایل‌های تغییرکرده', 'ok');
    }
    updateTopChrome();
    return S.remote;
  } catch (e) {
    S.remote = Object.assign({}, S.remote || {}, { ok: false, error: e.message });
    return S.remote;
  } finally { S.remoteBusy = false; }
}

function updateOverlay(text, sub) {
  let el = $('#upd-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'upd-overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)';
    document.body.appendChild(el);
  }
  el.innerHTML = '<div class="card" style="max-width:420px;text-align:center">' +
    '<div style="font-size:34px;margin-bottom:6px">🔄</div>' +
    '<div style="font-weight:700;font-size:1.05rem">' + esc(text) + '</div>' +
    '<div class="small muted" style="margin-top:8px">' + esc(sub || '') + '</div>' +
    '<div style="width:22px;height:22px;border:3px solid rgba(99,102,241,.22);border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite;margin:14px auto 0"></div></div>';
  return el;
}
function hideUpdateOverlay() { const el = $('#upd-overlay'); if (el) el.remove(); }

async function waitForRestart(previousVersion, version) {
  const started = Date.now();
  /* تا سه دقیقه صبر می‌کنیم؛ راه‌انداز خودکار (ناظر) سرور را برمی‌گرداند.
     هیچ‌وقت به کاربر نمی‌گوییم «برنامه را ببندید». */
  while (Date.now() - started < 180_000) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const h = await fetch(apiUrl('/api/health'), { cache: 'no-store' }).then(r => r.json());
      const sameProcess = h.version === previousVersion;
      if (!sameProcess || (h.installed_version && h.installed_version === version && !h.restart_pending)) {
        updateOverlay('نسخهٔ ' + fa(h.version) + ' فعال شد', 'در حال بازخوانی برنامه…');
        await new Promise(r => setTimeout(r, 600));
        location.reload();
        return;
      }
    } catch (e) {
      /* سرور در حال بالا آمدن است — ادامه می‌دهیم */
      const secs = Math.round((Date.now() - started) / 1000);
      updateOverlay('نسخهٔ ' + fa(version) + ' نصب شد', 'برنامهٔ مدرسه دوباره راه می‌افتد… (' + fa(secs) + ' ثانیه)');
    }
  }
  /* خودکار برنگشت: خودمان یک‌بار تلاش می‌کنیم، بعد دکمهٔ تلاش دوباره */
  try { await fetch(apiUrl('/api/admin/update/restart'), { method: 'POST', headers: { authorization: 'Bearer ' + S.session } }); } catch (e) { /* noop */ }
  updateOverlay('در حال آماده کردن نسخهٔ تازه', 'اگر بیشتر طول کشید، «تلاش دوباره» را بزنید — نیازی به بستن برنامه نیست.');
  const ov = $('#upd-overlay');
  if (ov && !ov.querySelector('[data-act="upd-retry"]')) {
    const card = ov.querySelector('.card') || ov;
    const b = document.createElement('button');
    b.className = 'btn primary block';
    b.setAttribute('data-act', 'upd-retry');
    b.style.marginTop = '12px';
    b.textContent = 'تلاش دوباره';
    card.appendChild(b);
  }
}

async function applyRemoteUpdate() {
  if (S.role !== 'manager') { toast('فقط مدیر سیستم می‌تواند به‌روزرسانی کند', 'err'); return; }
  if (S.remoteBusy) return;
  const prev = (S.server && S.server.version) || '0.0.0';
  S.remoteBusy = true;
  toast('در حال گرفتن فقط فایل‌های تغییرکرده…');
  updateOverlay('در حال دریافت تغییرات', 'فقط بخش‌هایی که عوض شده‌اند دانلود می‌شوند');
  try {
    const r = await api('/api/admin/update/apply', { method: 'POST', body: {} });
    if (!r.ok) throw new Error(r.detail || r.error || 'خطا');
    if (!r.applied) {
      hideUpdateOverlay(); S.remoteBusy = false;
      toast('برنامه همین حالا به‌روز است', 'ok');
      await loadRemoteUpdate(true); render(); return;
    }
    const kb = Math.max(1, Math.round((r.bytes || 0) / 1024));
    try { localStorage.removeItem('payesh.upd.dismiss'); } catch (e) { /* noop */ }
    toast('نسخهٔ ' + fa(r.version) + ' نصب شد — ' + fa(r.files) + ' فایل، ' + fa(kb) + ' کیلوبایت', 'ok');
    if (r.restart) {
      updateOverlay('نسخهٔ ' + fa(r.version) + ' نصب شد', 'برنامهٔ مدرسه دوباره راه می‌افتد؛ چند لحظه…');
      await waitForRestart(prev, r.version);
      return;
    }
    S.remoteBusy = false;
    hideUpdateOverlay();
    await refreshClientCache();
  } catch (e) {
    S.remoteBusy = false; hideUpdateOverlay();
    const msg = String(e.message || '');
    const fa2 = /needs_admin/.test(msg)
      ? 'این آپدیت کدِ سرور را عوض می‌کند و پوشهٔ نصب محافظت‌شده است — یک‌بار نصب‌کنندهٔ تازه را اجرا کنید؛ از آن پس آپدیت‌ها خودکار می‌شوند.'
      : /EACCES|EPERM|apply_failed/.test(msg)
        ? 'اجازهٔ نوشتن در پوشهٔ نصب نبود. نصب‌کنندهٔ تازه این اجازه را می‌دهد (یک‌بار).'
        : msg;
    toast('به‌روزرسانی ناموفق: ' + fa2, 'err');
    await loadRemoteUpdate(true); render();
  }
}

async function refreshClientCache() {
  const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration().catch(() => null);
  if (!reg || !reg.active) { location.reload(); return; }
  S.wantReload = true;
  reg.active.postMessage({ type: 'CHECK_UPDATE', reload: true });
  setTimeout(() => { if (S.wantReload) location.reload(); }, 6000);
}

async function rollbackUpdate() {
  if (!confirm('به نسخهٔ قبلی برگردیم؟ فایل‌های فعلی جای‌گذاری می‌شوند (داده‌ها دست نمی‌خورند).')) return;
  const prev = (S.server && S.server.version) || '0.0.0';
  updateOverlay('در حال بازگشت به نسخهٔ قبل', 'کمی صبر کنید…');
  try {
    const r = await api('/api/admin/update/rollback', { method: 'POST' });
    if (!r.ok) throw new Error(r.error || 'خطا');
    await waitForRestart(prev, r.version);
  } catch (e) { hideUpdateOverlay(); toast('بازگشت ناموفق: ' + e.message, 'err'); }
}

/* ── ثبت Service Worker ─────────────────────────────────────────── */
if ('serviceWorker' in navigator && navigator.serviceWorker) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', ev => {
      const d = ev.data || {};
      if (d.type === 'VERSION' && d.version) S.installedVersion = d.version;
      if (d.type === 'UPDATE_DONE' && !d.up_to_date) {
        toast('آپدیت دریافت شد (' + (d.changed || 0) + ' فایل) — بازخوانی…', 'ok');
      }
      if (d.type === 'UPDATE_READY') {
        if (S.wantReload || d.reload) { S.wantReload = false; location.reload(); }
      }
      if (d.type === 'UPDATE_FAILED') toast('دریافت آپدیت ناموفق بود', 'err');
    });
  });
}

/* ── راه‌اندازی اولیهٔ برنامه ───────────────────────────────────── */
/* ── بالا آوردن برنامه بدون سرور (آفلاین) ──────────────────────────────
   روی گوشی/تبلت، همهٔ فایل‌ها داخل خود برنامه است؛ پس اگر سیستم مدرسه خاموش
   باشد هم کاربر آخرین وضعیت را می‌بیند و کارهایش در صف می‌ماند. */
async function startOffline() {
  try {
    const cached = await idbGet('data');
    if (!cached) return false;
    const raw = localStorage.getItem('payesh.lastuser');
    if (!raw) return false;
    const last = JSON.parse(raw);
    S.data = {};
    for (const c of Object.keys(cached)) S.data[c] = new Map((cached[c] || []).map(r => [Number(r.id), r]));
    S.boot = S.boot || {};
    S.user = last.user; S.role = last.role;
    S.offline = true;
    S.server = Object.assign({}, S.server, {
      ok: false, offline: true, version: last.version || S.server.version, school: last.school || S.server.school,
      setupDone: true, baseUrl: API_BASE || null,
    });
    routeFromHash();
    render();
    scheduleSync();
    toast('سرور در دسترس نیست — آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود');
    return true;
  } catch (e) { return false; }
}


/* ── تعمیر خودکار دسترسی گوشی‌ها ────────────────────────────────────
   مدیر فقط برنامه را باز می‌کند؛ اگر دسترسی مرورگر به حافظهٔ مشترک بسته
   باشد، همین‌جا یک‌بار (و بعد هر ۱۲ ساعت) خودش درست می‌شود. */
async function maybeFixPhoneAccess() {
  try {
    if (PHONE_MODE || S.role !== 'manager' || !S.server || !S.server.ok) return;
    if (!S.server.cloudReady) return;
    const at = Number(localStorage.getItem('payesh.phonecheck.at') || 0);
    if (Date.now() - at < 12 * 3600 * 1000) return;
    localStorage.setItem('payesh.phonecheck.at', String(Date.now()));
    const r = await api('/api/admin/cloud/phone-check', { method: 'POST', body: {} });
    if (r && r.ok) {
      toast('دسترسی گوشی‌ها به حافظهٔ مشترک آماده است ✅', 'ok');
    } else if (r && r.steps) {
      S.phoneCheck = r;
      localStorage.removeItem('payesh.phonecheck.at');
      toast('دسترسی گوشی‌ها کامل نشد — در «حافظهٔ ابری» ببینید', 'err');
    }
  } catch (e) { /* بی‌صدا */ }
}

async function boot() {
  try {
    const [health, setup] = await Promise.all([
      fetch(apiUrl('/api/health'), { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      fetch(apiUrl('/api/setup/state'), { cache: 'no-store' }).then(r => r.json()).catch(() => null),
    ]);
    if (!health || !health.ok) {
      /* سرور در دسترس نیست: روی گوشی/رایانهٔ بدون سرور، «کل برنامه» باید
         باز شود؛ پس اول همین دستگاه، بعد ورود با شماره+رمز از صندوقچه. */
      PHONE_MODE = true;
      S.server.version = CLIENT_VERSION;
      if (await startOffline()) return;
      renderPhoneLogin(); return;
    }
    S.server = {
      ok: true, version: health.version, school: health.school,
      setupDone: !!(setup && !setup.needs_setup),
      publicUrl: health.public_url || null, instance: health.instance || null,
      dataDir: (setup && setup.data_dir) || health.data_dir || null,
      dbFile: (setup && setup.db_file) || health.db_file || null,
      hasPassword: !!(setup && setup.has_password),
      cloudReady: !!(health && health.cloud_ready),
    };
    if (health.server_time) S.clockOffset = new Date(health.server_time).getTime() - Date.now();
    /* اگر مرورگر نسخهٔ کهنه را از حافظه سرو می‌کند، یک‌بار خودمان را تازه می‌کنیم */
    if (health.version && CLIENT_VERSION !== '0.0.0' && health.version !== CLIENT_VERSION
        && !sessionStorage.getItem('payesh.client-refresh')) {
      sessionStorage.setItem('payesh.client-refresh', '1');
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) await r.unregister();
        }
        if (window.caches) { const keys = await caches.keys(); for (const k of keys) await caches.delete(k); }
      } catch (e) { /* noop */ }
      location.reload();
      return;
    }
    if (!S.server.setupDone) { renderSetup(); return; }
    const tr = String(location.hash || '').match(/^#\/transfer\/([A-Za-z0-9_-]+)/);
    if (tr) { renderTransfer(tr[1]); return; }
    if (S.deviceToken) {
      /* دستگاهِ گره‌خورده: اول بی‌صدا نشست می‌گیریم؛ فقط اگر دستگاه باطل شده باشد، قفل */
      if (!S.session || !(await silentRefresh())) { renderLock(); return; }
      await start();
      return;
    }
    renderPair();
  } catch (e) {
    renderOffline();
  }
}
document.addEventListener('DOMContentLoaded', boot);
/* وقتی کاربر به برنامه برمی‌گردد، همان لحظه تازه‌سازی (نه تا یک ثانیه بعد) */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveKick(); });
}

/* ═══════════════════════════════════════════════════════════════════
   کنش‌ها و فرم‌ها — واگذاری رویداد (بدون هیچ inline handler)
   ═══════════════════════════════════════════════════════════════════ */

/* جستجوها: هر کادری که data-search دارد، بعد از ۲۵۰ میلی‌ثانیه سکوت */
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-search]');
  if (!el) return;
  S[el.getAttribute('data-search')] = el.value;
  clearTimeout(window._q);
  window._q = setTimeout(() => render(), 250);
});

/* انتخابگرها: هر عنصری که data-set دارد، همان لحظه در وضعیت می‌نشیند */
document.addEventListener('change', (e) => {
  const setEl = e.target.closest('[data-set]');
  if (!setEl) return;
  S[setEl.getAttribute('data-set')] = setEl.value;
  render();
});

/* تیک‌های انتخاب کاربر (برای حذف دسته‌ای) */
document.addEventListener('change', (e) => {
  const box = e.target.closest('[data-pick]');
  if (!box) return;
  if (!(S.picked instanceof Set)) S.picked = new Set();
  if (box.getAttribute('data-pick') === 'all') {
    const ids = [...document.querySelectorAll('[data-pick="user"]')].map(i => Number(i.value));
    ids.forEach(n => (box.checked ? S.picked.add(n) : S.picked.delete(n)));
  } else {
    const n = Number(box.value);
    if (box.checked) S.picked.add(n); else S.picked.delete(n);
  }
  render();
});

/* نگاشت ستون‌های فایل در ورود دسته‌ای (بدون بازسازی صفحه) */
document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-imp-map]');
  if (!sel || !S.imp) return;
  const idx = Number(sel.getAttribute('data-imp-map'));
  if (!Array.isArray(S.imp.map)) S.imp.map = [];
  S.imp.map[idx] = sel.value;
});

/* Esc = بستن پنجره (استاندارد همهٔ برنامه‌ها) */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('#modal-root [data-act="modal-close"]')) closeModal();
});
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  /* کنش‌های برنامهٔ هفتگی (client/schedule.js) */
  if (window.SCHED_ACTIONS && typeof window.SCHED_ACTIONS[act] === 'function') {
    return window.SCHED_ACTIONS[act](el, id, e);
  }

  switch (act) {
    case 'modal-close': closeModal(); return;
    /* کلیک روی پس‌زمینهٔ تیره؛ اگر روی خودِ پنجره بزنند، بسته نمی‌شود */
    case 'modal-bg': if (e.target === el) closeModal(); return;
    case 'retry': boot(); return;
    case 'cloud-phone-check': {
      if (PHONE_MODE) { toast('این بررسی روی رایانهٔ مدرسه انجام می‌شود — روی گوشی لازم نیست', 'ok'); return; }
      S._cloudBusy = true; S.phoneCheck = null; render();
      try {
        const r = await api('/api/admin/cloud/phone-check', { method: 'POST', body: {} });
        S.phoneCheck = r;
        S.server.cloudReady = !!(r.bucket) && !!r.ok;
        toast(r.ok ? 'دسترسی گوشی درست شد ✅' : 'هنوز کامل نشد — پایین را ببینید', r.ok ? 'ok' : 'err');
      } catch (e) {
        S.phoneCheck = { ok: false, steps: [{ step: 'request', ok: false, error: e.message }] };
        toast('بررسی انجام نشد: ' + e.message, 'err');
      } finally {
        S._cloudBusy = false;
        if (S.route !== 'cloud') S.route = 'cloud';
        render();
      }
      return;
    }
    case 'phone-diagnose': {
      const box = document.getElementById('diag-out');
      if (box) box.innerHTML = '<div class="muted">در حال بررسی…</div>';
      try {
        const inp = document.querySelector('form[data-form="phone-login"] input[name=phone]');
        const steps = await window.PayeshPhone.diagnose(inp ? inp.value : '');
        if (box) box.innerHTML = steps.map(s => `<div>${s.ok ? '✅' : '❌'} ${s.text}${s.detail ? ' — <span class="ltr small">' + s.detail + '</span>' : ''}</div>`).join('');
      } catch (e) {
        if (box) box.innerHTML = '<div>❌ ' + (e.message || e) + '</div>';
      }
      return;
    }
    case 'user-edit': actUserEdit(id); return;
    case 'user-delete': {
      const u = byId('users', Number(id));
      if (!u) return;
      if (!confirm('کاربر «' + u.name + '» حذف شود؟ این کار قابل بازگشت نیست.')) return;
      try {
        await deleteUserEverywhere(u.id);
        if (S.picked) S.picked.delete(Number(u.id));
        saveCache(); render();
        await flushQueue();
        toast('کاربر حذف شد', 'ok');
      } catch (e) { toast('حذف نشد: ' + friendlyError(e), 'err'); }
      return;
    }
    case 'user-auto-pw': {
      const u = byId('users', Number(id));
      if (!u) return;
      if (!PHONE_MODE) {
        try {
          const r = await api('/api/admin/users/' + u.id, { method: 'PATCH', body: { auto_password: true } });
          if (!r.ok) throw new Error(r.error === 'no_national_id' ? 'کد ملی این کاربر ثبت نشده' : (r.error || 'خطا'));
          toast(u.name + ' آمادهٔ ورود از گوشی شد — رمز: ' + (r.password || 'کد ملی'), 'ok');
          S.creds = undefined;
          await syncNow(true); render();
        } catch (e) { toast('انجام نشد: ' + friendlyError(e), 'err'); }
      } else {
        toast('این کار روی رایانهٔ مدرسه انجام می‌شود — روی گوشی لازم نیست', 'ok');
      }
      return;
    }
    case 'user-password': {
      const u = byId('users', Number(id));
      if (!u) return;
      const pw = prompt('رمز عبور جدید برای «' + u.name + '» (حداقل ۴ نویسه):');
      if (pw === null) return;
      if (String(pw).length < 4) return toast('رمز کوتاه است', 'err');
      try {
        const r = await api('/api/admin/users/' + u.id + '/password', { method: 'POST', body: { password: String(pw) } });
        /* رمزِ نمایش‌داده‌شده باید بلافاصله همان رمز تازه باشد */
        putLocal('users', Object.assign({}, u, { password_plain: String(pw) }));
        if (S.creds && S.creds[u.id]) S.creds[u.id] = Object.assign({}, S.creds[u.id], { password: String(pw) });
        else S.creds = undefined;
        if (r && r.password && S.creds) S.creds[u.id] = Object.assign({}, S.creds[u.id], { password: String(r.password) });
        toast('رمز تازه ثبت شد: ' + (r && r.password ? r.password : String(pw)) + (u.phone ? ' — ورود با ' + u.phone : ' — شمارهٔ همراه لازم است'), 'ok');
        await syncNow(true); render();
      } catch (e) { toast('ثبت نشد: ' + friendlyError(e), 'err'); }
      return;
    }
    case 'claim-open':
      S.claimOpen = true;
      S.claimPhone = '';
      if (S.server && S.user && S.user.phone) S.claimPhone = S.user.phone;
      renderPair(); return;
    case 'login-mode':
      S.loginMode = el.getAttribute('data-id') === 'pair' ? 'pair' : 'password';
      renderPair(); return;
    case 'unlock-mode':
      S.unlockMode = el.getAttribute('data-id') === 'password' ? 'password' : 'pin';
      renderLock(); return;
    case 'forget-device':
      localStorage.removeItem('payesh.device'); localStorage.removeItem('payesh.session');
      S.deviceToken = ''; S.session = ''; S.user = null; S.role = null;
      renderPair(); return;
    case 'lock': lockApp(); return;
    case 'sync': await syncNow(false); return;
    case 'net-refresh': await loadNetwork(true); render(); return;
    case 'tunnel-refresh': {
      S.tunnelBusy = true; render();
      try {
        const t = await api('/api/admin/tunnel?force=1');
        S.network = Object.assign({}, S.network, { public: t });
        toast(t.public_url ? 'آدرس عمومی فعال است' : 'آدرس عمومی فعال نیست', t.public_url ? 'ok' : 'err');
      } catch (err) { toast('بازبینی ناموفق: ' + err.message, 'err'); }
      S.tunnelBusy = false; render(); return;
    }
    case 'tunnel-enable': {
      S.tunnelBusy = true; render();
      toast('در حال ساخت آدرس عمومی…');
      try {
        const r = await api('/api/admin/tunnel', { method: 'POST', body: { action: 'enable' } });
        if (!r.ok) {
          const msg = r.error === 'tailscale_not_installed' ? 'Tailscale نصب نیست'
            : r.error === 'tailscale_not_logged_in' ? 'اول وارد Tailscale شوید'
            : 'فعال‌سازی ناموفق: ' + (r.detail || r.error || '');
          toast(msg, 'err');
        } else {
          S.server.publicUrl = r.url;
          toast('آدرس عمومی فعال شد: ' + r.url, 'ok');
        }
      } catch (err) { toast('ناموفق: ' + err.message, 'err'); }
      await loadNetwork(true);
      S.tunnelBusy = false; render(); return;
    }
    case 'tunnel-off': {
      if (!confirm('دسترسی از اینترنت قطع شود؟ بعد از این، برنامه فقط داخل شبکهٔ مدرسه باز می‌شود.')) return;
      S.tunnelBusy = true; render();
      try {
        await api('/api/admin/tunnel', { method: 'POST', body: { action: 'off', tailscale_too: true } });
        S.server.publicUrl = null;
        toast('دسترسی اینترنتی قطع شد', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      await loadNetwork(true);
      S.tunnelBusy = false; render(); return;
    }
    case 'tunnel-login': {
      try {
        const r = await api('/api/admin/tunnel', { method: 'POST', body: { action: 'login' } });
        if (r.ok) toast(r.message || 'مرورگر برای ورود باز شد', 'ok');
        else if (r.download) { window.open(r.download, '_blank'); toast('Tailscale را نصب کنید و دوباره برگردید', 'ok'); }
        else toast('ناموفق: ' + (r.detail || r.error || ''), 'err');
      } catch (err) { toast(err.message, 'err'); }
      setTimeout(() => { loadNetwork(true).then(render); }, 4000);
      return;
    }
    case 'outbox-sync': {
      toast('در حال بررسی صندوقچه…');
      const r = await loadOutbox(false);
      if (!r) toast('صندوقچه در دسترس نیست — اینترنت را بررسی کنید', 'err');
      else if (r.pending) toast(fa(r.pending) + ' ثبت هنوز منتظر است', 'err');
      else toast('همه‌چیز اعمال شده است', 'ok');
      render();
      return;
    }
    case 'copy-url': {
      const url = el.getAttribute('data-id') || '';
      try { await navigator.clipboard.writeText(url); toast('آدرس کپی شد', 'ok'); }
      catch (e) { toast(url, 'ok'); }
      return;
    }
    case 'transfer': {
      try {
        const r = await api('/api/auth/transfer', { method: 'POST' });
        if (!r.public_url) return toast('آدرس رسمی تنظیم نشده — از مدیر بخواهید', 'err');
        location.href = r.public_url + '/#/transfer/' + r.code;
      } catch (err) { toast('انتقال ناموفق: ' + err.message, 'err'); }
      return;
    }
    case 'goto-network': go('network'); return;
    case 'goto': go(el.getAttribute('data-route')); return;
    case 'print': window.print(); return;
    case 'update-check': await checkUpdate(false); render(); return;
    case 'update-apply': await applyUpdate(); return;
    case 'update-fetch': await applyRemoteUpdate(); return;
    case 'upd-retry': {
      try {
        const h = await fetch(apiUrl('/api/health'), { cache: 'no-store' }).then(r => r.json());
        if (h && h.ok) { location.reload(); return; }
      } catch (e) { /* noop */ }
      try { await fetch(apiUrl('/api/admin/update/restart'), { method: 'POST', headers: { authorization: 'Bearer ' + S.session } }); } catch (e) { /* noop */ }
      updateOverlay('دوباره تلاش شد', 'چند لحظه صبر کنید…');
      setTimeout(() => location.reload(), 4000);
      return;
    }
    case 'update-recheck': await loadRemoteUpdate(true); render(); return;
    case 'update-rollback': await rollbackUpdate(); return;
    case 'update-later': {
      try { localStorage.setItem('payesh.upd.dismiss', String((S.remote && S.remote.remote_version) || '')); } catch (e) { /* noop */ }
      updateTopChrome(); render(); return;
    }
    case 'update-auto':
    case 'update-autoapply': {
      const key = el.getAttribute('data-act') === 'update-auto' ? 'auto' : 'auto_apply';
      try {
        await api('/api/admin/update/settings', { method: 'POST', body: { [key]: !!el.checked } });
        if (S.remote) S.remote[key] = !!el.checked;
        toast(el.checked ? 'روشن شد' : 'خاموش شد', 'ok');
      } catch (err) { el.checked = !el.checked; toast(err.message, 'err'); }
      return;
    }

    case 'att-all': {
      const status = el.getAttribute('data-status');
      const page = document.querySelectorAll('.att-row');
      if (S.attDraft) { S.attDraft.map.clear(); page.forEach(r => S.attDraft.map.set(Number(r.getAttribute('data-sid')), status)); }
      render(); return;
    }
    case 'att-set': {
      const row = el.closest('.att-row');
      const sid = Number(row.getAttribute('data-sid'));
      const status = el.getAttribute('data-s');
      if (!S.attDraft) S.attDraft = { key: '', map: new Map() };
      S.attDraft.map.set(sid, status);
      /* به‌روزرسانی سریع بدون رندر کل صفحه */
      row.querySelectorAll('.att-btn').forEach(b => {
        b.className = 'att-btn' + (b.getAttribute('data-s') === status
          ? ({ present: ' on-p', absent: ' on-a', late: ' on-l', early_exit: ' on-e' })[status] : '');
      });
      return;
    }
    case 'att-save':
      await actAttendanceSave(Number(el.getAttribute('data-class')), el.getAttribute('data-bell'));
      return;

    case 'grade-reload': {
      const c = Number($('#g-class').value), s = Number($('#g-subject').value), t = $('#g-term').value;
      S.gradeSel = { class: c, subject: s, term: t };
      S.gradeDraft = null; render(); return;
    }
    case 'grade-save': await actGradeSave(); return;

    case 'role-filter': S.roleFilter = el.getAttribute('data-role'); render(); return;
    case 'sched-class': S.schedClass = Number(el.getAttribute('data-id')); render(); return;
    case 'pair-code': await actPairCode(id); return;
    case 'user-add': actUserAdd(); return;
    case 'import-open': actImport(); return;
    case 'import-back': {
      if (!S.imp) return;
      S.imp.step = Math.max(1, (S.imp.step || 1) - 1);
      renderImportStep();
      return;
    }
    case 'import-check': {
      if (!S.imp || !S.imp.rows) return;
      S.imp.checks = impCheck();
      S.imp.step = 3;
      renderImportStep();
      return;
    }
    case 'import-apply': {
      if (!S.imp) return;
      const rows = (S.imp.checks || []).filter(c => !c.errors.length).map(c => c.data);
      if (!rows.length) return toast('سطر سالمی برای ثبت نیست', 'err');
      const kindImp = ['students', 'teachers', 'grades', 'attendance'].includes(S.imp.kind) ? S.imp.kind : 'students';
      const btn = el; btn.disabled = true;
      try {
        let result;
        if (PHONE_MODE) {
          result = await importApplyLocal(rows, kindImp);
        } else {
          try {
            const r = await api('/api/admin/import', { method: 'POST', body: { kind: kindImp, rows } });
            result = {
              created: Number(r.created || 0), updated: Number(r.updated || 0),
              parents: Number(r.parents || 0), classes: Number(r.classes || 0),
              errors: r.errors || [],
            };
          } catch (err) {
            /* اگر سیستم مدرسه پاسخ نداد، همان لحظه روی همین دستگاه ساخته
               می‌شوند و در صف می‌مانند تا برسد */
            result = await importApplyLocal(rows, kindImp);
          }
          await pullAll().catch(() => {});
        }
        S.imp.step = 4;
        S.imp.result = result;
        S.creds = undefined;   /* رمزهای تازه از سرور خوانده شوند */
        saveCache(); render(); renderImportStep();
        const unit = kindImp === 'grades' ? 'نمره' : kindImp === 'attendance' ? 'حضور' : 'کاربر';
        toast(fa(result.created || 0) + ' ' + unit + ' ثبت شد'
          + (result.updated ? ' · ' + fa(result.updated) + ' به‌روزرسانی' : ''), (result.created || result.updated) ? 'ok' : 'err');
      } catch (err) {
        toast('ثبت نشد: ' + friendlyError(err), 'err');
      } finally {
        if (btn) btn.disabled = false;
      }
      return;
    }
    case 'pick-clear': S.picked = new Set(); render(); return;
    case 'users-bulk-delete': {
      const ids = [...(S.picked || new Set())].map(Number).filter(n => n);
      if (!ids.length) return toast('هیچ کاربری انتخاب نشده', 'err');
      if (!confirm(fa(ids.length) + ' کاربر حذف شوند؟ این کار قابل بازگشت نیست.')) return;
      let n = 0;
      /* ۱) اگر سیستم مدرسه در دسترس است، همان‌جا یک‌جا حذف می‌شود */
      let serverDone = false;
      if (!PHONE_MODE) {
        try {
          const r = await api('/api/admin/users/bulk-delete', { method: 'POST', body: { ids } });
          if (r && r.ok) serverDone = true;
        } catch (e) { /* مسیر محلی/صف */ }
      }
      /* ۲) و در هر حال روی همین دستگاه پاک می‌شود و در صف هم می‌رود */
      for (const idOne of ids) {
        const u = byId('users', idOne);
        if (!u) continue;
        removeLocal('users', idOne, { sync: !serverDone });
        if (S.data.users) S.data.users.delete(Number(idOne));
        n += 1;
      }
      if (!serverDone && !PHONE_MODE) {
        /* اگر سرور جواب نداد، حذف‌ها از مسیر صف می‌روند */
        for (const idOne of ids) {
          if (!S.queue.some(op => op.collection === 'users' && Number(op.id) === Number(idOne) && op.type === 'del')) {
            S.queue.push({ uid: uid(), collection: 'users', type: 'del', id: Number(idOne), at: new Date().toISOString() });
          }
        }
        saveQueue();
      }
      S.picked = new Set();
      saveCache(); render();
      await flushQueue();
      toast(fa(n) + ' کاربر حذف شد', 'ok');
      return;
    }
    case 'ann-add': actAnnAdd(); return;
    case 'ann-edit': {
      const a = byId('announcements', Number(id));
      if (!a) return toast('این اطلاعیه پیدا نشد — صفحه را دوباره باز کنید', 'err');
      actAnnAdd(a);
      return;
    }
    case 'ann-delete': {
      const a = byId('announcements', Number(id));
      if (!a) return;
      if (!confirm('اطلاعیهٔ «' + a.title + '» حذف شود؟')) return;
      removeLocal('announcements', a.id);
      saveCache(); render();
      await flushQueue();
      toast('اطلاعیه حذف شد', 'ok');
      return;
    }
    case 'leave-set': {
      const l = byId('leaves', Number(id));
      if (!l) return;
      const st = el.getAttribute('data-status') === 'rejected' ? 'rejected' : 'approved';
      putLocal('leaves', Object.assign({}, l, { status: st, decided_by: S.user.id, decided_at: new Date().toISOString() }));
      saveCache(); render();
      await flushQueue();
      toast(st === 'approved' ? 'درخواست تأیید شد' : 'درخواست رد شد', 'ok');
      return;
    }
    case 'leave-delete': {
      const l = byId('leaves', Number(id));
      if (!l) return;
      if (!confirm('این درخواست مرخصی حذف شود؟')) return;
      removeLocal('leaves', l.id);
      saveCache(); render();
      await flushQueue();
      toast('درخواست حذف شد', 'ok');
      return;
    }
    case 'leave-add': actLeaveAdd(); return;
    case 'backup-now': await actBackupNow(); return;
    case 'backup-list': await actBackups(); return;
    case 'devices-list': await actDevices(); return;
    case 'audit-list': await actAudit(); return;
    case 'revoke-device':
      try { await api('/api/admin/devices/' + id, { method: 'DELETE' }); toast('دستگاه باطل شد', 'ok'); await actDevices(); }
      catch (err) { toast(err.message, 'err'); }
      return;

    /* ── کلاس‌ها و تعریف‌ها ─────────────────────────────────────── */
    case 'class-add': actClassAdd(); return;
    case 'class-edit': actClassEdit(id); return;
    case 'class-delete': {
      const c = byId('classes', Number(id));
      if (!c) return;
      const kids = list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(c.id));
      const msg = kids.length
        ? 'کلاس «' + c.name + '» حذف شود؟ ' + fa(kids.length) + ' دانش‌آموز بدون کلاس می‌شوند (خودشان حذف نمی‌شوند).'
        : 'کلاس «' + c.name + '» حذف شود؟';
      if (!confirm(msg)) return;
      for (const u of kids) putLocal('users', Object.assign({}, u, { class_id: null }));
      removeLocal('classes', c.id);
      closeModal(); saveCache(); render();
      await flushQueue();
      toast('کلاس حذف شد', 'ok');
      return;
    }
    case 'def-add': actDefAdd(el.getAttribute('data-kind'), el.getAttribute('data-name')); return;
    case 'def-edit': actDefEdit(id); return;
    case 'def-delete': {
      const r = byId('lookups', Number(id));
      if (!r) return;
      /* هنگام حذف می‌پرسیم: فقط خودش، یا هر چیزی که به آن وابسته است */
      const linked = list('classes').filter(c => String(r.kind === 'grade' ? c.grade : c.branch || '') === String(r.name));
      const label = LOOKUP_FA[r.kind] || 'مورد';
      if (!linked.length) {
        if (!confirm('«' + r.name + '» از فهرست ' + label + '‌ها حذف شود؟')) return;
        removeLocal('lookups', r.id);
        saveCache(); render();
        await flushQueue();
        toast('حذف شد', 'ok');
        return;
      }
      S.modalTitle = 'حذف ' + label + ' — ' + r.name;
      modal(`<div class="small">این ${label} در <b>${fa(linked.length)} کلاس</b> استفاده شده است:
          ${esc(linked.map(c => c.name).slice(0, 8).join('، '))}${linked.length > 8 ? ' …' : ''}
        </div>
        <div class="small muted" style="margin-top:8px">چه کاری انجام شود؟</div>
        <button class="btn block" data-act="def-delete-only" data-id="${r.id}" style="margin-top:10px">فقط ${label} حذف شود (کلاس‌ها بمانند)</button>
        <button class="btn block" data-act="def-delete-cascade" data-id="${r.id}" style="margin-top:8px;background:#b91c1c;color:#fff">
          ${label} و ${fa(linked.length)} کلاسِ آن حذف شوند</button>
        <button class="btn block ghost" data-act="modal-close" style="margin-top:8px">انصراف</button>
        <div class="small muted" style="margin-top:8px">با حذف کلاس‌ها، دانش‌آموزان حذف نمی‌شوند؛ فقط بی‌کلاس می‌شوند و زنگ‌های برنامهٔ آن کلاس‌ها پاک می‌شود.</div>`);
      return;
    }
    case 'def-delete-only': {
      const r = byId('lookups', Number(id));
      if (!r) return;
      removeLocal('lookups', r.id);
      closeModal(); saveCache(); render();
      await flushQueue();
      toast('حذف شد', 'ok');
      return;
    }
    case 'def-delete-cascade': {
      const r = byId('lookups', Number(id));
      if (!r) return;
      const linked = list('classes').filter(c => String(r.kind === 'grade' ? c.grade : c.branch || '') === String(r.name));
      let removedClasses = 0;
      for (const c of linked) {
        for (const sg of list('schedule').filter(x => Number(x.class_id) === Number(c.id))) {
          /* جابه‌جای‌های موقت همان زنگ هم پاک می‌شوند */
          for (const sb of (S.data.substitutions ? list('substitutions').filter(x => Number(x.schedule_id) === Number(sg.id)) : [])) removeLocal('substitutions', sb.id);
          removeLocal('schedule', sg.id);
        }
        for (const u of list('users').filter(u2 => Number(u2.class_id) === Number(c.id))) putLocal('users', Object.assign({}, u, { class_id: null }));
        removeLocal('classes', c.id);
        removedClasses += 1;
      }
      removeLocal('lookups', r.id);
      closeModal(); saveCache(); render();
      await flushQueue();
      toast((LOOKUP_FA[r.kind] || 'مورد') + ' و ' + fa(removedClasses) + ' کلاس حذف شد', 'ok');
      return;
    }
    case 'subject-add': actSubjectAdd(); return;
    case 'subject-edit': actSubjectEdit(id); return;
    case 'subject-delete': {
      const sb = byId('subjects', Number(id));
      if (!sb) return;
      const used = list('schedule').filter(x => Number(x.subject_id) === Number(sb.id)).length;
      if (!confirm('درس «' + sb.name + '» حذف شود؟' + (used ? ' (' + fa(used) + ' زنگ برنامه به این درس اشاره دارد)' : ''))) return;
      for (const sg of list('schedule').filter(x => Number(x.subject_id) === Number(sb.id))) removeLocal('schedule', sg.id);
      removeLocal('subjects', sb.id);
      saveCache(); render();
      await flushQueue();
      toast('درس حذف شد', 'ok');
      return;
    }

    case 'pin-change': {
      const v = ($('#new-pin') || {}).value || '';
      if (!/^\d{4,6}$/.test(v)) return toast('PIN باید ۴ تا ۶ رقم باشد', 'err');
      try { await api('/api/auth/pin', { method: 'POST', body: { pin: v } }); toast('PIN تغییر کرد', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }

    case 'originbar-off':
      localStorage.setItem('payesh.originbar.off', (S.server && S.server.publicUrl) || 'none');
      render(); return;
    case 'cloud-edit':
      S.cloudEdit = !S.cloudEdit;
      render(); return;
    case 'cloud-reset': {
      try {
        const r = await api('/api/admin/cloud/reset', { method: 'POST', body: {} });
        await loadCloud(); render();
        toast(r.bucket ? 'به پیش‌فرض برنامه برگشت (صندوقچه: ' + r.bucket + ')' : 'به پیش‌فرض برنامه برگشت', 'ok');
      } catch (e) { toast('برنگشت: ' + e.message, 'err'); }
      return;
    }
    case 'cloud-save': {
      try {
        const r = await api('/api/admin/cloud', { method: 'POST', body: cloudForm() });
        await loadCloud(); render();
        toast(r.configured ? 'ذخیره شد' : 'ذخیره شد — ولی کامل نیست', r.configured ? 'ok' : 'err');
        if (r.configured) {
          /* خودمان CORS را تنظیم می‌کنیم تا کاربر دنبال منوی پنل نگردد */
          try {
            const c = await api('/api/admin/cloud/cors', { method: 'POST', body: {} });
            toast(c.ok ? 'CORS هم خودکار تنظیم شد' : 'CORS خودکار نشد — دکمهٔ تنظیم خودکار CORS را بزن', c.ok ? 'ok' : 'err');
          } catch (e) { /* بی‌صدا */ }
        }
      } catch (err) { toast('ذخیره نشد: ' + err.message, 'err'); }
      return;
    }
    case 'cloud-cors': {
      S._cloudBusy = true; render();
      const box = $('#cloud-out');
      try {
        if (box) box.innerHTML = '<span class="muted">در حال تنظیم خودکار CORS…</span>';
        const r = await api('/api/admin/cloud/cors', { method: 'POST', body: { config: cloudForm() } });
        if (box) {
          box.innerHTML = r.ok
            ? '<b style="color:#15803d">✅ CORS تنظیم شد</b>' +
              (r.origins && r.origins.length ? '<div class="small muted">دامنه‌های مجاز: ' + esc(r.origins.join(' , ')) + '</div>' : '') +
              '<div class="small muted" style="margin-top:4px">حالا «آزمایش از همین دستگاه» را بزن.</div>'
            : '<b style="color:#b91c1c">تنظیم خودکار نشد</b> <span class="muted">' + esc(r.error || '') + '</span>' +
              '<div class="small muted" style="margin-top:4px">یعنی کلید تو اجازهٔ تغییر تنظیمات صندوقچه را ندارد؛ قانون CORS را در پنل دستی بساز (راهنمای پایین صفحه).</div>';
        }
      } catch (err) { if (box) box.innerHTML = '<b style="color:#b91c1c">خطا:</b> ' + esc(err.message); }
      S._cloudBusy = false; return;
    }
    case 'cloud-test': {
      S._cloudBusy = true; render();
      try {
        const r = await api('/api/admin/cloud/test', { method: 'POST', body: { config: cloudForm() } });
        const box = $('#cloud-out'); if (box) box.innerHTML = cloudStepsHtml(r);
      } catch (err) { const box = $('#cloud-out'); if (box) box.innerHTML = '<b style="color:#b91c1c">خطا:</b> ' + esc(err.message); }
      S._cloudBusy = false; return;
    }
    case 'cloud-test-browser': {
      S._cloudBusy = true; render();
      const box = $('#cloud-out');
      try {
        let cfg = cloudForm();
        if (!cfg.secret) {
          const r = await api('/api/admin/cloud?reveal=1');
          cfg = Object.assign({}, r.config, cfg);
        }
        const CFG = (window.PayeshS3 && window.PayeshS3.normalize(cfg)) || cfg;
        if (box) box.innerHTML = '<span class="muted">در حال آزمایش از همین دستگاه…</span>';
        const out = await window.PayeshS3.test(CFG);
        if (box) box.innerHTML = cloudStepsHtml(out) +
          (out.ok ? '<div class="small muted" style="margin-top:6px">این دستگاه می‌تواند مستقیم بنویسد و بخواند.</div>'
                  : '<div class="small muted" style="margin-top:6px">اگر «آزمایش از سرور» سالم بود و این نه، مشکل CORS است.</div>');
      } catch (err) { if (box) box.innerHTML = '<b style="color:#b91c1c">خطا:</b> ' + esc(err.message); }
      S._cloudBusy = false; return;
    }
    case 'settings-save': {
      const name = ($('#set-name') || {}).value || '';
      try { await api('/api/admin/settings', { method: 'POST', body: { name } }); toast('ذخیره شد', 'ok'); await start(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el || !el.hasAttribute || !el.hasAttribute('data-digits')) return;
  const v = digitsOnly(el.value);
  if (v !== el.value) el.value = v;
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.getAttribute('data-form');
  const f = form.elements;
  /* فرم‌های برنامهٔ هفتگی (client/schedule.js) */
  if (window.SCHED_FORMS && typeof window.SCHED_FORMS[kind] === 'function') {
    return window.SCHED_FORMS[kind](f, form);
  }

  if (kind === 'setup') return doSetup(f);
  if (kind === 'pair') return doPair(f);
  if (kind === 'login') return doLogin(f);
  if (kind === 'phone-login') return doPhoneLogin(f);
  if (kind === 'claim') return doClaim(f);
  if (kind === 'unlock') return doUnlock(f);
  if (kind === 'transfer') return doTransfer(f);

  if (kind === 'class') {
    const name = String(f.name.value || '').trim();
    if (!name) return toast('نام کلاس را بنویسید', 'err');
    const row = {
      name,
      grade: f.grade ? f.grade.value : '',
      branch: f.branch ? f.branch.value : '',
      capacity: Number((f.capacity && f.capacity.value) || 30),
      teacher_id: Number((f.teacher_id && f.teacher_id.value) || 0) || null,
      school_id: 1,
    };
    const id = f.id ? Number(f.id.value) : 0;
    if (id) {
      const cur = byId('classes', id) || {};
      putLocal('classes', Object.assign({}, cur, row, { id }));
    } else {
      putLocal('classes', row);
    }
    closeModal(); saveCache(); render();
    await flushQueue();
    toast(id ? 'کلاس ویرایش شد' : 'کلاس ساخته شد', 'ok');
    return;
  }

  /* پایه و رشته */
  if (kind === 'def') {
    const defKind = String(f.kind.value || 'grade') === 'branch' ? 'branch' : 'grade';
    const name = String(f.name.value || '').trim();
    if (!name) return toast('نام را بنویسید', 'err');
    const dup = list('lookups').find(l => l.kind === defKind && String(l.name).trim() === name && (!f.id || Number(l.id) !== Number(f.id.value)));
    if (dup) return toast('این مورد قبلاً ثبت شده است', 'err');
    const row = { kind: defKind, name, order: Number((f.order && f.order.value) || 0) || (list('lookups').filter(l => l.kind === defKind).length + 1), school_id: 1 };
    const id = f.id ? Number(f.id.value) : 0;
    if (id) putLocal('lookups', Object.assign({}, byId('lookups', id) || {}, row, { id }));
    else putLocal('lookups', row);
    closeModal(); saveCache(); render();
    await flushQueue();
    toast((LOOKUP_FA[defKind] || 'مورد') + (id ? ' ویرایش شد' : ' ثبت شد'), 'ok');
    return;
  }

  /* درس */
  if (kind === 'subject') {
    const name = String(f.name.value || '').trim();
    if (!name) return toast('نام درس را بنویسید', 'err');
    const row = { name, workshop: !!f.workshop.value, school_id: 1 };
    const id = f.id ? Number(f.id.value) : 0;
    if (id) putLocal('subjects', Object.assign({}, byId('subjects', id) || {}, row, { id }));
    else putLocal('subjects', row);
    closeModal(); saveCache(); render();
    await flushQueue();
    toast(id ? 'درس ویرایش شد' : 'درس ثبت شد', 'ok');
    return;
  }

  /* ── ورود دسته‌ای: مرحلهٔ ۱ (خواندن فایل) ───────────────────────── */
  if (kind === 'import-file') {
    const file = f.file && f.file.files && f.file.files[0];
    if (!file) return toast('فایلی انتخاب نشده', 'err');
    const X = window.PayeshXlsx;
    if (!X) return toast('خوانندهٔ فایل بارگذاری نشده — نسخهٔ تازهٔ برنامه را نصب کنید', 'err');
    try {
      const entity = ['students', 'teachers', 'grades', 'attendance'].indexOf(f.kind && f.kind.value) > -1 ? f.kind.value : 'students';
      const isXlsx = /\.xlsx$/i.test(file.name);
      const book = isXlsx ? await X.read(await file.arrayBuffer()) : X.fromCsv(await file.text());
      const sheet = (book.sheets || []).find(sh => (sh.rows || []).length) || book.sheets[0];
      if (!sheet || !(sheet.rows || []).length) return toast('این فایل هیچ سطری ندارد', 'err');
      const allRows = (sheet.rows || []).filter(r => (r || []).some(c => String(c == null ? '' : c).trim() !== ''));
      if (!allRows.length) return toast('در این فایل سطر داده‌ای نیست', 'err');
      const width = allRows.reduce((m, r) => Math.max(m, (r || []).length), 0);
      /* ردیف تیتر: پرمحتواترین ردیف میان پنج ردیف نخست (همان قاعدهٔ p2) */
      let hi = 0, bestCells = 0;
      allRows.slice(0, 5).forEach((r, i) => {
        const n = (r || []).filter(c => String(c == null ? '' : c).trim()).length;
        if (n > bestCells) { bestCells = n; hi = i; }
      });
      const first = allRows[hi] || [];
      const guess = impAutoMap(first, entity);
      const hasHeader = Object.keys(guess).some(k => guess[k]);
      const rows = hasHeader ? allRows.slice(hi + 1) : allRows;
      if (!rows.length) return toast('در این فایل سطر داده‌ای نیست', 'err');
      const headers = hasHeader
        ? [...Array(width)].map((_, i) => String(first[i] == null ? '' : first[i]).trim() || ('ستون ' + fa(i + 1)))
        : [...Array(width)].map((_, i) => 'ستون ' + fa(i + 1));
      S.imp = {
        step: 2, kind: entity,
        headerRow: hasHeader ? hi + 1 : 0,
        fileName: file.name, sheetName: sheet.name,
        headers, rows,
        map: [...Array(width)].map((_, i) => guess[i] || ''),
      };
      renderImportStep();
    } catch (err) {
      const msg = String(err && err.message || err);
      toast('فایل خوانده نشد: ' + msg, 'err');
    }
    return;
  }

  /* اطلاعیه: اول روی همین دستگاه، بعد در صف — وقتی مدرسه خاموش است هم ثبت می‌شود */
  if (kind === 'ann') {
    const title = String(f.title.value || '').trim();
    if (!title) return toast('عنوان اطلاعیه را بنویسید', 'err');
    const id = f.id ? Number(f.id.value) : 0;
    const row = {
      title, body: String(f.body.value || '').trim(), severity: f.severity ? f.severity.value : 'normal',
      date: (id && (byId('announcements', id) || {}).date) || todayISO(),
      author_id: S.user ? S.user.id : null, school_id: 1,
    };
    if (id) putLocal('announcements', Object.assign({}, byId('announcements', id) || {}, row, { id }));
    else putLocal('announcements', row);
    closeModal(); saveCache(); render();
    await flushQueue();
    toast(id ? 'اطلاعیه ویرایش شد' : 'اطلاعیه منتشر شد', 'ok');
    if (S.online) syncNow(true);
    return;
  }

  /* درخواست مرخصی (ولی/دانش‌آموز/کادر) */
  if (kind === 'leave') {
    const studentId = Number(f.student_id ? f.student_id.value : (S.user && S.user.id));
    if (!studentId) return toast('دانش‌آموز را انتخاب کنید', 'err');
    putLocal('leaves', {
      student_id: studentId, date: (f.date && f.date.value) || todayISO(),
      reason: String(f.reason.value || '').trim(), status: 'pending',
      by_id: S.user ? S.user.id : null, school_id: 1,
    });
    closeModal(); saveCache(); render();
    await flushQueue();
    toast('درخواست ثبت شد — اگر مدرسه خاموش باشد، خودکار می‌رسد', 'ok');
    if (S.online) syncNow(true);
    return;
  }

  /* کاربر تازه + کارت پیوند */
  if (kind === 'user') {
    const name = String(f.name.value || '').trim();
    if (!name) return toast('نام را بنویسید', 'err');
    const nid = digitsOnly(f.national_id ? f.national_id.value : '');
    const phone = digitsOnly(f.phone ? f.phone.value : '');
    if (nid && !impValidNid(nid)) return toast('کد ملی معتبر نیست (۱۰ رقم با رقم کنترلی)', 'err');
    if (phone && !/^09\d{9}$/.test(phone)) return toast('شمارهٔ همراه باید با ۰۹ شروع شود و ۱۱ رقم باشد', 'err');
    if (nid && list('users').some(u => digitsOnly(u.national_id || '') === nid)) return toast('این کد ملی قبلاً ثبت شده است', 'err');
    if (phone && list('users').some(u => digitsOnly(u.phone || '') === phone)) return toast('این شمارهٔ همراه قبلاً ثبت شده است', 'err');

    const role = f.role.value || 'student';
    const row = {
      name, role,
      class_id: f.class_id && f.class_id.value ? Number(f.class_id.value) : null,
      national_id: nid,
      phone,
      birth_date: impAnyDate((f.birth_date && f.birth_date.value) || ''),
      gender: String((f.gender && f.gender.value) || '').trim(),
      active: 1, school_id: 1,
    };
    if (!row.birth_date) delete row.birth_date;
    if (!row.gender) delete row.gender;
    const created = putLocal('users', row);
    /* ولی: حساب ولی ساخته و به دانش‌آموز وصل می‌شود */
    const pName = String((f.parent_name && f.parent_name.value) || '').trim();
    const pPhone = digitsOnly((f.parent_phone && f.parent_phone.value) || '');
    if (role === 'student' && (pName || pPhone)) {
      const existing = pPhone ? list('users').find(u => u.role === 'parent' && digitsOnly(u.phone || '') === pPhone) : null;
      const parent = existing || putLocal('users', { name: pName || ('ولی ' + name), role: 'parent', phone: pPhone, active: 1, school_id: 1 });
      putLocal('parent_links', { parent_id: parent.id, student_id: created.id, relation: 'father' });
    }
    S.creds = undefined;      /* فهرست رمزها تازه شود */
    closeModal(); saveCache(); render();
    await flushQueue();
    await pullAll().catch(() => {});

    /* کارت ورود: نام کاربری و رمز، تا مدیر همان‌جا به کاربر بگوید */
    const shownUser = phone || 'ثبت نشده';
    const shownPass = String((f.password && f.password.value) || '') || nid || 'کد ملی';
    let pairCode = '';
    if (!PHONE_MODE && created.id > 0 && S.online) {
      try {
        const r = await api('/api/admin/pair-code', { method: 'POST', body: { user_id: created.id } });
        pairCode = r.code || '';
      } catch (err) { /* کارت پیوند اختیاری است */ }
    }
    S.modalTitle = 'کاربر ساخته شد — ' + name;
    modal(`<div class="card tight" style="margin:0 0 10px">
        <div class="row between"><span class="muted">نام کاربری (شمارهٔ همراه)</span><b class="ltr">${esc(shownUser)}</b></div>
        <div class="row between" style="margin-top:6px"><span class="muted">رمز عبور</span><b class="ltr">${esc(shownPass)}</b></div>
        <div class="row between" style="margin-top:6px"><span class="muted">نقش</span><b>${esc(ROLE_FA[role] || role)}</b></div>
      </div>
      ${pairCode ? `<div class="small">یا این کارت پیوند را بدهید تا بدون رمز وارد شود (۷ روز، یک‌بار مصرف):</div>
        <div class="ltr" style="font-size:1.6rem;font-weight:800;letter-spacing:2px;text-align:center;margin:10px 0">${esc(pairCode)}</div>` : ''}
      <div class="small muted">این دو مقدار را به خودِ کاربر بدهید؛ هر وقت خواست می‌تواند از «تغییر رمز» عوضش کند.</div>
      <button class="btn primary block" data-act="modal-close" style="margin-top:10px">باشه</button>`);
    toast('کاربر ساخته شد', 'ok');
    return;
  }

  /* منبع آپدیت */
  /* تغییر رمز عبور خودِ کاربر */
  if (kind === 'own-password') {
    const current = String(f.current.value || S.user.__pw || '');
    const next = String(f.next.value || '');
    const again = String(f.again.value || '');
    if (next.length < 4) return toast('رمز تازه باید حداقل ۴ نویسه باشد', 'err');
    if (next !== again) return toast('رمز تازه و تکرارش یکی نیست', 'err');
    try {
      if (PHONE_MODE) {
        /* روی گوشی: نسخهٔ قابل‌بررسی را خودمان می‌سازیم و در صندوقچه می‌گذاریم */
        const verifier = makeVerifier(next);
        await window.PayeshPhone.send({
          uid: 'pw-' + uid(), user_id: S.user.id, role: S.role,
          op: { collection: 'users', type: 'put', id: S.user.id, data: { __password_verifier: verifier }, base_version: 0 },
        });
        localStorage.setItem('payesh.own.pw', verifier);
        toast('رمز تازه ثبت شد — با اولین اتصال به سیستم مدرسه اعمال می‌شود', 'ok');
      } else {
        await api('/api/auth/password', { method: 'POST', body: { current, next } });
        toast('رمز عبور عوض شد', 'ok');
      }
      closeModal(); render();
    } catch (e) { toast('تغییر رمز ناموفق: ' + e.message, 'err'); }
    return;
  }

  /* ویرایش کاربر توسط مدیر */
  if (kind === 'user-edit') {
    let id = Number(f.id.value);
    const u = byId('users', id);
    if (!u) return toast('این کاربر پیدا نشد — صفحه را تازه کنید', 'err');
    const phone = digitsOnly(f.phone.value);
    if (phone && phone.length < 10) return toast('شمارهٔ همراه کامل نیست', 'err');
    const password = String(f.password.value || '');
    const patch = { name: String(f.name.value || '').trim() || u.name, phone, active: f.active.checked };
    if (f.birth_date) patch.birth_date = impAnyDate(f.birth_date.value || '');
    if (f.gender) patch.gender = String(f.gender.value || '').trim();
    let savedOnServer = false, passwordOnServer = false;
    if (!PHONE_MODE) {
      /* اگر کارمند تازه و آفلاین ساخته شده، شناسه‌اش محلی است؛ اول با
         همگام‌سازی شناسهٔ واقعی را می‌گیریم تا ویرایش روی سرور بنشیند. */
      if (id < 0) {
        await flushQueue();
        await pullAll().catch(() => {});
        const found = list('users').find(x => x.id > 0 && (
          (phone && x.phone === phone) || x.name === (patch.name || u.name)));
        if (found) id = found.id;
      }
      try {
        const r = await api('/api/admin/users/' + id, { method: 'PATCH', body: Object.assign({}, patch, password ? { password } : {}) });
        if (!r.ok) throw new Error(r.error === 'duplicate_phone' ? 'این شماره برای «' + (r.name || 'کاربر دیگر') + '» ثبت شده' : (r.error || 'خطا'));
        savedOnServer = true;
        passwordOnServer = !!password;
      } catch (e) {
        /* کاربر هنوز در سرور ساخته نشده (یا سرور نسخهٔ قدیمی است): تغییر را
           نگه می‌داریم و از مسیر همگام‌سازی می‌فرستیم — هیچ‌وقت «not_found». */
        const code = String((e && (e.message || e)) || '');
        if (!(e && e.status === 404) && !/not_found/.test(code)) {
          return toast('ذخیره نشد: ' + friendlyError(e), 'err');
        }
      }
    }
    /* اگر شناسهٔ واقعی پیدا شد، همان را نگه می‌داریم تا رکورد تکراری نشود */
    putLocal('users', Object.assign({}, u, { id }, patch, password ? { password_hash: 'set' } : {}));
    if (PHONE_MODE && password) {
      await window.PayeshPhone.send({
        uid: 'pw-' + uid(), user_id: S.user.id, role: S.role,
        op: { collection: 'users', type: 'put', id, data: { __password_verifier: makeVerifier(password) }, base_version: 0 },
      });
    }
    S.creds = undefined;      /* رمز نمایش‌داده‌شده باید تازه شود */
    closeModal(); saveCache(); render();
    await flushQueue();
    if (!PHONE_MODE) await pullAll().catch(() => {});
    S.creds = undefined;
    render();
    if (password && !passwordOnServer) {
      toast(PHONE_MODE
        ? 'اطلاعات ذخیره شد — رمز تازه با اولین اتصال به سیستم مدرسه اعمال می‌شود'
        : 'اطلاعات ذخیره شد؛ رمز پس از همگام‌سازی با سیستم مدرسه اعمال می‌شود', 'ok');
    } else {
      toast(savedOnServer || PHONE_MODE ? 'کاربر ویرایش شد' : 'تغییرات ذخیره شد و با همگام‌سازی اعمال می‌شود', 'ok');
    }
    return;
  }

  if (kind === 'update') {
    try {
      const r = await api('/api/admin/update/settings', { method: 'POST', body: { base: String(f.base.value || '').trim() } });
      S.remote = Object.assign({}, S.remote || {}, { base: r.base });
      toast('منبع آپدیت ذخیره شد', 'ok');
      render();
    } catch (err) { toast('ذخیره نشد: ' + err.message, 'err'); }
    return;
  }
});
