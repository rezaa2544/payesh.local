/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال — هستهٔ کلاینت (بدون چارچوب، بدون CDN)
   ذخیره‌سازی: IndexedDB برای داده + localStorage برای توکن/صف
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

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
  tempId: -1,
  syncing: false,
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
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.session) headers.authorization = 'Bearer ' + S.session;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = { ok: false, error: 'bad_response' }; }
  if (res.status === 401 && !opts.noAuthRedirect) { lockApp(); }
  if (!res.ok || data.ok === false) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.data = data; err.status = res.status;
    throw err;
  }
  return data;
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
    /* آفلاین یا خطای موقت: صف می‌ماند */
  } finally {
    S.syncing = false;
  }
  return { pushed };
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

async function syncNow(silent = true) {
  if (!S.online) { if (!silent) toast('اینترنت/شبکه در دسترس نیست — تغییرات در صف می‌مانند', 'err'); return; }
  try {
    await flushQueue();
    await pullAll();
    if (!silent) toast('همگام‌سازی انجام شد', 'ok');
    render();
  } catch (e) {
    if (!silent) toast('همگام‌سازی ناموفق: ' + e.message, 'err');
  }
}

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
  }
  return row;
}
function removeLocal(collection, id, { sync = true } = {}) {
  const m = S.data[collection];
  if (m) m.delete(Number(id));
  if (sync && Number(id) > 0) {
    S.queue.push({ uid: uid(), collection, type: 'del', id: Number(id), at: new Date().toISOString() });
    saveQueue();
  }
  return true;
}

/* ── کاربر و نشست ───────────────────────────────────────────────── */
function saveSession(token) { S.session = token; localStorage.setItem('payesh.session', token); }
function saveDevice(token) { S.deviceToken = token; localStorage.setItem('payesh.device', token); }

function lockApp() {
  S.session = ''; localStorage.removeItem('payesh.session');
  S.user = null; S.role = null;
  renderLock();
}

async function doSetup(form) {
  const body = {
    school_name: form.school_name.value.trim(),
    manager_name: form.manager_name.value.trim(),
    phone: form.phone.value.trim(),
    pin: form.pin.value.trim(),
    school_type: form.school_type.value,
    school_year: form.school_year.value.trim(),
  };
  if (!/^\d{4,6}$/.test(body.pin)) return toast('PIN باید ۴ تا ۶ رقم باشد', 'err');
  try {
    const r = await api('/api/setup', { method: 'POST', body });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    await start();
  } catch (e) { toast('راه‌اندازی ناموفق: ' + e.message, 'err'); }
}

async function doPair(form) {
  const code = form.code.value.trim();
  const pin = form.pin.value.trim();
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

/* ثبت درخواست در صف ابری (وقتی سیستم مدرسه در دسترس نیست) */
async function queueLeaveToHub(studentId, row) {
  const hub = S.hub || {};
  const child = (hub.children || []).find(c => Number(c.student_id) === Number(studentId));
  if (!hub.enabled || !hub.url || !child) return false;
  try {
    const res = await fetch(hub.url.replace(/\/+$/, '') + '/v1/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + child.token },
      body: JSON.stringify({
        uid: row.uid || ('leave-' + studentId + '-' + row.date),
        kind: 'leave',
        payload: { date: row.date, reason: row.reason },
      }),
    });
    const out = await res.json();
    return !!out.ok;
  } catch (e) { return false; }
}

