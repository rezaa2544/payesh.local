/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال — هستهٔ کلاینت (بدون چارچوب، بدون CDN)
   ذخیره‌سازی: IndexedDB برای داده + localStorage برای توکن/صف
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* با build-release هم‌تراز می‌شود؛ برای تشخیص «نسخهٔ کهنه در حافظهٔ مرورگر» */
const CLIENT_VERSION = '0.8.35';

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
  /* D‑28: تعارض/ردی که باید تصمیم‌گیری شود — هرگز خاموش دور ریخته نمی‌شود */
  review: JSON.parse(localStorage.getItem('payesh.review') || '[]'),
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
function saveReview() { localStorage.setItem('payesh.review', JSON.stringify(S.review.slice(-200))); }

/* F‑01: پاک‌سازی یک‌بارهٔ رمزهای خامِ کش‌شده از نسخه‌های قبلی */
(function purgeCachedPasswords() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!/^payesh\.cache\.|^payesh\.lastuser$/.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v || v.indexOf('password_plain') < 0) continue;
      localStorage.setItem(k, v.replace(/"password_plain":("[^"]*"|null),?/g, '').replace(/,"password_plain":("[^"]*"|null)/g, ''));
    }
  } catch (e) { /* noop */ }
})();

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

/* ══════════ نشانگر «در حال پردازش» ══════════
   برای کارهای چند ثانیه‌ای (مثل ثبت ۱۲۹ ردیف اکسل) تا کاربر فکر نکند
   برنامه هنگ کرده است. */
function busyOverlay(text, sub) {
  let el = document.getElementById('busy-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'busy-overlay';
    el.className = 'busy-overlay';
    el.innerHTML = '<div class="busy-box"><div class="spinner"></div>'
      + '<div class="busy-title" id="busy-title"></div>'
      + '<div class="busy-bar"><i id="busy-fill"></i></div></div>';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  const t = document.getElementById('busy-title');
  /* فقط یک جمله: «در حال ثبت» — بدون توضیح اضافه */
  if (t) t.textContent = text || 'در حال ثبت';
  busyUpdate(0, 0);
  return el;
}
function busyUpdate(done, total) {
  /* فقط نوار پیشرفت؛ هیچ متنی نوشته نمی‌شود */
  const fill = document.getElementById('busy-fill');
  if (!fill) return;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 35;
  fill.style.width = pct + '%';
  if (fill.parentNode) fill.parentNode.style.display = 'block';
}
function busyHide() {
  const el = document.getElementById('busy-overlay');
  if (el) el.style.display = 'none';
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
        for (const r of rejected) {
          S.review.push({
            kind: 'rejected', uid: r.uid, error: r.error || 'rejected',
            conflict_id: r.conflict_id == null ? null : r.conflict_id,
            at: new Date().toISOString(), status: 'needs_review',
          });
        }
        saveReview();
        S.queue = S.queue.filter(op => !dead.has(op.uid));
        toast(fa(rejected.length) + ' تغییر رد شد — نیازمند بررسی مدیر', 'err');
      } else {
        const done = new Set(batch.map(o => o.uid));
        S.queue = S.queue.filter(op => !done.has(op.uid));
      }
      if (conflicts.length) {
        for (const c of conflicts) {
          /* D‑28: هر دو نسخه می‌مانند. نسخهٔ سرور نمایش داده می‌شود، ولی
             نسخهٔ محلی در فهرست «نیازمند بررسی» برای تصمیم مجاز نگه داشته
             می‌شود و هیچ‌گاه خودکار «حل‌شده» به حساب نمی‌آید. */
          const local = S.queue.find(op => op.uid === c.uid) || null;
          S.review.push({
            kind: 'conflict', uid: c.uid, conflict_id: c.conflict_id == null ? null : c.conflict_id,
            collection: c.collection, id: c.id,
            server_version: c.server_version,
            local: local ? local.data : null, server: c.server || null,
            at: new Date().toISOString(), status: 'needs_review',
          });
          if (c.server) {
            if (!S.data[c.collection]) S.data[c.collection] = new Map();
            S.data[c.collection].set(Number(c.id), c.server);
          }
          S.queue = S.queue.filter(op => op.uid !== c.uid && !(op.collection === c.collection && c.id != null && Number(op.id) === Number(c.id)));
        }
        saveReview();
        toast('تعارض در ' + fa(conflicts.length) + ' رکورد — هر دو نسخه نگه داشته شد؛ نیازمند تصمیم', 'err');
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
  /* F‑01: هیچ رمز خامی در حافظهٔ محلی/کش نمی‌ماند */
  if (row && typeof row === 'object') { delete row.password_plain; delete row.password_enc; }
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
   (باگ مهم: شمارهٔ همراه با ارقام فارسی ذخیره نمی‌شد و ورود شکست می‌خورد) */
function digitsOnly(v) {
  return String(v == null ? '' : v)
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\d]/g, '');
}

/* شمارهٔ همراه: هر شکلی را به ۱۱ رقم «09…» برمی‌گرداند.
   اکسل و آدم‌ها صفرِ اول را جا می‌اندازند (9123456789) — همان را
   خودکار کامل می‌کنیم تا نام کاربری هیچ‌وقت ناقص ذخیره نشود. */
function mobile11(v) {
  let d = digitsOnly(v);
  if (!d) return '';
  if (/^0098/.test(d)) d = d.slice(4);
  else if (/^98/.test(d) && d.length >= 12) d = d.slice(2);
  if (/^9\d{9}$/.test(d)) return '0' + d;
  if (/^989\d{9}$/.test(d)) return '0' + d.slice(2);
  return d;
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
    password: pass,
    school_type: form.school_type.value,
    school_year: form.school_year.value.trim(),
  };
  if (body.phone.length !== 11) return toast('شمارهٔ همراه باید ۱۱ رقم باشد', 'err');
  if (pass.length < 4) return toast('رمز عبور حداقل ۴ نویسه باشد', 'err');
  if (pass !== pass2) return toast('رمز عبور و تکرارش یکی نیست', 'err');

  try {
    const r = await api('/api/setup', { method: 'POST', body });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    localStorage.setItem('payesh.authmode', 'password');
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
  if (phone.length !== 11 && phone.length !== 10) {
    return toast('شمارهٔ همراه ۱۱ رقم است و کد ملی ۱۰ رقم — دوباره بنویسید', 'err');
  }
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
    if (/bad_credentials/.test(em)) return toast('نام کاربری (شمارهٔ همراه یا کد ملی) یا رمز درست نیست', 'err');
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
  if (phone.length !== 11 && phone.length !== 10) {
    return toast('شمارهٔ همراه ۱۱ رقم است و کد ملی ۱۰ رقم — دوباره بنویسید', 'err');
  }
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
        bad_credentials: 'نام کاربری (شمارهٔ همراه یا کد ملی) یا رمز درست نیست',
        no_password: 'این حساب هنوز رمز ندارد — از مدیر بخواهید رمز بسازد',
        not_registered: 'این شماره/کد ملی در مدرسه ثبت نشده — از مدیر بخواهید حساب بسازد (و یک‌بار با سیستم مدرسه همگام شود)',
        user_inactive: 'حساب غیرفعال است',
        bad_phone: 'شمارهٔ همراه ۱۱ رقم و کد ملی ۱۰ رقم است — دوباره بنویسید',
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
  return pairWithCode(String(form.code.value || ''));
}

async function pairWithCode(raw) {
  const code = String(raw || '').replace(/[^0-9A-Za-z]/g, '').trim();
  if (code.length < 4) return toast('کد پیوند را کامل بنویسید', 'err');
  try {
    const r = await api('/api/auth/pair', { method: 'POST', body: { code, platform: platformName(), name: deviceName() } });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    await start();
  } catch (e) {
    const map = { bad_code: 'کد پیوند نامعتبر است — کد را کامل و درست وارد کنید', code_revoked: 'این کد باطل شده — مدیر کد تازه ساخته است؛ کارت تازه را بگیرید', code_used: 'این کد باطل شده — از مدیر کد تازه بگیرید', code_expired: 'کد منقضی شده — از مدیر کد تازه بگیرید', user_inactive: 'حساب غیرفعال است' };
    toast(map[e.message] || 'ورود ناموفق: ' + e.message, 'err');
  }
}

async function doTransfer(form) {
  const code = form.code.value.trim();
  const password = String((form.password && form.password.value) || '');
  try {
    const r = await api('/api/auth/transfer/redeem', { method: 'POST', body: { code, password, platform: platformName(), name: deviceName() } });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    go('home');
    await start();
  } catch (e) {
    const map = { bad_code: 'کد انتقال نامعتبر است', code_revoked: 'این کد باطل شده', code_used: 'این کد باطل شده', code_expired: 'کد انتقال منقضی شده', bad_password: 'رمز عبور درست نیست' };
    toast(map[e.message] || 'انتقال ناموفق: ' + e.message, 'err');
  }
}

async function doUnlock(form) {
  const field = form.password || form.querySelector('input[type="password"]');
  const body = { device_token: S.deviceToken, password: String((field && field.value) || '') };
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
      S.unlockMode = 'password'; toast('برای این حساب رمز عبور تنظیم نشده — از مدیر بخواهید رمز بگذارد', 'err');
      renderLock(); return;
    }
    if (e.message === 'locked') { toast('چند بار اشتباه زدید — ۱۰ دقیقه صبر کنید', 'err'); return; }
    toast('رمز عبور نادرست است', 'err');
    if (field) { field.value = ''; field.focus(); }
  }
}

/* QR روی کارت پیوند در مرورگر باز می‌شود؛ اگر برنامه نصب باشد همان
   اسکن باید مستقیم کاربر را داخل برنامه ببرد. یک‌بار و فقط یک‌بار تلاش
   می‌کنیم و اگر برنامه باز نشد، صفحهٔ راهنما با دکمهٔ بزرگ می‌ماند. */
