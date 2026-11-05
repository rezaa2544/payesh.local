/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال — هستهٔ کلاینت (بدون چارچوب، بدون CDN)
   ذخیره‌سازی: IndexedDB برای داده + localStorage برای توکن/صف
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* با build-release هم‌تراز می‌شود؛ برای تشخیص «نسخهٔ کهنه در حافظهٔ مرورگر» */
const CLIENT_VERSION = '0.5.7';

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
  tunnelBusy: false,
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
    toast(/bad_credentials/.test(e.message) ? 'شماره یا رمز عبور درست نیست' : 'ورود ناموفق: ' + e.message, 'err');
  }
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
  if (S.route === 'cloud' && S.role === 'manager' && S.cloud === undefined && !S._cloudLoading) {
    S._cloudLoading = true;
    loadCloud().then(() => { S._cloudLoading = false; if (S.route === 'cloud') render(); });
  }
  updateTopChrome();
}


/* ── حافظهٔ ابری ────────────────────────────────────────────────── */
async function loadCloud() {
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
  while (Date.now() - started < 90_000) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const h = await fetch('/api/health', { cache: 'no-store' }).then(r => r.json());
      const sameProcess = h.version === previousVersion;
      if (!sameProcess || (h.installed_version && h.installed_version === version && !h.restart_pending)) {
        updateOverlay('نسخهٔ ' + fa(h.version) + ' فعال شد', 'در حال بازخوانی برنامه…');
        await new Promise(r => setTimeout(r, 600));
        location.reload();
        return;
      }
    } catch (e) { /* سرور در حال بالا آمدن است */ }
  }
  updateOverlay('سرور دوباره بالا نیامد', 'برنامه را ببندید و دوباره اجرا کنید.');
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
    toast('به‌روزرسانی ناموفق: ' + e.message, 'err');
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
      dataDir: (setup && setup.data_dir) || health.data_dir || null,
      dbFile: (setup && setup.db_file) || health.db_file || null,
      hasPassword: !!(setup && setup.has_password),
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
    case 'user-password': {
      const u = byId('users', Number(id));
      if (!u) return;
      const pw = prompt('رمز عبور جدید برای «' + u.name + '» (حداقل ۴ نویسه):');
      if (pw === null) return;
      if (String(pw).length < 4) return toast('رمز کوتاه است', 'err');
      try {
        await api('/api/admin/users/' + u.id + '/password', { method: 'POST', body: { password: String(pw) } });
        toast('رمز عبور ثبت شد — ' + (u.phone ? 'ورود با ' + u.phone : 'شمارهٔ همراه لازم است'), 'ok');
        await syncNow(true); render();
      } catch (e) { toast('ثبت نشد: ' + e.message, 'err'); }
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
    case 'tunnel-quick': {
      S.tunnelBusy = true; render();
      toast('در حال ساخت تونل موقت… (چند ثانیه)');
      try {
        const r = await api('/api/admin/tunnel', { method: 'POST', body: { action: 'quick' } });
        if (r.url) { S.server.publicUrl = r.url; toast('آدرس موقت: ' + r.url, 'ok'); }
        else toast('تونل موقت ساخته نشد (Cloudflare نصب است؟)', 'err');
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
    case 'update-fetch': await applyRemoteUpdate(); return;
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

  if (kind === 'setup') return doSetup(f);
  if (kind === 'pair') return doPair(f);
  if (kind === 'login') return doLogin(f);
  if (kind === 'claim') return doClaim(f);
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

  if (kind === 'update') {
    try {
      await api('/api/admin/update/settings', { method: 'POST', body: { base: f.base.value.trim() } });
      await loadRemoteUpdate(true);
      toast('منبع آپدیت ذخیره شد', 'ok');
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
