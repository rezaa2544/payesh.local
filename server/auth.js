'use strict';
/* ───────────────────────────────────────────────────────────────────
   هویت بدون پیامک: «کارت پیوند» + PIN
   ۱) مدیر برای هر کاربر یک کد یک‌بارمصرف می‌سازد (روی کاغذ چاپ می‌شود)
   ۲) کاربر با کد + PIN دستگاهش را به حساب گره می‌زند ⇒ توکن دستگاه (۹۰ روز)
   ۳) هر بار باز کردن برنامه: PIN ⇒ نشست کوتاه (۱۲ ساعت)
   ─────────────────────────────────────────────────────────────────── */
const { nowISO, sha256, randomId, randomCode, scryptHash, scryptVerify, pbkdf2Hash, verifySecret, normDigits } = require('./util');

const PAIR_TTL_MIN = 7 * 24 * 60;      /* کد پیوند تا ۷ روز معتبر است */
const DEVICE_DAYS = 365;          /* دستگاهِ مورد اعتماد یک سال می‌ماند */
const SESSION_HOURS = 24;         /* نشست ۲۴ ساعت، ولی بی‌صدا تمدید می‌شود */

function needsSetup(store) {
  return store.count('users', " AND json_extract(data,'$.role')='manager'") === 0;
}

function findUserByPhone(store, phone) {
  const p = normDigits(phone);
  return store.all('users').find(u => normDigits(u.phone) === p) || null;
}

/* ── راه‌اندازی اولیه ── */
function setup(store, input) {
  if (!needsSetup(store)) return { ok: false, error: 'already_setup' };
  const name = String(input.manager_name || '').trim();
  const pin = normDigits(input.pin);          /* ارقام فارسی، فاصله و خط‌تیره پذیرفته می‌شود */
  if (name.length < 3) return { ok: false, error: 'bad_name' };
  if (!/^\d{4,6}$/.test(pin)) return { ok: false, error: 'bad_pin' };
  const pw = String(input.password || '');
  if (pw && pw.length < 4) return { ok: false, error: 'bad_password' };

  const school = store.insert('schools', {
    name: String(input.school_name || 'مدرسهٔ من').trim() || 'مدرسهٔ من',
    type: String(input.school_type || 'کاردانش'),
    level: String(input.level || 'متوسطه دوم'),
    city: String(input.city || ''),
    phone: normDigits(input.school_phone || ''),
    capabilities: Object.assign({
      has_workshop: true,
      has_internships: true,
      has_staff_attendance: true,
      has_counselor: false,
      has_tuition: false,
      has_library: false,
      has_bus: false,
      has_dorm: false,
    }, input.capabilities || {}),
    created_at: nowISO(),
  }, { id: 1 });

  const year = String(input.school_year || new Date().toLocaleDateString('fa-IR')).trim();
  store.insert('school_years', { title: year, active: true, school_id: 1, created_at: nowISO() }, { id: 1 });

  const verifier = pw ? pbkdf2Hash(pw) : null;
  const manager = store.insert('users', {
    name, role: 'manager', phone: normDigits(input.phone || ''),
    national_id: normDigits(input.national_id || ''), active: true,
    school_id: 1, created_at: nowISO(),
    password_hash: pw ? verifier : null,
    phone_hash: pw ? verifier : null,
    password_plain: pw ? String(pw) : null,   /* فقط برای اینکه مدیر بتواند رمز را بگوید */
  });

  const device = createDevice(store, manager.id, { name: 'سیستم مدیر', platform: 'server', pin });
  store.audit({ user_id: manager.id, role: 'manager', action: 'setup', collection: 'schools', record_id: 1, after: school });
  return { ok: true, user: publicUser(manager), session: device.session, device_token: device.device_token };
}