function maybeOpenInstalledApp() {
  const code = pairCodeFromHash();
  if (!code) return;
  if (typeof window !== 'undefined' && window.PAYESH_BUNDLED === true) return;  /* داخل خود برنامه‌ایم */
  if (S.deviceToken || S.session) return;
  if (!/Android/i.test(navigator.userAgent || '')) return;                       /* payesh:// فقط روی اندروید */
  const key = 'payesh.deeplink.' + code;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* noop */ }
  setTimeout(() => {
    try { location.href = pairDeepLink(code); } catch (e) { /* مرورگر اجازه نداد؛ دکمه می‌ماند */ }
  }, 700);
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
    /* D‑23/F‑04: هیچ کلید/اعتبارنامه‌ای روی دستگاه نگه داشته نمی‌شود.
       نوشتن در صندوقچه فقط از سرور انجام می‌شود؛ نسخهٔ قدیمی که پیکربندی را
       در localStorage می‌ریخت، همین‌جا پاک‌سازی می‌شود. */
    try { localStorage.removeItem('payesh.cloudcfg'); } catch (e) { /* noop */ }
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

/* ── کد پیوند از پیوند/QR ──────────────────────────────────────────
   سه شکل پشتیبانی می‌شود:  #/pair=CODE  ·  #/pair?c=CODE  ·  #/join/CODE */
