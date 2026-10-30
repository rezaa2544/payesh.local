'use strict';
/* ───────────────────────────────────────────────────────────────────
   هویت بدون پیامک: «کارت پیوند» + PIN
   ۱) مدیر برای هر کاربر یک کد یک‌بارمصرف می‌سازد (روی کاغذ چاپ می‌شود)
   ۲) کاربر با کد + PIN دستگاهش را به حساب گره می‌زند ⇒ توکن دستگاه (۹۰ روز)
   ۳) هر بار باز کردن برنامه: PIN ⇒ نشست کوتاه (۱۲ ساعت)
   ─────────────────────────────────────────────────────────────────── */
const { nowISO, sha256, randomId, randomCode, scryptHash, scryptVerify, normDigits } = require('./util');

const PAIR_TTL_MIN = 7 * 24 * 60;      /* کد پیوند تا ۷ روز معتبر است */
const DEVICE_DAYS = 90;
const SESSION_HOURS = 12;

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
  const pin = String(input.pin || '');
  if (name.length < 3) return { ok: false, error: 'bad_name' };
  if (!/^\d{4,6}$/.test(pin)) return { ok: false, error: 'bad_pin' };

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

  const manager = store.insert('users', {
    name, role: 'manager', phone: normDigits(input.phone || ''),
    national_id: normDigits(input.national_id || ''), active: true,
    school_id: 1, created_at: nowISO(),
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
  const user = store.get('users', s.user_id);
  if (!user || user.active === false) return null;
  const device = s.device_id ? store.db.prepare('SELECT * FROM devices WHERE id=?').get(s.device_id) : null;
  return { user, device, session: s };
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
  const pin = String(input.pin || '');
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

function publicUser(u) {
  return {
    id: u.id, name: u.name, role: u.role, phone: u.phone, national_id: u.national_id,
    class_id: u.class_id || null, active: u.active !== false,
  };
}

/* پاک‌سازی نشست‌های منقضی */
function prune(store) {
  const t = nowISO();
  store.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  store.db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(t);
}

module.exports = {
  needsSetup, setup, createPairCode, pair, unlock, changePin,
  verifySession, listDevices, revokeDevice, logout, publicUser, prune, findUserByPhone,
  SESSION_HOURS,
};