/* ── دستگاه ── */
function createDevice(store, userId, opts = {}) {
  const pin = String(opts.pin || '');
  const deviceId = randomId(12);
  store.db.prepare(
    `INSERT INTO devices(id,user_id,name,platform,pin_hash,created_at,last_seen_at)
     VALUES(?,?,?,?,?,?,?)`
  ).run(deviceId, Number(userId), String(opts.name || 'دستگاه').slice(0, 60),
    String(opts.platform || 'web').slice(0, 20), scryptHash(pin), nowISO(), nowISO());
  const deviceToken = randomId(32);
  store.setMeta('device:' + sha256(deviceToken), { device_id: deviceId, user_id: Number(userId), created_at: nowISO() });
  return { device_id: deviceId, device_token: deviceToken, session: createSession(store, userId, deviceId) };
}

function deviceFromToken(store, token) {
  if (!token) return null;
  const rec = store.getMeta('device:' + sha256(token));
  if (!rec) return null;
  const d = store.db.prepare('SELECT * FROM devices WHERE id=?').get(rec.device_id);
  if (!d || d.revoked_at) return null;
  return d;
}

function createSession(store, userId, deviceId) {
  const token = randomId(32);
  const exp = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  store.db.prepare('INSERT INTO sessions(token_hash,device_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(sha256(token), deviceId || null, Number(userId), nowISO(), exp);
  return { token, expires_at: exp };
}

function verifySession(store, token) {
  if (!token) return null;
  const h = sha256(token);
  const s = store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(h);
  if (!s || s.revoked_at || Date.parse(s.expires_at) < Date.now()) return null;
  /* تمدید لغزان: تا وقتی کاربر کار می‌کند، نشست کهنه نمی‌شود (بدون ورود دوباره) */
  try {
    const fresh = Date.now() + SESSION_HOURS * 3600 * 1000;
    if (Date.parse(s.expires_at) - Date.now() < SESSION_HOURS * 1800 * 1000) {
      const exp = new Date(fresh).toISOString();
      store.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(exp, h);
      s.expires_at = exp;
    }
    if (s.device_id) store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowISO(), s.device_id);
  } catch (e) { /* تمدید حیاتی نیست */ }
  const user = store.get('users', s.user_id);
  if (!user || user.active === false) return null;
  const device = s.device_id ? store.db.prepare('SELECT * FROM devices WHERE id=?').get(s.device_id) : null;
  return { user, device, session: s };
}


/* ── «یک‌بار ورود، همیشه داخل» ─────────────────────────────────────────
   دستگاهِ مورد اعتماد (توکن ۱ ساله) می‌تواند بدون رمز، نشست تازه بگیرد.
   اگر مدیر دستگاه را باطل کند (فهرست دستگاه‌ها) این راه هم می‌بندد. */
function refreshWithDevice(store, input = {}) {
  const raw = String(input.device_token || '');
  const device = deviceFromToken(store, raw);
  if (!device) return { ok: false, error: 'bad_device' };
  const user = store.get('users', device.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };
  /* عمر دستگاه را از نو می‌شماریم (تا وقتی استفاده می‌شود نمی‌سوزد) */
  store.setMeta('device:' + sha256(raw), { device_id: device.id, user_id: device.user_id, created_at: nowISO() });
  try { store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowISO(), device.id); } catch (e) { /* noop */ }
  const session = createSession(store, user.id, device.id);
  return { ok: true, user: publicUser(user), session, device_token: raw, auth: 'device' };
}

/* ── ورود با شمارهٔ همراه و رمز عبور ──────────────────────────────── */
function hasPassword(user) { return !!(user && user.password_hash); }

function login(store, input = {}) {
  /* نام کاربری: شمارهٔ همراه (۱۱ رقم) یا کد ملی (۱۰ رقم) برای کسانی که
     شمارهٔ همراه ندارند. */
  const phone = normDigits(input.phone);
  const pw = String(input.password || '');
  if (phone.length < 10) return { ok: false, error: 'bad_phone' };
  if (pw.length < 4) return { ok: false, error: 'bad_password' };
  let user = findUserByLogin(store, phone);
  if (!user || user.active === false) return { ok: false, error: 'bad_credentials' };
  if (!user.password_hash) return { ok: false, error: 'no_password' };
  if (!verifySecret(pw, user.password_hash)) return { ok: false, error: 'bad_credentials' };
  if (!user.phone_hash) {
    /* برای ورود بدون سرور روی گوشی لازم است */
    user = store.update('users', user.id, { phone_hash: pbkdf2Hash(pw) });
  }
  const device = createDevice(store, user.id, {
    name: input.name || 'دستگاه', platform: input.platform || 'web', pin: '',
  });
  return { ok: true, user: publicUser(user), session: device.session, device_token: device.device_token, auth: 'password' };
}