function pairCodeFromHash() {
  const h = String(location.hash || '');
  const m = h.match(/#\/(?:join|pair)[=\/]?([A-Za-z0-9-]{4,})/) || h.match(/[?&]c=([A-Za-z0-9-]{4,})/);
  return m ? m[1].replace(/[^0-9A-Za-z]/g, '').toUpperCase() : '';
}
function linkPairCode() {
  const injected = String((typeof window !== 'undefined' && window.PAYESH_PAIR_CODE) || '').replace(/[^0-9A-Za-z]/g, '');
  return injected || pairCodeFromHash();
}
/* در برنامهٔ نصب‌شده، اسکن QR یا پیوند payesh://pair?c=… باید بی‌درنگ
   وارد حساب شود — بی‌هیچ رمز و بی‌هیچ دکمه‌ای. */
async function autoPairFromLink() {
  const code = linkPairCode();
  if (!code) return false;
  if (S.deviceToken || S.session) return false;              /* از قبل وارد است */
  const inApp = typeof window !== 'undefined' && window.PAYESH_BUNDLED === true;
  const asked = /#\/pair[=\/]/.test(String(location.hash || '')) && /auto=1/.test(String(location.hash || ''));
  if (!inApp && !asked) return false;                        /* در مرورگر، صفحهٔ راهنما نشان داده می‌شود */
  try {
    const r = await api('/api/auth/pair', { method: 'POST', body: { code, platform: platformName(), name: deviceName() } });
    /* کد پیوند دائمی است؛ دیگر «مصرف‌شده» علامت نمی‌خورد تا بعد از
       خروج از حساب هم همان کارت دوباره کار کند. */
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    try { if (window.PayeshNative && window.PayeshNative.pairCodeUsed) window.PayeshNative.pairCodeUsed(); } catch (e) { /* noop */ }
    if (String(location.hash || '').indexOf('/pair') >= 0) location.hash = '#/home';
    toast('خوش آمدید ' + (r.user.name || ''), 'ok');
    await start();
    return true;
  } catch (e) {
    const map = {
      bad_code: 'کد پیوند نامعتبر است', code_revoked: 'این کد باطل شده — مدیر کد تازه ساخته است؛ کارت تازه را بگیرید', code_used: 'این کد باطل شده — از مدیر کد تازه بگیرید',
      code_expired: 'کد منقضی شده — از مدیر کد تازه بگیرید', user_inactive: 'حساب غیرفعال است',
    };
    toast(map[e.message] || 'ورود خودکار نشد: ' + e.message, 'err');
    return false;
  }
}
window.addEventListener('hashchange', async () => {
  routeFromHash();
  if (/\/pair[=\/]/.test(String(location.hash || '')) && await autoPairFromLink()) return;
  /* پیش از ورود: صفحهٔ اسکن هم باید باز شود */
  if ((!S.session || !S.user) && S.route === 'scan' && typeof window.renderScanPage === 'function') {
    window.renderScanPage();
    window.scrollTo(0, 0);
    return;
  }
  render();
  maybeOpenInstalledApp();
  window.scrollTo(0, 0);
  if (S.route === 'network' && S.role === 'manager') { await loadNetwork(false); render(); }
});

/* ── آینهٔ داده و پشتیبان روزانه (فقط مدیر، روی سیستم مدرسه) ─────── */
async function loadMirror() {
  if (PHONE_MODE) { S.mirror = null; return null; }
  try {
    const r = await api('/api/admin/mirror', { noAuthRedirect: true });
    S.mirror = r;
    return r;
  } catch (e) {
    S.mirror = { error: friendlyError(e), mirror: null, daily: [] };
    return S.mirror;
  }
}

async function actMirrorRefresh() {
  if (PHONE_MODE) { toast('این کار روی رایانهٔ مدرسه انجام می‌شود', 'err'); return; }
  try {
    const r = await api('/api/admin/mirror/refresh', { method: 'POST', body: {} });
    S.mirror = r;
    render();
    toast('آینه به‌روز شد · ' + fa((r.mirror && r.mirror.total) || 0) + ' رکورد' +
      (r.mirror && r.mirror.ok ? ' — با دیتابیس یکی است ✅' : ' — اختلاف باقی است'), 'ok');
  } catch (e) { toast('به‌روزرسانی نشد: ' + friendlyError(e), 'err'); }
}

async function actMirrorRestore() {
  const input = document.getElementById('restore-file');
  const file = input && input.files && input.files[0];
  if (!file) { toast('اول فایل پشتیبان (.json) را انتخاب کنید', 'err'); return; }
  if (file.size > 60 * 1024 * 1024) { toast('این فایل بزرگ‌تر از حد مجاز است', 'err'); return; }
  const replace = confirm('اطلاعات همین فایل روی سیستم نوشته شود؟\n\nتأیید = بازگردانی و حفظ رکوردهای فعلی\nانصراف = لغو');
  let text = '';
  try { text = await file.text(); } catch (e) { toast('فایل خوانده نشد', 'err'); return; }
  let data = null;
  try { data = JSON.parse(text); } catch (e) { toast('این فایل پشتیبان معتبر نیست (JSON ناخوانا)', 'err'); return; }
  if (!data || data.format !== 'payesh-backup') { toast('این فایل، فایل پشتیبان پایش نیست', 'err'); return; }
  try {
    const r = await api('/api/admin/restore', { method: 'POST', body: { data, replace: false } });
    const n = r.report && r.report.restored ? Object.keys(r.report.restored).reduce((a, k) => a + Number(r.report.restored[k] || 0), 0) : 0;
    toast('بازیابی انجام شد · ' + fa(n) + ' رکورد' + (r.safety ? ' · نسخهٔ ایمنی: ' + r.safety : ''), 'ok');
    S.mirror = undefined;
    await pullAll().catch(() => {});
    await loadMirror().catch(() => {});
    render();
  } catch (e) { toast('بازیابی نشد: ' + friendlyError(e), 'err'); }
}

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
  const key = el.getAttribute('data-focus-key') || el.getAttribute('name') || el.id || '';
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
  if (!el && document.getElementById) el = document.getElementById(snap.key);
  if (!el && document.querySelectorAll) {
    /* کادرهایی که «name» ندارند (مثل کادر جستجو که فقط id/data-focus-key
       دارد) هم پیدا می‌شوند؛ وگرنه بعد از هر بازسازی، فوکوس و صفحه‌کلید
       می‌پرید و کاربر باید دوباره روی کادر می‌زد. */
    const all = document.querySelectorAll('input, textarea, select');
    for (const cand of all) {
      const k = cand.getAttribute('name') || cand.getAttribute('data-focus-key') || cand.id || '';
      if (k === snap.key) { el = cand; break; }
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
  /* گارد مسیر: نقش‌ها فقط صفحه‌های مجاز خودشان را می‌بینند (مثل p2) */
  if (typeof window.authzCanRoute === 'function' && !window.authzCanRoute(S.route, S.role || (S.user && S.user.role))) {
    paintApp(shellHtml(window.authzDeniedHtml(S.route)));
    updateTopChrome();
    return;
  }
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

  /* وضعیت به‌روزرسانی در صفحهٔ «سیستم» (همان snapshot k3-reval) */
  if (S.route === 'system' && ['manager', 'teacher', 'counselor', 'guard'].indexOf(S.role) >= 0 && S.mirror === undefined && !S._mirrorLoading && !PHONE_MODE) {
    S._mirrorLoading = true;
    loadMirror().then(() => { S._mirrorLoading = false; if (S.route === 'system') render(); })
      .catch(() => { S._mirrorLoading = false; });
  }
  if (S.route === 'system' && S.role === 'manager' && S.upd === undefined && !S._updLoading) {
    S._updLoading = true;
    loadUpdState().then(() => { S._updLoading = false; if (S.route === 'system') render(); })
      .catch(() => { S._updLoading = false; });
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

/* ══════════════ به‌روزرسانی — همان چرخهٔ k3-reval ══════════════════
   بررسی → (نسخهٔ تازه) → دانلودِ فقط فایل‌های تغییرکرده با درصد پیشرفت
   → «آمادهٔ نصب» → نصب. دقیقاً همان state machine نسخهٔ k3-reval
   (src/updater.js) ولی روی موتور دلتای همین برنامه.
   ═══════════════════════════════════════════════════════════════════ */
async function loadUpdState() {
  if (S.role !== 'manager') { S.upd = null; return null; }
  try {
    const r = await api('/api/admin/update/state', { noAuthRedirect: true });
    S.upd = r.state || null;
  } catch (e) { /* بی‌صدا — آفلاین */ }
  return S.upd;
}

let updPollTimer = null;
function updPoll(on) {
  if (updPollTimer) { clearInterval(updPollTimer); updPollTimer = null; }
  if (!on) return;
  updPollTimer = setInterval(async () => {
    const st = await loadUpdState();
    if (!st) return;
    const busy = st.status === 'downloading' || st.status === 'installing' || st.status === 'checking';
    updOverlayShow(st);
    if (!busy) {
      updPoll(false);
      if (st.status === 'ready') { hideUpdateOverlay(); render(); }
    }
  }, 800);
}

function updPctBar(st) {
  const pct = Math.max(0, Math.min(100, Number(st.percent) || 0));
  return `<div style="height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin:12px 0 6px">
      <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width .3s"></div>
    </div>
    <div class="small muted">${fa(pct)}٪${st.totalKb ? ' · ' + fa(st.receivedKb || 0) + ' از ' + fa(st.totalKb) + ' کیلوبایت' : ''}</div>`;
}

function updOverlayShow(st) {
  const el = document.getElementById('upd-overlay') || updateOverlay('', '');
  let title = 'در حال به‌روزرسانی';
  let sub = '';
  if (st.status === 'checking') { title = 'بررسی نسخهٔ تازه'; sub = 'چند لحظه…'; }
  else if (st.status === 'downloading') { title = 'در حال دانلود تغییرات'; sub = 'فقط فایل‌هایی که عوض شده‌اند'; }
  else if (st.status === 'installing') { title = 'در حال نصب'; sub = 'فایل‌های تازه جای‌گذاری می‌شوند'; }
  else if (st.status === 'ready') { title = 'آمادهٔ نصب'; sub = 'دانلود کامل شد'; }
  else if (st.status === 'error') { title = 'به‌روزرسانی انجام نشد'; sub = st.errorText || st.error || ''; }
  el.innerHTML = `<div class="card" style="max-width:420px;text-align:center;direction:rtl">
      <div style="font-size:34px;margin-bottom:6px">${st.status === 'error' ? '⚠️' : '🔄'}</div>
      <div style="font-weight:700;font-size:1.05rem">${esc(title)}</div>
      <div class="small muted" style="margin-top:8px">${esc(sub || '')}</div>
      ${st.status === 'downloading' ? updPctBar(st) : ''}
      ${st.mode === 'patch' && st.savedMb ? `<div class="small muted" style="margin-top:8px">این روش ${fa(st.savedMb)} مگابایت کم‌تر از نصب‌کنندهٔ کامل دانلود می‌کند</div>` : ''}
    </div>`;
  return el;
}

/* یک کلیک: بررسی → دانلود → نصب */
async function updOneClick() {
  if (S.role !== 'manager') { toast('فقط مدیر سیستم می‌تواند به‌روزرسانی کند', 'err'); return; }
  if (S.remoteBusy) return;
  S.remoteBusy = true;
  const prev = (S.server && S.server.version) || '0.0.0';
  try {
    await loadRemoteUpdate(true);
    const st0 = await loadUpdState();
    if (!st0 || !st0.hasUpdate) { toast('برنامه به‌روز است', 'ok'); S.remoteBusy = false; updPoll(false); hideUpdateOverlay(); render(); return; }

    /* ۱) دانلود با نمایش درصد */
    updOverlayShow({ status: 'downloading', percent: 0, mode: st0.mode, savedMb: st0.savedMb });
    updPoll(true);
    const dl = await api('/api/admin/update/download', { method: 'POST', body: {} });
    if (!dl.ok) {
      throw new Error(dl.detail || dl.error || 'download_failed');
    }
    if (!dl.available) {
      updPoll(false); hideUpdateOverlay(); S.remoteBusy = false;
      toast('برنامه همین حالا به‌روز است', 'ok');
      await loadRemoteUpdate(true); render(); return;
    }
    await loadUpdState();
    updOverlayShow(S.upd || { status: 'ready' });

    /* ۲) نصب */
    const r = await api('/api/admin/update/install', { method: 'POST', body: {} });
    if (!r.ok) throw new Error(r.detail || r.error || 'apply_failed');
    if (!r.applied) {
      updPoll(false); hideUpdateOverlay(); S.remoteBusy = false;
      toast('برنامه همین حالا به‌روز است', 'ok');
      await loadRemoteUpdate(true); render(); return;
    }
    try { localStorage.removeItem('payesh.upd.dismiss'); } catch (e) { /* بی‌صدا */ }
    const kb = Math.max(1, Math.round((r.bytes || 0) / 1024));
    toast('نسخهٔ ' + fa(r.version) + ' نصب شد — ' + fa(r.files) + ' فایل، ' + fa(kb) + ' کیلوبایت', 'ok');
    if (r.restart) {
      updateOverlay('نسخهٔ ' + fa(r.version) + ' نصب شد', 'برنامهٔ مدرسه دوباره راه می‌افتد؛ چند لحظه…');
      await waitForRestart(prev, r.version);
      return;
    }
    updPoll(false); hideUpdateOverlay();
    await refreshClientCache();
  } catch (e) {
    updPoll(false);
    let msg = String(e.message || '');
    try { await loadUpdState(); } catch (e2) { /* بی‌صدا */ }
    if (S.upd && S.upd.errorText) msg = S.upd.errorText;
    else if (/needs_admin/.test(msg)) msg = 'این آپدیت کد سرور را عوض می‌کند و پوشهٔ نصب محافظت‌شده است — یک‌بار نصب‌کنندهٔ تازه را اجرا کنید؛ از آن پس آپدیت‌ها خودکار می‌شوند.';
    else if (/EACCES|EPERM|apply_failed/.test(msg)) msg = 'اجازهٔ نوشتن در پوشهٔ نصب نبود — یک‌بار نصب‌کنندهٔ تازه را اجرا کنید.';
    else if (/download_failed|timeout/i.test(msg)) msg = 'دانلود کامل نشد — اتصال اینترنت را بررسی کنید و دوباره بزنید؛ برنامه دست‌نخورده مانده است.';
    hideUpdateOverlay();
    toast('به‌روزرسانی ناموفق: ' + msg, 'err');
    render();
  } finally {
    S.remoteBusy = false;
  }
}

/* «دانلود» و «نصب» جدا (حالت k3-reval: آمادهٔ نصب) */
async function updDownload() {
  if (S.remoteBusy) return;
  S.remoteBusy = true;
  updPoll(true);
  updOverlayShow({ status: 'downloading', percent: 0 });
  try {
    const r = await api('/api/admin/update/download', { method: 'POST', body: {} });
    await loadUpdState();
    if (!r.ok) toast('دانلود انجام نشد: ' + (r.error === 'download_failed' ? 'اتصال را بررسی کنید' : (r.error || '')), 'err');
    else if (!r.available) toast('برنامه به‌روز است', 'ok');
    else toast('دانلود کامل شد — حالا «نصب» را بزنید', 'ok');
  } catch (e) { toast('دانلود انجام نشد: ' + e.message, 'err'); }
  finally { S.remoteBusy = false; updPoll(false); hideUpdateOverlay(); render(); }
}

async function updInstall() {
  if (S.remoteBusy) return;
  S.remoteBusy = true;
  const prev = (S.server && S.server.version) || '0.0.0';
  try {
    const r = await api('/api/admin/update/install', { method: 'POST', body: {} });
    if (!r.ok) throw new Error(r.detail || r.error || 'apply_failed');
    try { localStorage.removeItem('payesh.upd.dismiss'); } catch (e) { /* بی‌صدا */ }
    toast('نسخهٔ ' + fa(r.version) + ' نصب شد', 'ok');
    if (r.restart) {
      updateOverlay('نسخهٔ ' + fa(r.version) + ' نصب شد', 'برنامه دوباره راه می‌افتد؛ چند لحظه…');
      await waitForRestart(prev, r.version);
      return;
    }
    await refreshClientCache();
  } catch (e) {
    toast('نصب انجام نشد: ' + e.message, 'err');
    render();
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
      if (String(location.hash || '').indexOf('#/scan') === 0 && typeof window.renderScanPage === 'function') {
        window.renderScanPage();
        return;
      }
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
    if (!S.deviceToken && await autoPairFromLink()) return;
    if (S.deviceToken) {
      /* دستگاهِ گره‌خورده: اول بی‌صدا نشست می‌گیریم؛ فقط اگر دستگاه باطل شده باشد، قفل */
      if (!S.session || !(await silentRefresh())) { renderLock(); return; }
      await start();
      return;
    }
    /* صفحهٔ اسکن، پیش از ورود هم باید باز شود (کاربر QR کارت را می‌آورد) */
    if (String(location.hash || '').indexOf('#/scan') === 0 && typeof window.renderScanPage === 'function') {
      window.renderScanPage();
      return;
    }
    renderPair();
    maybeOpenInstalledApp();
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
  if (sel.value === '__custom__') {
    /* ستونی که در فهرست نیست: مدیر خودش نامش را می‌نویسد */
    const label = prompt('این ستون چه چیزی است؟ (مثلاً «شغل مادر»، «شمارهٔ پرونده»)', '');
    const nm = String(label || '').replace(/\s+/g, ' ').trim();
    if (!nm) { sel.value = S.imp.map[idx] || ''; return; }
    const key = impCustomKey(nm);
    impSaveCustomLabel(key, nm);
    S.imp.map[idx] = key;
    sel.innerHTML = `<option value="${key}" selected>✏️ ${nm}</option>` + sel.innerHTML;
    sel.value = key;
    toast('ستون «' + nm + '» به فیلدهای دلخواه اضافه شد', 'ok');
    return;
  }
  S.imp.map[idx] = sel.value;
});

/* پایه در مرحلهٔ ۱: تا پایه انتخاب نشود، «بعدی» فعال نیست */
document.addEventListener('change', (e) => {
  const box = e.target.closest('input[name="imp-grade"]');
  if (!box) return;
  const form = box.closest('form');
  if (!form) return;
  const any = Array.from(form.querySelectorAll('input[name="imp-grade"]')).some(b => b.checked);
  const next = form.querySelector('button[type="submit"], .btn.primary.block');
  if (next) next.disabled = !any;
  const hint = form.querySelector('[data-imp-grade-hint]');
  if (hint) hint.style.display = any ? 'none' : 'block';
});

/* Esc = بستن پنجره (استاندارد همهٔ برنامه‌ها) */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const bg = document.querySelector('#modal-root .modal-bg');
  if (bg && bg.getAttribute('data-lock') === '1') return;   /* پنجرهٔ قفل‌دار با Esc بسته نمی‌شود */
  if (document.querySelector('#modal-root [data-act="modal-close"]')) closeModal();
});
/* ══════════════ «زنده» بودن همهٔ کنش‌ها ══════════════════════════════
   شکایت کاربر: «وقتی گزینه‌ای را می‌زنیم هیچ واکنشی نشان نمی‌دهد».
   راه‌حل: هر کلیک بی‌درنگ نشانه می‌گیرد — دکمه فشرده می‌شود، نشانگر
   چرخان روی خودِ دکمه می‌آید، نوار باریک بالای صفحه روشن می‌شود و تا
   تمام‌شدن کار می‌چرخد. هیچ کنشی هم بدون گزارش تمام نمی‌شود. */
let LIVE_COUNT = 0;
function liveBar(on) {
  const bar = document.getElementById('live-bar');
  if (bar) bar.classList.toggle('on', on);
  document.body.style.cursor = on ? 'progress' : '';
}
/* آیکونِ خودِ دکمه هم بچرخد (درخواست کاربر: «آیکون بررسی دوباره بچرخه»).
   ایموجیِ ابتدای متن را در یک span می‌گذاریم و پس از پایان کار برمی‌گردانیم؛
   هیچ متن یا ساختاری از دکمه از دست نمی‌رود. */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF]/u;
function liveSpinIcon(el) {
  if (!el || !el.childNodes || el.querySelector('.spin')) return null;
  try {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== 3) continue;
      const txt = n.nodeValue || '';
      const i = txt.search(EMOJI_RE);
      if (i < 0) continue;
      const cp = String.fromCodePoint(txt.codePointAt(i));
      const vs = txt.slice(i + cp.length, i + cp.length + 1);
      const extra = (vs === '\uFE0F' || vs === '\u200D') ? vs : '';
      const before = txt.slice(0, i);
      const after = txt.slice(i + cp.length + extra.length);
      const span = document.createElement('span');
      span.className = 'spin';
      span.textContent = cp + extra;
      const head = document.createTextNode(before);
      const tail = document.createTextNode(after);
      el.replaceChild(head, n);
      head.parentNode.insertBefore(span, head.nextSibling);
      span.parentNode.insertBefore(tail, span.nextSibling);
      return () => {
        try {
          head.nodeValue = txt;
          if (span.parentNode) span.parentNode.removeChild(span);
          if (tail.parentNode) tail.parentNode.removeChild(tail);
        } catch (e) { /* noop */ }
      };
    }
  } catch (e) { /* noop */ }
  return null;
}