async function doTransfer(form) {
  const code = form.code.value.trim();
  const pin = form.pin.value.trim();
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
  const pin = form.pin.value.trim();
  try {
    const r = await api('/api/auth/unlock', { method: 'POST', body: { device_token: S.deviceToken, pin } });
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    await start();
  } catch (e) {
    if (e.message === 'device_unknown' || e.message === 'user_inactive') {
      localStorage.removeItem('payesh.device');
      S.deviceToken = '';
      toast('دستگاه ثبت نشده — با کارت پیوند وارد شوید', 'err');
      renderPair();
      return;
    }
    toast('PIN نادرست است', 'err');
    const inp = $('#pin'); if (inp) { inp.value = ''; inp.focus(); }
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
async function start() {
  try {
    const boot = await api('/api/bootstrap');
    S.boot = boot; S.user = boot.user; S.role = boot.role;
    S.hub = boot.hub || { enabled: false };
    S.server = Object.assign({}, S.server, {
      ok: true, version: boot.version, school: boot.school, setupDone: true,
      publicUrl: boot.public_url || S.server.publicUrl || null,
    });
    S.clockOffset = new Date(boot.server_time).getTime() - Date.now();
    const cached = await idbGet('data');
    if (cached) {
      S.data = {};
      for (const c of Object.keys(cached)) S.data[c] = new Map(cached[c].map(r => [Number(r.id), r]));
    }
    try { await pullAll(); await flushQueue(); S.hubOffline = false; }
    catch (e) { /* آفلاین: با کش ادامه می‌دهیم */ await tryCloudFallback(); }
    if (S.hub && S.hub.enabled && (S.role === 'parent' || S.role === 'student')) {
      /* بی‌صدا و در پس‌زمینه، تازه‌ترین نمای ابری را هم بگیر */
      loadHub(true).then(() => { if (S.role === 'parent' && S.route === 'home') render(); });
    }
    routeFromHash();
    render();
    scheduleSync();
    checkUpdate(true);
  } catch (e) {
    toast('اتصال به سرور برقرار نشد: ' + e.message, 'err');
    renderLock();
  }
}

let syncTimer = null, updateTimer = null;
function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (S.online && S.session) syncNow(true); }, 90_000);
  /* بررسی دوره‌ای آپدیت — سبک و بی‌صدا */
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => { if (S.online) checkUpdate(true); }, 5 * 60_000);
}
window.addEventListener('online', () => { S.online = true; syncNow(true); if (S.session) checkUpdate(true); render(); });
window.addEventListener('offline', () => { S.online = false; render(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.session) return;
  syncNow(true);
  checkUpdate(true);          /* هر بار که کاربر برمی‌گردد: نسخه چک می‌شود */
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

/* ── Hub ابری: خواندن نمای خانواده وقتی مدرسه خاموش است ─────────── */
async function loadHub(silent = true) {
  const hub = S.hub || {};
  if (!hub.enabled || !hub.url || !(hub.children || []).length) return null;
  S.hubData = S.hubData || {};
  let ok = 0;
  for (const child of hub.children) {
    try {
      const res = await fetch(hub.url.replace(/\/+$/, '') + '/v1/family', {
        headers: { authorization: 'Bearer ' + child.token },
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.ok) { S.hubData[Number(child.student_id)] = data; ok++; }
    } catch (e) { /* ابر هم در دسترس نیست */ }
  }
  S.hubOffline = ok === 0;
  if (!silent) toast(ok ? 'وضعیت از ابر به‌روز شد' : 'دسترسی به ابر ممکن نشد', ok ? 'ok' : 'err');
  return ok;
}

/* اگر سیستم مدرسه جواب نداد، از ابر بخوان */
async function tryCloudFallback() {
  const hub = S.hub || {};
  if (!hub.enabled) return false;
  const n = await loadHub(true);
  if (n) { S.hubOffline = true; render(); return true; }
  return false;
}

/* ── وضعیت شبکه/تونل (فقط مدیر) ─────────────────────────────────── */
async function loadNetwork(force) {
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
function render() {
  const root = $('#app');
  if (!root) return;
  if (!S.session || !S.user) return;
  const page = (window.PAGES && window.PAGES[S.route]) || null;
  const view = page ? page(S.params) : `<div class="card"><h3>صفحه پیدا نشد</h3><p class="muted">مسیر «${esc(S.route)}» وجود ندارد.</p></div>`;
  root.innerHTML = shellHtml(view);
  /* بارگذاری تنبل وضعیت شبکه در صفحهٔ «شبکه» */
  if (S.route === 'network' && S.role === 'manager' && !S.network && !S._netLoading) {
    S._netLoading = true;
    loadNetwork(false).then(() => { S._netLoading = false; if (S.route === 'network') render(); });
  }
  updateTopChrome();
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
async function boot() {
  try {
    const [health, setup] = await Promise.all([
      fetch('/api/health', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      fetch('/api/setup/state', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
    ]);
    if (!health || !health.ok) { renderOffline(); return; }
    S.server = {
      ok: true, version: health.version, school: health.school,
      setupDone: !!(setup && !setup.needs_setup),
      publicUrl: health.public_url || null, instance: health.instance || null,
    };
    if (health.server_time) S.clockOffset = new Date(health.server_time).getTime() - Date.now();
    if (!S.server.setupDone) { renderSetup(); return; }
    const tr = String(location.hash || '').match(/^#\/transfer\/([A-Za-z0-9_-]+)/);
    if (tr) { renderTransfer(tr[1]); return; }
    if (S.deviceToken) renderLock();
    else renderPair();
  } catch (e) {
    renderOffline();
  }
}
document.addEventListener('DOMContentLoaded', boot);

/* ═══════════════════════════════════════════════════════════════════
   کنش‌ها و فرم‌ها — واگذاری رویداد (بدون inline handler جز چند مورد)
   ═══════════════════════════════════════════════════════════════════ */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');

  switch (act) {
    case 'modal-close': closeModal(); return;
    case 'retry': boot(); return;
    case 'forget-device':
      localStorage.removeItem('payesh.device'); localStorage.removeItem('payesh.session');
      S.deviceToken = ''; S.session = ''; S.user = null; S.role = null;
      renderPair(); return;
    case 'lock': lockApp(); return;
    case 'sync': await syncNow(false); return;
    case 'net-refresh': await loadNetwork(true); render(); return;
    case 'hub-load': await loadHub(false); render(); return;
    case 'hub-sync': {
      try {
        const r = await api('/api/admin/hub/sync', { method: 'POST', body: { force: true } });
        const p = r.push || {}, d = r.drain || {};
        toast('ارسال: ' + fa(p.sent || 0) + ' · دریافت: ' + fa(d.fetched || 0), p.ok === false || d.ok === false ? 'err' : 'ok');
        await loadNetwork(true); render();
      } catch (err) { toast('همگام‌سازی ابری ناموفق: ' + err.message, 'err'); }
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
    case 'ann-add': actAnnAdd(); return;
    case 'leave-add': actLeaveAdd(); return;
    case 'backup-now': await actBackupNow(); return;
    case 'backup-list': await actBackups(); return;
    case 'devices-list': await actDevices(); return;
    case 'audit-list': await actAudit(); return;
    case 'revoke-device':
      try { await api('/api/admin/devices/' + id, { method: 'DELETE' }); toast('دستگاه باطل شد', 'ok'); await actDevices(); }
      catch (err) { toast(err.message, 'err'); }
      return;

    case 'class-add': {
      S.modalTitle = 'کلاس جدید';
      modal(`<form data-form="class">
        <label class="field"><span>نام کلاس</span><input class="input" name="name" required placeholder="مثلاً دهم شبکه"></label>
        <div class="row">
          <label class="field grow"><span>پایه</span><select class="input" name="grade">
            <option>دهم</option><option>یازدهم</option><option>دوازدهم</option></select></label>
          <label class="field grow"><span>رشته</span><input class="input" name="branch" placeholder="شبکه و نرم‌افزار"></label>
        </div>
        <button class="btn primary block">ایجاد</button></form>`);
      return;
    }

    case 'pin-change': {
      const v = ($('#new-pin') || {}).value || '';
      if (!/^\d{4,6}$/.test(v)) return toast('PIN باید ۴ تا ۶ رقم باشد', 'err');
      try { await api('/api/auth/pin', { method: 'POST', body: { pin: v } }); toast('PIN تغییر کرد', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }

    case 'settings-save': {
      const name = ($('#set-name') || {}).value || '';
      try { await api('/api/admin/settings', { method: 'POST', body: { name } }); toast('ذخیره شد', 'ok'); await start(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.getAttribute('data-form');
  const f = form.elements;

  if (kind === 'setup') return doSetup(f);
  if (kind === 'pair') return doPair(f);
  if (kind === 'unlock') return doUnlock(f);
  if (kind === 'transfer') return doTransfer(f);

  if (kind === 'hub') {
    try {
      const r = await api('/api/admin/network', {
        method: 'POST',
        body: { hub_url: f.hub_url.value.trim(), hub_enabled: !!f.hub_enabled.checked },
      });
      if (r.hub) S.network = Object.assign({}, S.network, { hub: r.hub });
      await loadNetwork(true);
      toast('تنظیمات Hub ذخیره شد', 'ok');
      render();
    } catch (err) { toast('ذخیره نشد: ' + err.message, 'err'); }
    return;
  }

  if (kind === 'network') {
    try {
      const r = await api('/api/admin/network', { method: 'POST', body: { public_url: f.public_url.value.trim() } });
      S.server.publicUrl = r.public_url;
      await loadNetwork(true);
      toast('آدرس رسمی ذخیره شد', 'ok');
      render();
    } catch (err) { toast('ذخیره نشد: ' + err.message, 'err'); }
    return;
  }

  if (kind === 'leave') {
    const row = {
      student_id: Number(f.student_id.value), date: f.date.value, reason: f.reason.value.trim(),
      status: 'pending', created_by: S.user.id, school_id: 1,
    };
    if (!row.date) return toast('تاریخ را انتخاب کنید', 'err');
    putLocal('leaves', row);
    const op = S.queue[S.queue.length - 1];
    closeModal(); saveCache(); render();
    await flushQueue();
    const stillQueued = !!(op && S.queue.some(x => x.uid === op.uid));
    if (stillQueued && S.hub && S.hub.enabled) {
      const sent = await queueLeaveToHub(row.student_id, { date: row.date, reason: row.reason, uid: op.uid });
      if (sent) toast('درخواست ثبت شد و در صف ابری قرار گرفت', 'ok');
      else toast('درخواست روی گوشی ذخیره شد — با اتصال بعدی ارسال می‌شود', 'ok');
      return;
    }
    toast('درخواست ثبت شد', 'ok');
    return;
  }

  if (kind === 'ann') {
    putLocal('announcements', {
      title: f.title.value.trim(), body: f.body.value.trim(), severity: f.severity.value,
      audience: 'all', date: todayISO(), author_id: S.user.id, school_id: 1,
    });
    closeModal(); saveCache(); render();
    await flushQueue();
    toast('اطلاعیه منتشر شد', 'ok');
    return;
  }

  if (kind === 'user') {
    const row = {
      name: f.name.value.trim(), role: f.role.value, national_id: norm(f.national_id.value),
      phone: norm(f.phone.value), active: true, school_id: 1,
      class_id: f.class_id.value ? Number(f.class_id.value) : null,
    };
    const saved = putLocal('users', row);
    closeModal(); saveCache(); render();
    await flushQueue();
    toast('کاربر ساخته شد — حالا «کارت پیوند» بدهید', 'ok');
    if (saved && saved.id) actPairCode(saved.id);
    return;
  }

  if (kind === 'class') {
    putLocal('classes', { name: f.name.value.trim(), grade: f.grade.value, branch: f.branch.value.trim(), capacity: 30, school_id: 1 });
    closeModal(); saveCache(); render();
    await flushQueue();
    toast('کلاس ساخته شد', 'ok');
    return;
  }

  if (kind === 'import') {
    const file = f.file.files && f.file.files[0];
    if (!file) return toast('فایلی انتخاب نشده', 'err');
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows.length) return toast('فایل خالی یا ناخوانا است', 'err');
    try {
      const r = await api('/api/admin/import', { method: 'POST', body: { kind: f.kind.value, rows } });
      closeModal();
      await pullAll();
      render();
      const errs = (r.errors || []).length;
      toast(fa(r.created) + ' کاربر ثبت شد' + (errs ? ' · ' + fa(errs) + ' خطا' : ''), r.created ? 'ok' : 'err');
      if (errs) {
        S.modalTitle = 'خطاهای ورود';
        modal(`<div class="table-wrap"><table><thead><tr><th>سطر</th><th>خطا</th><th>مقدار</th></tr></thead><tbody>
          ${r.errors.slice(0, 100).map(x => `<tr><td>${fa(x.row)}</td><td class="small">${esc(x.error)}</td><td class="small ltr">${esc(x.nid || x.class_name || '')}</td></tr>`).join('')}
        </tbody></table></div>`);
      }
    } catch (err) { toast('ورود ناموفق: ' + err.message, 'err'); }
    return;
  }
});
/* bumper */