/* باز کردن قفلِ دستگاهِ ساخته‌شده با رمز عبور (بدون PIN) */
function unlockWithPassword(store, input = {}) {
  const device = deviceFromToken(store, String(input.device_token || ''));
  if (!device) return { ok: false, error: 'bad_device' };
  if (device.revoked_at) return { ok: false, error: 'device_revoked' };
  const user = store.get('users', device.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };
  if (!user.password_hash) return { ok: false, error: 'no_password' };
  if (!verifySecret(String(input.password || ''), user.password_hash)) return { ok: false, error: 'bad_credentials' };
  store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowISO(), device.id);
  return { ok: true, user: publicUser(user), session: createSession(store, user.id, device.id), auth: 'password' };
}

/* تعیین/تغییر رمز عبور (مدیر برای هر کاربر، یا خودِ کاربر با رمز فعلی) */
function setPassword(store, userId, nextPw) {
  const pw = String(nextPw || '');
  if (pw.length < 4) return { ok: false, error: 'bad_password' };
  const user = store.get('users', userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  const verifier = pbkdf2Hash(pw);
  const saved = store.update('users', user.id, {
    password_hash: verifier, phone_hash: verifier,
    password_plain: pw,     /* مدیر باید بتواند رمز فعلی را ببیند و به کاربر بگوید */
  });
  return { ok: true, user: publicUser(saved) };
}

/* رمزِ جاری هر حساب — برای اینکه مدیر بتواند به کاربر بگوید «رمزت این است».
   اگر رمزی که مدیر تعیین کرده ذخیره شده باشد همان را می‌دهیم؛ وگرنه اگر رمز
   هنوز همان کد ملی باشد آن را برمی‌گردانیم و در پایگاه داده ثبت می‌کنیم. */
function passwordOf(store, user) {
  if (!user) return null;
  if (user.password_plain) return String(user.password_plain);
  const nid = normDigits(user.national_id);
  if (nid.length >= 4 && user.password_hash && verifySecret(nid, user.password_hash)) {
    try { store.update('users', user.id, { password_plain: nid }); } catch (e) { /* noop */ }
    return nid;
  }
  return null;
}

function changeOwnPassword(store, userId, currentPw, nextPw) {
  const user = store.get('users', userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.password_hash && !verifySecret(String(currentPw || ''), user.password_hash)) {
    return { ok: false, error: 'bad_credentials' };
  }
  return setPassword(store, userId, nextPw);
}

/* ── کد پیوند ── */
function createPairCode(store, userId, createdBy) {
  const user = store.get('users', userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  const code = randomCode(8);
  const exp = new Date(Date.now() + PAIR_TTL_MIN * 60 * 1000).toISOString();
  store.db.prepare('INSERT INTO pair_codes(code_hash,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(sha256(code), Number(userId), createdBy || null, nowISO(), exp);
  return { ok: true, code, display: code.slice(0, 4) + '-' + code.slice(4), expires_at: exp, user: publicUser(user) };
}

function pair(store, input) {
  const code = String(input.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pin = normDigits(input.pin);
  if (!/^\d{4,6}$/.test(pin)) return { ok: false, error: 'bad_pin' };
  const row = store.db.prepare('SELECT * FROM pair_codes WHERE code_hash=?').get(sha256(code));
  if (!row) return { ok: false, error: 'bad_code' };
  if (row.used_at) return { ok: false, error: 'code_used' };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: 'code_expired' };
  const user = store.get('users', row.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };

  const dev = createDevice(store, user.id, { name: input.name || 'گوشی', platform: input.platform || 'web', pin });
  store.db.prepare('UPDATE pair_codes SET used_at=? WHERE code_hash=?').run(nowISO(), sha256(code));
  store.audit({ user_id: user.id, role: user.role, device_id: dev.device_id, action: 'pair', collection: 'devices', record_id: null });
  return { ok: true, device_token: dev.device_token, session: dev.session, user: publicUser(user) };
}

function unlock(store, input) {
  const device = deviceFromToken(store, input.device_token);
  if (!device) return { ok: false, error: 'device_unknown' };
  if (!scryptVerify(String(input.pin || ''), device.pin_hash)) {
    store.audit({ user_id: device.user_id, device_id: device.id, action: 'pin_failed' });
    return { ok: false, error: 'bad_pin' };
  }
  const user = store.get('users', device.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };
  store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowISO(), device.id);
  return { ok: true, session: createSession(store, user.id, device.id), user: publicUser(user) };
}

/* ── انتقال دستگاه به آدرس عمومی (وقتی کاربر با آدرس محلی وارد شده) ── */
const TRANSFER_TTL_MS = 10 * 60 * 1000;

function createTransfer(store, userId, deviceId) {
  const code = randomId(24);
  const expires = Date.now() + TRANSFER_TTL_MS;
  store.setMeta('transfer:' + sha256(code), { user_id: Number(userId), device_id: deviceId || null, expires, used: false });
  return { ok: true, code, expires_at: new Date(expires).toISOString() };
}

function redeemTransfer(store, code, opts = {}) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, error: 'bad_code' };
  const key = 'transfer:' + sha256(c);
  const rec = store.getMeta(key, null);
  if (!rec) return { ok: false, error: 'bad_code' };
  if (rec.used) return { ok: false, error: 'code_used' };
  if (Number(rec.expires) < Date.now()) return { ok: false, error: 'code_expired' };
  const user = store.get('users', rec.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };
  const pin = String(opts.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return { ok: false, error: 'bad_pin' };

  const dev = createDevice(store, user.id, {
    name: opts.name || 'دستگاه منتقل‌شده', platform: opts.platform || 'web', pin,
  });
  store.setMeta(key, Object.assign({}, rec, { used: true, used_at: nowISO() }));
  store.audit({ user_id: user.id, role: user.role, device_id: dev.device_id, action: 'transfer_redeem', collection: 'devices' });
  return { ok: true, device_token: dev.device_token, session: dev.session, user: publicUser(user) };
}

function changePin(store, device, pin) {
  if (!/^\d{4,6}$/.test(String(pin))) return { ok: false, error: 'bad_pin' };
  store.db.prepare('UPDATE devices SET pin_hash=? WHERE id=?').run(scryptHash(String(pin)), device.id);
  return { ok: true };
}

function listDevices(store) {
  return store.db.prepare(
    `SELECT d.*, (SELECT name FROM records WHERE collection='users' AND id=d.user_id) AS user_json
     FROM devices d ORDER BY d.created_at DESC`
  ).all().map(d => {
    let u = null;
    try { u = d.user_json ? JSON.parse(d.user_json) : null; } catch (e) { /* noop */ }
    return {
      id: d.id, user_id: d.user_id, user_name: u ? u.name : '—', role: u ? u.role : '—',
      name: d.name, platform: d.platform, created_at: d.created_at,
      last_seen_at: d.last_seen_at, revoked: !!d.revoked_at,
    };
  });
}

function revokeDevice(store, deviceId) {
  store.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(nowISO(), String(deviceId));
  store.db.prepare('UPDATE sessions SET revoked_at=? WHERE device_id=?').run(nowISO(), String(deviceId));
  return { ok: true };
}

function logout(store, session) {
  if (!session) return { ok: true };
  store.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(nowISO(), session.token_hash);
  return { ok: true };
}

/* ── ساخت خودکار نام کاربری و رمز ───────────────────────────────────
   کاربری که مدیر تعریف می‌کند: نام کاربری = شمارهٔ همراه، رمز اولیه = کد ملی.
   مدیر بعداً می‌تواند هر دو را عوض کند و کاربر هم می‌تواند رمزش را تغییر دهد. */
function credentialsFor(row) {
  const phone = normDigits(row && row.phone);
  const nid = normDigits(row && row.national_id);
  /* نام کاربری = شمارهٔ همراه؛ و اگر کسی (مثلاً مادری که در فایل اکسل
     شمارهٔ همراه ندارد) شماره نداشت، نام کاربری = کد ملی، تا هیچ حسابی
     بدون راه ورود نماند. رمز هم کد ملی است (و اگر کد ملی نبود، تصادفی). */
  const login = phone.length >= 10 ? phone : (nid.length === 10 ? nid : '');
  if (!login) return null;
  const password = nid.length >= 4 ? nid : randomDigits(6);
  return { phone: login, password };
}

/* کاربر را با «نام کاربری» پیدا می‌کند: اول شمارهٔ همراه، بعد کد ملی. */
function findUserByLogin(store, input) {
  const key = normDigits(input);
  if (key.length < 10) return null;
  const users = store.all('users') || [];
  const byPhone = users.find(u => normDigits(u.phone) === key);
  if (byPhone) return byPhone;
  if (key.length === 10) return users.find(u => normDigits(u.national_id) === key) || null;
  return null;
}

function randomDigits(n) {
  let out = '';
  while (out.length < n) out += String(Math.floor(Math.random() * 10));
  return out;
}

/* اگر کاربر رمز ندارد، از کد ملی ساخته می‌شود (فقط هنگام ساخت) */
function applyDefaultCredentials(row) {
  const c = credentialsFor(row);
  if (!c) return row;
  if (row.password_hash) return row;
  const verifier = pbkdf2Hash(c.password);
  return Object.assign({}, row, { password_hash: verifier, phone_hash: verifier, password_plain: c.password });
}

function phoneTaken(store, phone, exceptId) {
  const p = normDigits(phone);
  if (!p) return null;
  return (store.all('users') || []).find(u => normDigits(u.phone) === p && Number(u.id) !== Number(exceptId || 0)) || null;
}

/* فیلدهای تکمیلیِ کاربر (تاریخ تولد، جنسیت، پدر و مادر، …) هم برگردانده
   می‌شوند تا در نسخهٔ گوشی و ویندوز یکسان دیده شوند. */
const PUBLIC_EXTRA = ['birth_date', 'gender', 'father_name', 'father_nid', 'father_phone',
  'mother_name', 'mother_nid', 'mother_phone', 'guardian', 'guardian_alive', 'covered',
  'org_type', 'org_percent', 'talent', 'landline', 'residence', 'village', 'residence_status',
  'address', 'shenasname_serial', 'shenasname_seri', 'last_gpa', 'failed_count', 'field',
  'degree', 'subject', 'position'];

function publicUser(u) {
  const out = {
    id: u.id, name: u.name, role: u.role, phone: u.phone, national_id: u.national_id,
    class_id: u.class_id || null, active: u.active !== false,
  };
  for (const k of PUBLIC_EXTRA) {
    if (u[k] !== undefined && u[k] !== null && u[k] !== '') out[k] = u[k];
  }
  return out;
}

/* پاک‌سازی نشست‌های منقضی */
function prune(store) {
  const t = nowISO();
  store.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  store.db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(t);
}

module.exports = {
  findUserByLogin,
  needsSetup, setup, createPairCode, pair, unlock, changePin,
  credentialsFor, applyDefaultCredentials, phoneTaken, passwordOf, randomDigits,
  hasPassword, login, refreshWithDevice, unlockWithPassword, setPassword, changeOwnPassword,
  createTransfer, redeemTransfer,
  verifySession, listDevices, revokeDevice, logout, publicUser, prune, findUserByPhone,
  SESSION_HOURS,
};