function liveBegin(el) {
  const noBusy = /^(modal-bg|modal-close|nav|go)$/.test(String(el && el.getAttribute('data-act') || ''));
  if (el && !noBusy && !el.classList.contains('is-busy')) el.classList.add('is-busy');
  const restoreIcon = noBusy ? null : liveSpinIcon(el);
  LIVE_COUNT += 1;
  liveBar(true);
  const startedAt = Date.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    /* هر کنشی حداقل نیم‌ثانیه نشانگر داشته باشد تا کاربر ببیند کلیکش
       اثر کرده — نه اینکه صفرِ صفر ناپدید شود. */
    const wait = Math.max(0, 520 - (Date.now() - startedAt));
    const reveal = () => {
      LIVE_COUNT = Math.max(0, LIVE_COUNT - 1);
      if (!LIVE_COUNT) liveBar(false);
      if (restoreIcon) { try { restoreIcon(); } catch (e) { /* noop */ } }
      if (el && el.classList) {
        el.classList.remove('is-busy');
        el.classList.add('done-flash');
        setTimeout(() => { try { el.classList.remove('done-flash'); } catch (e) { /* noop */ } }, 450);
      }
    };
    if (wait) setTimeout(reveal, wait); else reveal();
  };
  /* اگر کنشی پنجره باز کند و منتظر کاربر بماند، نشانگر نباید تا ابد بچرخد */
  const guard = setTimeout(finish, 15000);
  return () => { clearTimeout(guard); finish(); };
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const done = liveBegin(el);
  /* بدنهٔ کنش همان‌جا و هم‌زمان اجرا می‌شود (مثل قبل) تا هیچ واکنشی
     عقب نیفتد؛ فقط نشانگر و خطاگیری اضافه شده است. */
  let running;
  try { running = handleActionClick(e, el); }
  catch (err) {
    try { console.error(err); } catch (x) { /* noop */ }
    toast('انجام نشد: ' + friendlyError(err), 'err');
  }
  Promise.resolve(running)
    .catch((err) => {
      try { console.error(err); } catch (x) { /* noop */ }
      toast('انجام نشد: ' + friendlyError(err), 'err');
    })
    .then(done, done);
});

async function handleActionClick(e, el) {
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  /* گارد کنش: کنش مدیریتی با نقش دیگر اجرا نمی‌شود (مثل p2) */
  if (typeof window.authzCanAct === 'function' && !window.authzCanAct(act, S.role || (S.user && S.user.role))) {
    toast('این کار برای نقش شما مجاز نیست', 'err');
    return;
  }
  /* کنش‌های برنامهٔ هفتگی (client/schedule.js) */
  if (window.SCHED_ACTIONS && typeof window.SCHED_ACTIONS[act] === 'function') {
    return window.SCHED_ACTIONS[act](el, id, e);
  }
  /* کنش‌های «سلامت داده» (client/diag.js) */
  if (window.DIAG_ACTIONS && typeof window.DIAG_ACTIONS[act] === 'function') {
    return window.DIAG_ACTIONS[act](el, id, e);
  }

  switch (act) {
    case 'modal-close': closeModal(); return;
    /* کلیک روی پس‌زمینهٔ تیره؛ اگر روی خودِ پنجره بزنند، بسته نمی‌شود */
    /* «قفل»: پنجره‌های حساس (مثل ورود اطلاعات) فقط با ✕ یا دکمهٔ خودشان
       بسته می‌شوند — کلیکِ accidentally بیرونِ کادر نباید همهٔ کار را پاک کند. */
    case 'modal-bg': if (e.target === el && el.getAttribute('data-lock') !== '1') closeModal(); return;
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
      const isStudent = u.role === 'student';
      const kidsParents = isStudent
        ? [...new Set(list('parent_links').filter(l => Number(l.student_id) === Number(u.id)).map(l => Number(l.parent_id)).filter(Boolean))]
            .map(pid => byId('users', pid)).filter(Boolean).map(p => p.name)
        : [];
      const msg = isStudent
        ? 'دانش‌آموز «' + u.name + '» حذف شود؟' + (kidsParents.length ? '\nولیِ او هم (' + kidsParents.join('، ') + ') اگر فرزند دیگری نداشته باشد حذف می‌شود.' : '') + '\nاین کار قابل بازگشت نیست.'
        : 'کاربر «' + u.name + '» حذف شود؟ این کار قابل بازگشت نیست.';
      if (!confirm(msg)) return;
      try {
        const removedParents = isStudent ? await deleteStudentWithParents(u.id) : [];
        if (!isStudent) await deleteUserEverywhere(u.id);
        if (S.picked) S.picked.delete(Number(u.id));
        saveCache(); render();
        await flushQueue();
        toast('کاربر حذف شد' + (removedParents.length ? ' · ولی هم حذف شد: ' + removedParents.join('، ') : ''), 'ok');
      } catch (e) { toast('حذف نشد: ' + friendlyError(e), 'err'); }
      return;
    }
    case 'pair-refresh': { await actPairCode(el.getAttribute('data-id'), true); return; }
    case 'scan-open': { location.hash = '#/scan'; return; }
    case 'scan-camera': {
      if (typeof window.scanNativeAvailable === 'function' && window.scanNativeAvailable()) {
        try { window.PayeshNative.scanQr(); return; } catch (e) { /* می‌رویم سراغ مرورگر */ }
      }
      if (typeof window.scanLiveCamera === 'function') window.scanLiveCamera();
      return;
    }
    case 'scan-gallery': {
      try {
        if (window.PayeshNative && window.PayeshNative.pickQr) { window.PayeshNative.pickQr(); return; }
      } catch (e) { /* بی‌صدا */ }
      if (typeof window.scanPickFile === 'function') window.scanPickFile(false);
      return;
    }
    case 'scan-stop': { if (typeof window.scanStopCamera === 'function') window.scanStopCamera(); return; }
    case 'user-full': { actUserFull(el.getAttribute('data-id')); return; }
    case 'user-creds': { actUserCreds(el.getAttribute('data-id')); return; }
    case 'creds-delete': {
      const cu = byId('users', Number(id));
      if (!cu) return;
      const isStu = cu.role === 'student';
      const kids = isStu
        ? [...new Set(list('parent_links').filter(l => Number(l.student_id) === Number(cu.id)).map(l => Number(l.parent_id)).filter(Boolean))]
            .map(pid => byId('users', pid)).filter(Boolean).map(p => fullName(p))
        : [];
      const msg = isStu
        ? 'دانش‌آموز «' + fullName(cu) + '» و حساب کاربری‌اش حذف شود؟' + (kids.length ? '\nولیِ او هم (' + kids.join('، ') + ') اگر فرزند دیگری نداشته باشد حذف می‌شود.' : '') + '\nاین کار قابل بازگشت نیست.'
        : 'حساب «' + fullName(cu) + '» حذف شود؟ این کار قابل بازگشت نیست.';
      if (!confirm(msg)) return;
      try {
        const removedParents = isStu ? await deleteStudentWithParents(cu.id) : [];
        if (!isStu) await deleteUserEverywhere(cu.id);
        if (S.picked) S.picked.delete(Number(cu.id));
        closeModal(); saveCache(); render();
        await flushQueue();
        toast('حساب حذف شد' + (removedParents.length ? ' · ولی هم حذف شد: ' + removedParents.join('، ') : ''), 'ok');
      } catch (e) { toast('حذف نشد: ' + friendlyError(e), 'err'); }
      return;
    }
    case 'user-pick-pw': {
      const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
      let out = '';
      for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
      const field = document.querySelector('form[data-form="user-creds"] input[name="password"]');
      if (field) { field.value = out; field.focus(); field.select(); }
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
        /* F‑01: رمز خام روی دیسک محلی نمی‌نشیند؛ فقط نمایشِ همان لحظه */
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
    case 'pair-here': {
      const code = pairCodeFromHash() || linkPairCode();
      if (!code) return toast('کد پیوند پیدا نشد — آن را دستی وارد کنید', 'err');
      return pairWithCode(code);
    }
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
    case 'update-now': await updOneClick(); return;
    case 'update-download': await updDownload(); return;
    case 'update-install': await updInstall(); return;
    case 'update-state': await loadUpdState(); render(); return;
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
    case 'issues-open': actImportIssues(); return;
    case 'issue-done': {
      const row = byId('import_issues', Number(id));
      if (!row) return;
      putLocal('import_issues', Object.assign({}, row, { status: 'done', closed_at: new Date().toISOString() }));
      saveCache(); render();
      toast('از فهرست پیگیری برداشته شد', 'ok');
      actImportIssues();
      await flushQueue();
      return;
    }
    case 'issue-fix': {
      const row = byId('import_issues', Number(id));
      if (!row) return;
      const d = row.data || {};
      /* فرم کاربر با همان اطلاعاتِ همان ردیف باز می‌شود */
      actUserAdd(Object.assign({}, d, {
        name: d.full_name || row.name || '',
        national_id: d.national_id || row.national_id || '',
        phone: d.phone || row.phone || '',
        role: d.role || 'student',
      }), Number(id));
      return;
    }
    case 'issues-clear': {
      const open = list('import_issues').filter(r => r.status !== 'done');
      if (!open.length) return actImportIssues();
      open.forEach(r => putLocal('import_issues', Object.assign({}, r, { status: 'done', closed_at: new Date().toISOString() })));
      saveCache(); render(); actImportIssues();
      toast(fa(open.length) + ' ردیف حل‌شده شد', 'ok');
      await flushQueue();
      return;
    }
    case 'import-back': {
      if (!S.imp) return;
      S.imp.step = Math.max(1, (S.imp.step || 1) - 1);
      renderImportStep();
      return;
    }
    case 'imp-branch-yes':
    case 'imp-branch-no': {
      /* تصمیم مدیر دربارهٔ رشتهٔ شبیه‌هم: ادغام فقط با تأیید او */
      const from = String(el.getAttribute('data-from') || '').trim();
      if (!from) return;
      S.impBranchAsk = S.impBranchAsk || {};
      S.impBranchAsk[from] = el.getAttribute('data-act') === 'imp-branch-yes'
        ? String(el.getAttribute('data-to') || '').trim() : '';
      S.imp.checks = impCheck();
      renderImportStep();
      return;
    }
    case 'imp-recheck': {
      if (!S.imp || !S.imp.rows) return;
      S.imp.checks = impCheck();
      renderImportStep();
      toast('دوباره بررسی شد', 'ok');
      return;
    }
    case 'import-check': {
      if (!S.imp || !S.imp.rows) return;
      S.impBranchAsk = {};                    /* تصمیم‌های فایل قبلی پاک می‌شود */
      S.imp.checks = impCheck();
      S.imp.step = 3;
      renderImportStep();
      return;
    }
    case 'import-apply': {
      if (!S.imp) return;
      const rows = (S.imp.checks || [])
        .filter(c => !(c.errors || []).length && !(c.blocks || []).length)
        .map(c => c.data);
      if (!rows.length) return toast('سطر سالمی برای ثبت نیست — اول ایرادها را اصلاح کنید', 'err');
      const kindImp = ['students', 'teachers', 'grades', 'attendance'].includes(S.imp.kind) ? S.imp.kind : 'students';
      const btn = el; btn.disabled = true;
      busyOverlay('در حال ثبت');
      try {
        await new Promise(r => setTimeout(r, 60));   /* فرصت نمایش نشانگر */
        let result;
        if (PHONE_MODE) {
          result = await importApplyLocal(rows, kindImp, (d, t) => busyUpdate(d, t));
        } else {
          try {
            const r = await api('/api/admin/import', { method: 'POST', body: { kind: kindImp, rows } });
            const cr = Number(r.created || 0), pr = Number(r.parents || 0);
            result = {
              created: cr, updated: Number(r.updated || 0),
              parents: pr, classes: Number(r.classes || 0),
              students: kindImp === 'students' ? Math.max(0, cr - pr) : 0,
              staff: kindImp === 'students' ? 0 : cr,
              marks: (kindImp === 'grades' || kindImp === 'attendance') ? cr : 0,
              errors: r.errors || [], warnings: r.warnings || [],
            };
          } catch (err) {
            /* اگر سیستم مدرسه پاسخ نداد، همان لحظه روی همین دستگاه ساخته
               می‌شوند و در صف می‌مانند تا برسد */
            result = await importApplyLocal(rows, kindImp, (d, t) => busyUpdate(d, t));
          }
          await pullAll().catch(() => {});
        }
        /* ردیف‌هایی که ساخته نشدند یا مشخصاتشان کامل نیست، برای پیگیری
           بعدی در یک فهرست جدا نگه داشته می‌شوند (صفحهٔ کاربران). */
        try {
          const saved = impSaveIssues(S.imp.checks || [], kindImp, S.imp.fileName, result.errors || []);
          S.impSavedIssues = saved.added;
        } catch (e) { S.impSavedIssues = 0; }

        S.imp.step = 4;
        S.imp.result = result;
        S.creds = undefined;   /* رمزهای تازه از سرور خوانده شوند */
        saveCache(); render(); renderImportStep();
        const unit = kindImp === 'grades' ? 'نمره' : kindImp === 'attendance' ? 'حضور' : 'کاربر';
        busyHide();
        toast(fa(result.created || 0) + ' ' + unit + ' ثبت شد'
          + (result.updated ? ' · ' + fa(result.updated) + ' به‌روزرسانی' : ''), (result.created || result.updated) ? 'ok' : 'err');
      } catch (err) {
        busyHide();
        toast('ثبت نشد: ' + friendlyError(err), 'err');
      } finally {
        busyHide();
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
        if (u.role === 'student') {
          /* ولی‌ها هم با دانش‌آموز می‌روند (اگر فرزند دیگری نداشته باشند) */
          await deleteStudentWithParents(idOne).catch(() => {
            removeLocal('users', idOne, { sync: !serverDone });
            if (S.data.users) S.data.users.delete(Number(idOne));
          });
        } else {
          removeLocal('users', idOne, { sync: !serverDone });
          if (S.data.users) S.data.users.delete(Number(idOne));
        }
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
    case 'mirror-refresh': await actMirrorRefresh(); return;
    case 'mirror-restore': await actMirrorRestore(); return;
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
      for (const u of kids) putLocal('users', Object.assign({}, u, {
        class_id: null, followup_reason: 'کلاس «' + c.name + '» حذف شد — کلاس تازه انتخاب کنید', followup_ack: false,
      }));
      removeLocal('classes', c.id);
      closeModal(); saveCache(); render();
      await flushQueue();
      toast('کلاس حذف شد', 'ok');
      return;
    }
    case 'class-merge': {
      /* کلاسِ بی‌پایه (که از رشته ساخته شده) را در کلاس درست ادغام می‌کند:
         دانش‌آموزان، نمرات، حضور و برنامهٔ آن منتقل می‌شوند. */
      const src = byId('classes', Number(id));
      if (!src) return;
      const sel = document.getElementById('merge-into-' + id);
      const dst = byId('classes', Number(sel && sel.value));
      if (!dst || Number(dst.id) === Number(src.id)) return toast('کلاس مقصد را انتخاب کنید', 'err');
      if (!confirm('کلاس «' + src.name + '» در «' + dst.name + '» ادغام شود؟ دانش‌آموزان و برنامه‌اش به کلاس مقصد منتقل می‌شوند.')) return;
      let moved = 0;
      for (const u of list('users').filter(x => Number(x.class_id) === Number(src.id))) {
        const patch = Object.assign({}, u, { class_id: dst.id });
        delete patch.followup_reason;
        patch.followup_ack = false;
        putLocal('users', patch);
        moved += 1;
      }
      for (const sg of list('schedule').filter(x => Number(x.class_id) === Number(src.id))) {
        const dup = list('schedule').find(x => Number(x.class_id) === Number(dst.id)
          && Number(x.weekday) === Number(sg.weekday) && Number(x.bell_order) === Number(sg.bell_order));
        if (dup) {
          for (const sb of (S.data.substitutions ? list('substitutions').filter(x => Number(x.schedule_id) === Number(sg.id)) : [])) removeLocal('substitutions', sb.id);
          removeLocal('schedule', sg.id);
        } else putLocal('schedule', Object.assign({}, sg, { class_id: dst.id }));
      }
      for (const g of list('grades').filter(x => Number(x.class_id) === Number(src.id))) putLocal('grades', Object.assign({}, g, { class_id: dst.id }));
      for (const a of list('attendance').filter(x => Number(x.class_id) === Number(src.id))) putLocal('attendance', Object.assign({}, a, { class_id: dst.id }));
      removeLocal('classes', src.id);
      saveCache(); render();
      await flushQueue();
      toast('کلاس ادغام شد' + (moved ? ' · ' + fa(moved) + ' دانش‌آموز منتقل شد' : ''), 'ok');
      return;
    }
    case 'room-add': actRoomAdd(); return;
    case 'room-edit': actRoomEdit(el.getAttribute('data-id')); return;
    case 'followup-assign': {
      /* دانش‌آموز ناقص: پایه و رشته را روی خودش می‌نشانیم. در رشته‌محور
         هیچ کلاسی ساخته نمی‌شود (کلاس دستی است)؛ در کلاس‌محور کلاسِ پایه
         ساخته/پیدا می‌شود چون کلاس همان پایه است. */
      const u = byId('users', Number(id));
      if (!u) return;
      const gSel = document.getElementById('fu-grade-' + id);
      const bSel = document.getElementById('fu-branch-' + id);
      const g = String((gSel && gSel.value) || '').trim();
      const b = String((bSel && bSel.value) || '').trim();
      if (!g) return toast('اول پایه را انتخاب کنید', 'err');
      const lvl = (typeof impGradeLevel === 'function') ? impGradeLevel(g) : 0;
      const patch = Object.assign({}, u, { grade: g, field: b || '' });
      if (lvl >= 10) {
        /* رشته‌محور: پایه + رشته کافی است */
        patch.class_id = null;
        if (b && typeof impEnsureLookup === 'function') impEnsureLookup('branch', b);
      } else {
        const cls = ensureGroup(g, '');
        if (cls) patch.class_id = cls.id;
      }
      delete patch.followup_reason;
      patch.followup_ack = false;
      putLocal('users', patch);
      saveCache(); render();
      await flushQueue();
      toast(lvl >= 10
        ? 'پایه و رشته ثبت شد' + (b ? ' — ' + g + ' ' + b : '')
        : ('در «' + ((byId('classes', patch.class_id) || {}).name || g) + '» ثبت شد'), 'ok');
      return;
    }
    case 'followup-ack': {
      /* مدیر می‌گوید همین‌طور بماند؛ دیگر در فهرست پیگیری نمی‌آید */
      const u = byId('users', Number(id));
      if (!u) return;
      putLocal('users', Object.assign({}, u, { followup_ack: true }));
      saveCache(); render();
      await flushQueue();
      toast('از فهرست پیگیری برداشته شد', 'ok');
      return;
    }
    case 'def-add': actDefAdd(el.getAttribute('data-kind'), el.getAttribute('data-name')); return;
    case 'def-edit': actDefEdit(id); return;
    case 'def-delete': {
      const r = byId('lookups', Number(id));
      if (!r) return;
      /* هنگام حذف می‌پرسیم: فقط خودش، یا کلاس‌هایش هم بروند، و تکلیف
         دانش‌آموزانِ آن کلاس‌ها چه شود. */
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
      const ids = new Set(linked.map(c => Number(c.id)));
      const students = list('users').filter(u => u.role === 'student' && ids.has(Number(u.class_id)));
      const nStu = students.length;
      S.modalTitle = 'حذف ' + label + ' — ' + r.name;
      modal(`<div class="small">این ${label} در <b>${fa(linked.length)} کلاس</b> استفاده شده است:
          ${esc(linked.map(c => c.name).slice(0, 8).join('، '))}${linked.length > 8 ? ' …' : ''}
        </div>
        ${nStu ? `<div class="small" style="margin-top:8px;color:#b45309">در این کلاس‌ها <b>${fa(nStu)} دانش‌آموز</b> هست. تکلیفشان چه شود؟</div>` : ''}
        <div class="small muted" style="margin-top:8px">یک گزینه را انتخاب کنید:</div>
        <button class="btn block" id="del-keep-students" data-act="def-delete-cascade" data-id="${r.id}" style="margin-top:10px">
          ${label} و ${fa(linked.length)} کلاسش حذف شوند — دانش‌آموزان بمانند و به «نیازمند پیگیری» بروند
        </button>
        ${nStu ? `<button class="btn block" id="del-drop-students" data-act="def-delete-students" data-id="${r.id}" style="margin-top:8px;background:#b91c1c;color:#fff">
          ${label}، ${fa(linked.length)} کلاس و ${fa(nStu)} دانش‌آموزش هم حذف شوند
        </button>` : ''}
        <button class="btn block ghost" data-act="def-delete-only" data-id="${r.id}" style="margin-top:8px">
          فقط ${label} از فهرست حذف شود (کلاس‌ها بمانند)
        </button>
        <button class="btn block ghost" data-act="modal-close" style="margin-top:8px">انصراف</button>
        <div class="small muted" style="margin-top:8px">دانش‌آموزانی که می‌مانند حذف نمی‌شوند؛ بی‌کلاس می‌شوند و در صفحهٔ «پیگیری» با دلیل مشخص می‌آیند تا کلاس تازه برایشان انتخاب کنید.</div>`);
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
      const reason = (r.kind === 'grade' ? 'پایهٔ «' : 'رشتهٔ «') + r.name + '» حذف شد — کلاس تازه انتخاب کنید';
      let removedClasses = 0, kept = 0;
      for (const c of linked) {
        for (const sg of list('schedule').filter(x => Number(x.class_id) === Number(c.id))) {
          /* جابه‌جای‌های موقت همان زنگ هم پاک می‌شوند */
          for (const sb of (S.data.substitutions ? list('substitutions').filter(x => Number(x.schedule_id) === Number(sg.id)) : [])) removeLocal('substitutions', sb.id);
          removeLocal('schedule', sg.id);
        }
        for (const u of list('users').filter(u2 => Number(u2.class_id) === Number(c.id))) {
          putLocal('users', Object.assign({}, u, { class_id: null, followup_reason: reason, followup_ack: false }));
          kept += 1;
        }
        removeLocal('classes', c.id);
        removedClasses += 1;
      }
      removeLocal('lookups', r.id);
      closeModal(); saveCache(); render();
      await flushQueue();
      toast((LOOKUP_FA[r.kind] || 'مورد') + ' و ' + fa(removedClasses) + ' کلاس حذف شد'
        + (kept ? ' · ' + fa(kept) + ' دانش‌آموز به «نیازمند پیگیری» رفت' : ''), 'ok');
      return;
    }
    case 'def-delete-students': {
      const r = byId('lookups', Number(id));
      if (!r) return;
      const linked = list('classes').filter(c => String(r.kind === 'grade' ? c.grade : c.branch || '') === String(r.name));
      const ids = new Set(linked.map(c => Number(c.id)));
      const students = list('users').filter(u => u.role === 'student' && ids.has(Number(u.class_id)));
      if (!confirm('«' + r.name + '» با ' + fa(linked.length) + ' کلاس و ' + fa(students.length) + ' دانش‌آموزش حذف شود؟ این کار برگشت‌پذیر نیست.')) return;
      let removedStudents = 0;
      for (const u of students) {
        for (const g of list('grades').filter(x => Number(x.student_id) === Number(u.id))) removeLocal('grades', g.id);
        for (const a of list('attendance').filter(x => Number(x.student_id) === Number(u.id))) removeLocal('attendance', a.id);
        for (const l of list('parent_links').filter(x => Number(x.student_id) === Number(u.id))) removeLocal('parent_links', l.id);
        removeLocal('users', u.id);
        removedStudents += 1;
      }
      for (const c of linked) {
        for (const sg of list('schedule').filter(x => Number(x.class_id) === Number(c.id))) removeLocal('schedule', sg.id);
        removeLocal('classes', c.id);
      }
      removeLocal('lookups', r.id);
      closeModal(); saveCache(); render();
      await flushQueue();
      toast(fa(removedStudents) + ' دانش‌آموز و ' + fa(linked.length) + ' کلاس حذف شد', 'ok');
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
    case 'settings-save': {
      const name = ($('#set-name') || {}).value || '';
      try { await api('/api/admin/settings', { method: 'POST', body: { name } }); toast('ذخیره شد', 'ok'); await start(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
  }
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el || !el.hasAttribute || !el.hasAttribute('data-digits')) return;
  const v = digitsOnly(el.value);
  if (v !== el.value) el.value = v;
});

/* ══════════ تشخیص کامل کاربر تکراری (هم‌قاعده با 42-self-diagnostics) ══════════
   یک نفر ممکن است به چهار شکل تکرار شود: کد ملی یکسان، شمارهٔ همراه یکسان
   (که نام کاربری است)، نام یکسان + تاریخ تولد/نام پدر/شمارهٔ همراه، و نام
   نزدیک با مشخصات یکسان. */
function userNameKey(n) {
  return String(n || '').toLowerCase()
    .replace(/[يىئ]/g, 'ی').replace(/ك/g, 'ک').replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و').replace(/[ةۀ]/g, 'ه')
    .replace(/[\u064B-\u0652\u0640\u200c]/g, ' ')
    .replace(/\b(سید|سیده|میر|آقا|خانم|جناب|سرکار)\b/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function userDobKey(v) {
  const d = impAnyDate ? impAnyDate(v || '') : String(v || '');
  return String(d || '').slice(0, 10);
}
function findUserDuplicates(row, exceptId) {
  const nid = digitsOnly(row.national_id || '');
  const phone = digitsOnly(row.phone || '');
  const nk = userNameKey(row.name);
  const dob = userDobKey(row.birth_date);
  const father = userNameKey(row.father_name || '');
  const out = { nid: [], phone: [], person: [] };
  list('users').forEach(u => {
    if (exceptId && Number(u.id) === Number(exceptId)) return;
    const un = digitsOnly(u.national_id || '');
    const up = digitsOnly(u.phone || '');
    if (nid && un === nid) { out.nid.push(u); return; }
    if (phone && up === phone) { out.phone.push(u); return; }
    if (!nk || userNameKey(u.name) !== nk) return;
    const sameDob = dob && userDobKey(u.birth_date) === dob;
    const sameFather = father && userNameKey(u.father_name || '') === father;
    const samePhone = phone && up === phone;
    if (sameDob || sameFather || samePhone) out.person.push(u);
  });
  return out;
}
function userDupLabel(u) {
  const bits = [esc(u.name)];
  if (u.role && typeof ROLE_FA !== 'undefined' && ROLE_FA[u.role]) bits.push(ROLE_FA[u.role]);
  if (u.class_id) { try { bits.push(esc(className(u.class_id))); } catch (e) { /* بی‌صدا */ } }
  if (u.phone) bits.push(esc(u.phone));
  return bits.join(' · ');
}
function userDupBanner(f, matched) {
  const list_ = matched.slice(0, 4).map(userDupLabel).join(' | ');
  let box = document.getElementById('user-dup-warn');
  if (!box) {
    box = document.createElement('div');
    box.id = 'user-dup-warn';
    box.className = 'banner info';
    box.style.cssText = 'margin:0 0 10px;display:block';
    const host = (f && f.parentNode) || document.getElementById('modal-root') || document.body;
    if (host) host.insertBefore(box, host.firstChild);
  }
  box.innerHTML = `<div>⚠️ کاربری با همین مشخصات هست: <b>${list_}</b>.`
    + ' اگر همان شخص است، همان را ویرایش کنید. اگر مطمئنید شخص دیگری است، دوباره «ثبت» را بزنید.</div>';
}

/* حذف دانش‌آموز: پیوندهای ولی پاک و ولی‌هایی که فرزند دیگری ندارند هم حذف می‌شوند. */
async function deleteStudentWithParents(studentId) {
  const id = Number(studentId);
  const links = list('parent_links').filter(l => Number(l.student_id) === id);
  const parentIds = [...new Set(links.map(l => Number(l.parent_id)).filter(Boolean))];
  await deleteUserEverywhere(id);
  if (S.data.users) S.data.users.delete(Number(id));
  for (const l of links) {
    removeLocal('parent_links', l.id, { sync: true });
    if (S.data.parent_links) S.data.parent_links.delete(Number(l.id));
  }
  const removedNames = [];
  for (const pid of parentIds) {
    const stillHas = list('parent_links').some(l => Number(l.parent_id) === pid);
    const pu = byId('users', pid);
    if (stillHas || !pu) continue;
    await deleteUserEverywhere(pid);
    if (S.data.users) S.data.users.delete(Number(pid));
    removedNames.push(pu.name);
  }
  return removedNames;
}

/* گروه ثبت‌نام = پایه + رشته. در متوسطهٔ دوم همین کافی است؛ «کلاس/اتاق»
   فقط در برنامهٔ هفتگی تعیین می‌شود، نه در بخش کاربران. */
function ensureGroup(grade, branch) {
  const g = String(grade || '').trim();
  const b = String(branch || '').trim();
  if (!g) return null;
  const lvl = (typeof impGradeLevel === 'function') ? impGradeLevel(g) : 0;
  const mode = lvl >= 10 ? 'field' : 'class';
  const br = mode === 'field' ? b : '';
  const name = (g + (br ? ' ' + br : '')).trim();
  const found = list('classes').find(c => String(c.name || '').trim() === name);
  if (found) return found;
  if (br && typeof impEnsureLookup === 'function') impEnsureLookup('branch', br);
  return putLocal('classes', { name, grade: g, branch: br, mode, grade_level: lvl, kind: 'class', capacity: 30, school_id: 1 });
}

/* فرم‌ها هم همان واکنش زنده را دارند: دکمهٔ ثبت بی‌درنگ نشانگر می‌گیرد */
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"], button:not([type])');
  const done = liveBegin(btn || form);
  let running;
  try { running = handleSubmit(form); }
  catch (err) {
    try { console.error(err); } catch (x) { /* noop */ }
    toast('انجام نشد: ' + friendlyError(err), 'err');
  }
  Promise.resolve(running)
    .catch((err) => {
      try { console.error(err); } catch (x) { /* noop */ }
      toast('انجام نشد: ' + friendlyError(err), 'err');
    })
    .then(done, done);
});

async function handleSubmit(form) {
  const kind = form.getAttribute('data-form');
  const f = form.elements;
  /* فرم‌های برنامهٔ هفتگی (client/schedule.js) */
  if (window.SCHED_FORMS && typeof window.SCHED_FORMS[kind] === 'function') {
    return window.SCHED_FORMS[kind](f, form);
  }

  if (kind === 'scan-code') {
    const code = String((f.code && f.code.value) || '').trim();
    if (!code) { toast('کد کارت را بزنید', 'err'); return; }
    await window.scanPairWithCode(code);
    return;
  }
  if (kind === 'setup') return doSetup(f);
  if (kind === 'pair') return doPair(f);
  if (kind === 'login') return doLogin(f);
  if (kind === 'phone-login') return doPhoneLogin(f);
  if (kind === 'claim') return doClaim(f);
  if (kind === 'unlock') return doUnlock(f);
  if (kind === 'transfer') return doTransfer(f);

  if (kind === 'class') {
    const recKind = String((f.kind && f.kind.value) || 'group');
    const idc = f.id ? Number(f.id.value) : 0;
    if (recKind === 'room') {
      const roomName = String(f.name.value || '').trim();
      if (!roomName) return toast('نام کلاس/کارگاه را بنویسید', 'err');
      const clash = list('classes').find(c => Number(c.id) !== idc && impNorm(c.name) === impNorm(roomName));
      if (clash) return toast('این نام قبلاً ثبت شده: «' + clash.name + '»', 'err');
      if (idc) putLocal('classes', Object.assign({}, byId('classes', idc) || {}, { id: idc, name: roomName, kind: 'room' }));
      else putLocal('classes', { name: roomName, kind: 'room', school_id: 1 });
      closeModal(); saveCache(); render();
      await flushQueue();
      toast(idc ? 'ذخیره شد' : 'کلاس/کارگاه اضافه شد', 'ok');
      return;
    }
    const grade = String((f.grade && f.grade.value) || '').trim();
    let branch = String((f.branch && f.branch.value) || '').trim();
    if (!grade) return toast('پایه را انتخاب کنید — هر کلاس یک پایه دارد', 'err');
    /* پایه همیشه یکی از اول…دوازدهم است؛ رشته جای پایه نمی‌نشیند */
    const level = impGradeLevel(grade);
    if (!level) {
      return toast('«' + grade + '» پایه نیست — پایه یکی از اول تا دوازدهم است. رشته را در کادر رشته بنویسید.', 'err');
    }
    if (branch && userNameKey(grade) === userNameKey(branch)) {
      return toast('پایه و رشته یکی شده‌اند — رشته («' + branch + '») را در کادر پایه نوشته‌اید؛ پایه را اصلاح کنید', 'err');
    }
    const modeRaw = String((f.mode && f.mode.value) || '').trim();
    const mode = modeRaw || (level >= 10 ? 'field' : 'class');
    if (mode === 'field' && !branch) return toast('کلاس رشته‌محور باید رشته داشته باشد (مثل «دهم الکترونیک»)', 'err');
    if (mode === 'class' && branch) {
      return toast('کلاس کلاس‌محور رشته ندارد — یا نوع چیدمان را «رشته‌محور» کنید یا رشته را خالی بگذارید', 'err');
    }
    if (mode === 'class') branch = '';
    const room = String((f.room && f.room.value) || '').trim();
    /* نام کلاس: کلاس‌محور = پایه + نام ویژه؛ رشته‌محور = پایه + رشته */
    const name = String(f.name.value || '').trim() || (grade + (branch ? ' ' + branch : '')).trim();
    const id = f.id ? Number(f.id.value) : 0;
    const dup = list('classes').find(c => String(c.name).trim() === name && Number(c.id) !== id);
    if (dup) return toast('کلاسی با همین نام هست: «' + dup.name + '»', 'err');
    const row = {
      name, grade, branch, mode, grade_level: level, kind: 'class',
      capacity: Number((f.capacity && f.capacity.value) || 30),
      teacher_id: Number((f.teacher_id && f.teacher_id.value) || 0) || null,
      school_id: 1,
    };
    if (id) {
      const cur = byId('classes', id) || {};
      putLocal('classes', Object.assign({}, cur, row, { id }));
      /* کلاس درست شد ⇒ دانش‌آموزانش از «نیازمند پیگیری» بیرون می‌آیند */
      for (const u of list('users').filter(x => Number(x.class_id) === id)) {
        if (!u.followup_reason && !u.followup_ack) continue;
        const patch = Object.assign({}, u);
        delete patch.followup_reason;
        patch.followup_ack = false;
        putLocal('users', patch);
      }
    } else {
      putLocal('classes', row);
    }
    /* دانش‌آموزانی که پایه و رشته‌شان با همین کلاس یکی است و هنوز کلاس
       ندارند، خودکار به آن وصل می‌شوند — همان‌هایی که از اکسل آمده‌اند و
       منتظر ساخت دستی کلاس بودند. */
    let joined = 0;
    for (const u of list('users')) {
      if (u.role !== 'student' || Number(u.class_id)) continue;
      const ug = String(u.grade || '').trim();
      const ub = String(u.field || u.branch || '').trim();
      if (impNorm(ug) !== impNorm(grade)) continue;
      if (mode === 'field' && impNorm(ub) !== impNorm(branch)) continue;
      if (mode === 'class' && impNorm(name) !== impNorm(grade + ' ' + ub) && ub) continue;
      const patch = Object.assign({}, u, { class_id: id || (list('classes').find(c => c.name === name) || {}).id });
      if (!patch.class_id) continue;
      delete patch.followup_reason;
      putLocal('users', patch);
      joined += 1;
    }
    closeModal(); saveCache(); render();
    await flushQueue();
    toast((id ? 'کلاس ویرایش شد' : 'کلاس ساخته شد') + (joined ? ' · ' + fa(joined) + ' دانش‌آموز به آن وصل شد' : ''), 'ok');
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
  if (kind === 'imp-fix') {
    const idx = Number(form.getAttribute('data-idx'));
    if (!S.imp || !isFinite(idx)) return;
    const edits = Object.assign({}, S.imp.edits || {});
    const cur = Object.assign({}, edits[idx] || {});
    Array.prototype.forEach.call(form.querySelectorAll('[name]'), inp => {
      const v = String(inp.value == null ? '' : inp.value).trim();
      if (v === '') delete cur[inp.name]; else cur[inp.name] = v;
    });
    edits[idx] = cur;
    S.imp.edits = edits;
    S.imp.checks = impCheck();          /* همه‌چیز از نو بررسی می‌شود */
    const row = (S.imp.checks || []).find(c => Number(c.idx) === idx);
    renderImportStep();
    if (row && !(row.errors || []).length && !(row.blocks || []).length) toast('اصلاح شد و به «آمادهٔ ثبت» رفت ✅', 'ok');
    else if (row) toast('ذخیره شد — هنوز ' + fa((row.errors || []).length + (row.blocks || []).length) + ' مورد مانده', 'err');
    return;
  }
  if (kind === 'import-file') {
    /* پایه‌های این فایل (پرسش مرحلهٔ ۱) */
    let pickedGrades = [];
    try {
      const boxes = form.querySelectorAll('input[name="imp-grade"]');
      pickedGrades = Array.prototype.slice.call(boxes).filter(b => b.checked).map(b => String(b.value));
      S.imp = S.imp || {};
      S.imp.grades = pickedGrades;
      /* جدا از S.imp نگه داشته می‌شود تا با رفتن به مرحلهٔ بعد گم نشود */
      S.impGrades = pickedGrades;
    } catch (e) { /* بی‌صدا */ }
    const entityNow = ['students', 'teachers', 'grades', 'attendance'].indexOf(f.kind && f.kind.value) > -1 ? f.kind.value : 'students';
    /* بدون پایه، دانش‌آموز ساخته نمی‌شود: مرحلهٔ بعد باز نمی‌شود */
    if (entityNow === 'students' && !pickedGrades.length) {
      toast('اول پایه را انتخاب کنید — بدون پایه، دانش‌آموز و کلاسش ساخته نمی‌شود', 'err');
      const hint = form.querySelector('[data-imp-grade-hint]');
      if (hint) hint.style.display = 'block';
      return;
    }
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
    const phone = mobile11(f.phone ? f.phone.value : '');
    if (nid && !impValidNid(nid)) return toast('کد ملی باید دقیقاً ۱۰ رقم باشد', 'err');
    if (String(digitsOnly(f.phone ? f.phone.value : '')).trim() && !/^09\d{9}$/.test(phone)) {
      return toast('شمارهٔ همراه «' + String(f.phone.value).trim() + '» درست نیست — باید ۱۱ رقم و با ۰۹ شروع شود', 'err');
    }
    const dupRow = {
      name, national_id: nid, phone,
      birth_date: impAnyDate((f.birth_date && f.birth_date.value) || ''),
      father_name: String((f.father_name && f.father_name.value) || '').trim(),
    };
    const dup = findUserDuplicates(dupRow, 0);
    if (dup.nid.length) return toast('این کد ملی برای «' + dup.nid[0].name + '» ثبت شده است — همان شخص است؛ به‌جای ساختن کاربر تازه، همان را ویرایش کنید', 'err');
    if (dup.phone.length) return toast('این شمارهٔ همراه برای «' + dup.phone[0].name + '» ثبت شده است — همان شخص است؛ همان را ویرایش کنید', 'err');
    const dupKey = userNameKey(name) + '|' + phone + '|' + dupRow.birth_date;
    if (dup.person.length && S.userDupOk !== dupKey) {
      S.userDupOk = dupKey;
      userDupBanner(form, dup.person);
      return;
    }
    S.userDupOk = null;
    const warnBox = document.getElementById('user-dup-warn');
    if (warnBox) warnBox.remove();

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
    USER_EXTRA_FORM.forEach(([k]) => {
      if (!f[k]) return;
      const raw = String(f[k].value || '').trim();
      if (!raw) return;
      /* شماره‌های همراهِ خانواده هم با صفرِ اول ذخیره می‌شوند */
      row[k] = /_phone$/.test(k) ? (mobile11(raw) || raw) : raw;
    });
    const created = putLocal('users', row);
    /* ولی: حساب ولی ساخته و به دانش‌آموز وصل می‌شود */
    const pName = String((f.parent_name && f.parent_name.value) || '').trim();
    const pPhone = mobile11((f.parent_phone && f.parent_phone.value) || '');
    if (role === 'student' && (pName || pPhone)) {
      const existing = pPhone ? list('users').find(u => u.role === 'parent' && digitsOnly(u.phone || '') === pPhone) : null;
      const parent = existing || putLocal('users', { name: pName || ('ولی ' + name), role: 'parent', phone: pPhone, active: 1, school_id: 1 });
      putLocal('parent_links', { parent_id: parent.id, student_id: created.id, relation: 'father' });
    }
    S.creds = undefined;      /* فهرست رمزها تازه شود */
    /* اگر از فهرست «نیازمند پیگیری» آمده بودیم، آن ردیف حل‌شده می‌شود */
    if (S.fixIssueId) {
      const issue = byId('import_issues', Number(S.fixIssueId));
      if (issue) putLocal('import_issues', Object.assign({}, issue, { status: 'done', closed_at: new Date().toISOString() }));
      S.fixIssueId = null;
    }
    closeModal(); saveCache(); render();
    await flushQueue();
    await pullAll().catch(() => {});

    /* کارت ورود: نام کاربری و رمز، تا مدیر همان‌جا به کاربر بگوید */
    /* نام کاربری = شمارهٔ همراه، و اگر شماره نبود = کد ملی (همان قاعدهٔ سرور) */
    const shownUser = phone || nid || 'ثبت نشده';
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
        <div class="row between"><span class="muted">نام کاربری ${phone ? '(شمارهٔ همراه)' : nid ? '(کد ملی)' : '(شمارهٔ همراه)'}</span><b class="ltr">${esc(shownUser)}</b></div>
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
  if (kind === 'user-full') {
    const uid = Number(f.id.value);
    const u = byId('users', uid);
    if (!u) return toast('کاربر پیدا نشد — صفحه را تازه کنید', 'err');
    const patch = Object.assign({}, u);
    const take = k => {
      if (!f[k]) return;
      const v = String(f[k].value || '').trim();
      if (v) patch[k] = v; else if (patch[k]) patch[k] = '';
    };
    ['name', 'last_name', 'national_id', 'phone', 'birth_date', 'gender'].forEach(take);
    (typeof IMP_EXTRA_FIELDS !== 'undefined' ? IMP_EXTRA_FIELDS : []).forEach(take);
    ['phone', 'father_phone', 'mother_phone', 'guardian_phone'].forEach(k => {
      if (patch[k]) patch[k] = mobile11(patch[k]);
    });
    if (patch.national_id) patch.national_id = digitsOnly(patch.national_id);
    if (patch.phone) {
      const clash = list('users').find(x => Number(x.id) !== uid && digitsOnly(x.phone || '') === patch.phone);
      if (clash) return toast('این شماره برای «' + clash.name + '» ثبت شده است', 'err');
    }
    putLocal('users', patch);
    /* هر تغییری در مشخصات پدر/مادر، روی حساب خودِ ولی هم می‌نشیند */
    if (u.role === 'student') {
      const relMap = [['پدر', 'father_name', 'father_phone'], ['مادر', 'mother_name', 'mother_phone']];
      for (const l of list('parent_links').filter(x => Number(x.student_id) === uid)) {
        const hit = relMap.find(r => String(l.relation || '') === r[0]);
        if (!hit) continue;
        const pu = byId('users', Number(l.parent_id));
        if (!pu) continue;
        const pp = Object.assign({}, pu);
        if (patch[hit[1]]) pp.name = patch[hit[1]];
        if (patch[hit[2]]) pp.phone = digitsOnly(patch[hit[2]]);
        putLocal('users', pp);
      }
    }
    closeModal(); saveCache(); render();
    await flushQueue();
    toast('مشخصات ذخیره شد' + (u.role === 'student' ? ' — حساب ولی هم به‌روز شد' : ''), 'ok');
    return;
  }

  if (kind === 'user-creds') {
    const uidNum = Number(f.id.value);
    const u = byId('users', uidNum);
    if (!u) return toast('این کاربر پیدا نشد — صفحه را تازه کنید', 'err');
    const phone = digitsOnly(f.phone.value);
    const pass = String(f.password.value || '').trim();
    if (phone && phone.length < 10) return toast('شمارهٔ همراه کامل نیست (۱۱ رقم)', 'err');
    if (pass && pass.length < 4) return toast('رمز عبور حداقل ۴ نویسه باشد', 'err');
    if (phone) {
      const clash = list('users').find(x => Number(x.id) !== uidNum && digitsOnly(x.phone || '') === phone);
      if (clash) return toast('این شماره برای «' + fullName(clash) + '» ثبت شده است', 'err');
    }
    const patch = { phone };
    if (pass) patch.password = pass;
    if (!PHONE_MODE) {
      try {
        const r = await api('/api/admin/users/' + uidNum, { method: 'PATCH', body: patch });
        if (!r.ok) throw new Error(r.error === 'duplicate_phone' ? 'این شماره برای «' + (r.name || 'کاربر دیگر') + '» ثبت شده' : (r.error || 'خطا'));
      } catch (e) {
        const code = String((e && (e.message || e)) || '');
        if (!(e && e.status === 404) && !/not_found/.test(code)) return toast('ذخیره نشد: ' + friendlyError(e), 'err');
      }
    }
    putLocal('users', Object.assign({}, u, { phone }, pass ? { password_hash: 'set' } : {}));
    if (PHONE_MODE && pass) {
      try {
        await window.PayeshPhone.send({
          uid: 'pw-' + uid(), user_id: S.user.id, role: S.role,
          op: { collection: 'users', type: 'put', id: uidNum, data: { __password_verifier: makeVerifier(pass) }, base_version: 0 },
        });
      } catch (e) { /* آفلاین — در صف می‌ماند */ }
    }
    S.creds = undefined;
    closeModal();
    saveCache(); render();
    await flushQueue();
    if (!PHONE_MODE) await pullAll().catch(() => {});
    toast('کاربری ذخیره شد' + (pass ? ' — رمز تازه: ' + pass : ''), 'ok');
    render();
    return;
  }

  if (kind === 'user-edit') {
    let id = Number(f.id.value);
    const u = byId('users', id);
    if (!u) return toast('این کاربر پیدا نشد — صفحه را تازه کنید', 'err');
    const phone = digitsOnly(f.phone.value);
    if (phone && phone.length < 10) return toast('شمارهٔ همراه کامل نیست', 'err');
    if (phone) {
      const clash = list('users').find(x => Number(x.id) !== Number(id) && digitsOnly(x.phone || '') === phone);
      if (clash) return toast('این شمارهٔ همراه برای «' + clash.name + '» ثبت شده است — دو کاربر نمی‌توانند یک نام کاربری داشته باشند', 'err');
    }
    const password = String(f.password.value || '');
    const patch = { name: String(f.name.value || '').trim() || u.name, phone, active: f.active.checked };
    if (f.birth_date) patch.birth_date = impAnyDate(f.birth_date.value || '');
    if (f.gender) patch.gender = String(f.gender.value || '').trim();
    /* فیلدهای تکمیلیِ فرم (پدر و مادر، نشانی، معدل، حمایتی، …) */
    USER_EXTRA_FORM.forEach(([k]) => {
      if (!f[k]) return;
      const v = String(f[k].value || '').trim();
      if (v) patch[k] = v; else if (u[k]) patch[k] = '';
    });
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
}
