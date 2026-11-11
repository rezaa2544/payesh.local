'use strict';
/* ───────────────────────────────────────────────────────────────────
   هویت بدون پیامک: «کارت پیوند» + PIN
   ۱) مدیر برای هر کاربر یک کد یک‌بارمصرف می‌سازد (روی کاغذ چاپ می‌شود)
   ۲) کاربر با کد + PIN دستگاهش را به حساب گره می‌زند ⇒ توکن دستگاه (۹۰ روز)
   ۳) هر بار باز کردن برنامه: PIN ⇒ نشست کوتاه (۱۲ ساعت)
   ─────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const { nowISO, sha256, randomId, randomCode, pbkdf2Hash, verifySecret, normDigits } = require('./util');
/* row 65: short-lived access + rotating refresh + device key + device cap */
const identity = require('./identity');

/* ── رمزنگاری دادهٔ حساس در حالت سکون (F‑01) ─────────────────────────
   رمز قابل‌بازخوانی هرگز خام روی دیسک/بکاپ نمی‌ماند: AES‑256‑GCM با کلیدی
   که فقط در متادیتای همین سرور است. کلید هرگز در API/باندل/صندوقچه نمی‌رود. */
const AT_REST_META = 'secret:at-rest-key';
function atRestKey(store) {
  const rec = store.getMeta(AT_REST_META, null);
  if (rec && rec.key) return Buffer.from(String(rec.key), 'base64');
  const key = crypto.randomBytes(32);
  store.setMeta(AT_REST_META, { key: key.toString('base64'), created_at: nowISO() });
  return key;
}
function sealSecret(store, plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', atRestKey(store), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc:v1:' + iv.toString('base64url') + ':' + c.getAuthTag().toString('base64url') + ':' + ct.toString('base64url');
}
function openSecret(store, sealed) {
  const parts = String(sealed || '').split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', atRestKey(store), Buffer.from(parts[2], 'base64url'));
    d.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[4], 'base64url')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
/* هیچ رمز خامی در ردیف کاربر نمی‌ماند؛ هر ردیف قدیمی همین‌جا پاک‌سازی می‌شود */
function migrateSecrets(store) {
  let moved = 0, purged = 0;
  for (const u of (store.all('users') || [])) {
    const patch = {};
    if (u.password_plain) {
      if (!u.password_enc) patch.password_enc = sealSecret(store, u.password_plain);
      patch.password_plain = undefined;   /* undefined ⇒ کلید از JSON حذف می‌شود */
      moved++;
    } else if (Object.prototype.hasOwnProperty.call(u, 'password_plain')) {
      patch.password_plain = undefined; purged++;
    }
    if (Object.keys(patch).length) {
      try { store.update('users', u.id, patch); } catch (e) { /* noop */ }
    }
  }
  return { moved, purged };
}

const DEVICE_DAYS = 365;          /* دستگاهِ مورد اعتماد یک سال می‌ماند (PAYESH_DEVICE_DAYS) */
/* ردیف ۶۵: نشست (access token) کوتاه‌عمر و بدون تمدید لغزان است —
   PAYESH_ACCESS_TTL_MIN (پیش‌فرض ۱۵ دقیقه)؛ کلاینت با توکن دستگاه (refresh) آن را
   بی‌صدا تازه می‌کند. SESSION_HOURS فقط برای سازگاری گزارش‌ها نگه داشته شده است. */
const SESSION_HOURS = 24;
function accessTtlMs() { return identity.config().accessTtlMin * 60 * 1000; }

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
  /* PIN حذف شده است: از این پس ورود با شمارهٔ همراه + رمز عبور است */
  if (name.length < 3) return { ok: false, error: 'bad_name' };
  const pw = String(input.password || '');
  if (pw.length < 4) return { ok: false, error: 'bad_password' };

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
    password_enc: pw ? sealSecret(store, pw) : null,   /* رمز قابل‌بازخوانی: رمزنگاری‌شده */
  });

  const device = createDevice(store, manager.id, { name: 'سیستم مدیر', platform: 'server' });
  store.audit({ user_id: manager.id, role: 'manager', action: 'setup', collection: 'schools', record_id: 1, after: school });
  return { ok: true, user: publicUser(manager), session: device.session, device_token: device.device_token };
}

/* ── دستگاه ── */
function createDevice(store, userId, opts = {}) {
  /* PIN از برنامه حذف شده است؛ این ستون برای دستگاه‌های قدیمی خالی می‌ماند */
  const deviceId = randomId(12);
  const pk = opts.pubkey && opts.pubkey.ok && !opts.pubkey.none ? opts.pubkey : null;
  store.db.prepare(
    `INSERT INTO devices(id,user_id,name,platform,pin_hash,created_at,last_seen_at,pubkey,pubkey_alg)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(deviceId, Number(userId), String(opts.name || 'دستگاه').slice(0, 60),
    String(opts.platform || 'web').slice(0, 20), '', nowISO(), nowISO(), pk ? pk.spki : null, pk ? pk.alg : null);
  /* ردیف ۶۵: توکن دستگاه = refresh token نسل ۱؛ فقط هش آن ذخیره می‌شود */
  const deviceToken = identity.issueToken(store, deviceId, 1);
  identity.audit(store, { id: deviceId, user_id: userId }, 'device_login',
    { platform: String(opts.platform || 'web').slice(0, 20), via: opts.via || null, key_bound: !!pk, key_alg: pk ? pk.alg : null }, opts.ip);
  return { device_id: deviceId, device_token: deviceToken, session: createSession(store, userId, deviceId), key_bound: !!pk };
}

/* ردیف ۶۵: پیش از ساخت دستگاه تازه — کلید عمومی معتبر و سقف دستگاه هر کاربر */
function admitDevice(store, userId, input = {}) {
  const pubkey = identity.parsePubkey(input.device_pubkey);
  if (!pubkey.ok) return { error: { ok: false, error: pubkey.error } };
  const capped = identity.checkCap(store, userId, identity.config(), input.__ip);
  if (capped) return { error: capped };
  return { pubkey };
}

function deviceFromToken(store, token) {
  if (!token) return null;
  const found = identity.lookup(store, token);
  if (!found) return null;
  const d = found.device;
  /* ردیف ۶۵: توکنِ چرخیده (کهنه) دیگر هویت نیست — جز برای ابطال‌شده‌ها که باید
     «ابطال» را گزارش کنند. تشخیص reuse فقط در refreshWithDevice است. */
  if (found.rec.rotated_at && !d.revoked_at) return null;
  /* ردیف ۴۴: دستگاه ابطال‌شده هم برگردانده می‌شود تا فراخوان بتواند
     «ابطال» را از «توکن ناشناس» تفکیک کند (کلاینت روی ابطال، داده را
     پاک می‌کند؛ روی توکن ناشناس فقط دوباره جفت می‌شود). */
  return d;
}

function createSession(store, userId, deviceId) {
  const token = randomId(32);
  const exp = new Date(Date.now() + accessTtlMs()).toISOString();
  store.db.prepare('INSERT INTO sessions(token_hash,device_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(sha256(token), deviceId || null, Number(userId), nowISO(), exp);
  return { token, expires_at: exp };
}

function verifySession(store, token) {
  if (!token) return null;
  const h = sha256(token);
  const s = store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(h);
  if (!s || s.revoked_at || Date.parse(s.expires_at) < Date.now()) return null;
  /* ردیف ۶۵: بدون تمدید لغزان — access token کوتاه‌عمر می‌ماند؛ تمدید فقط با refresh */
  try {
    if (s.device_id) store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowISO(), s.device_id);
  } catch (e) { /* ثبت آخرین دیده‌شدن حیاتی نیست */ }
  const user = store.get('users', s.user_id);
  if (!user || user.active === false) return null;
  const device = s.device_id ? store.db.prepare('SELECT * FROM devices WHERE id=?').get(s.device_id) : null;
  /* ردیف ۴۴ / W1: ابطال دستگاه بی‌درنگ اثر می‌کند، حتی اگر ردیف نشستی
     از ابطال جا مانده باشد. دستگاه ابطال‌شده هرگز «کاربر معتبر» نمی‌دهد. */
  if (device && device.revoked_at) return null;
  return { user, device, session: s };
}


/* ── «یک‌بار ورود، همیشه داخل» ─────────────────────────────────────────
   دستگاهِ مورد اعتماد (توکن ۱ ساله) می‌تواند بدون رمز، نشست تازه بگیرد.
   اگر مدیر دستگاه را باطل کند (فهرست دستگاه‌ها) این راه هم می‌بندد. */
function refreshWithDevice(store, input = {}) {
  /* ردیف ۶۵: چرخش refresh token با تشخیص استفادهٔ دوباره.
     ترتیب مهم است: ابطال ← اثبات مالکیت کلید ← چرخش/تشخیص reuse. اثبات پیش از
     reuse می‌آید تا کسی که فقط توکن قدیمی را دزدیده نتواند با آن دستگاه واقعی را باطل کند. */
  const raw = String(input.device_token || '');
  const found = identity.lookup(store, raw);
  if (!found) return { ok: false, error: 'bad_device' };
  const device = found.device;
  if (device.revoked_at) return { ok: false, error: 'device_revoked', reason: device.revoke_reason || 'manager', wipe: true };
  const user = store.get('users', device.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };
  const cfg = identity.config();
  const proofErr = identity.verifyProof(device, raw, input.proof, cfg);
  if (proofErr) {
    identity.audit(store, device, 'refresh_bad_proof', { error: proofErr }, input.__ip);
    return { ok: false, error: proofErr };
  }
  const rot = identity.rotate(store, found, cfg, { openSecret, sealSecret, ip: input.__ip });
  if (!rot.ok) return rot;
  if (device.pubkey && input.proof) {
    store.db.prepare('UPDATE devices SET proof_ts=? WHERE id=?').run(Number(input.proof.ts), device.id);
  }
  try { store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowISO(), device.id); } catch (e) { /* noop */ }
  const session = createSession(store, user.id, device.id);
  return { ok: true, user: publicUser(user), session, device_token: rot.device_token, device_id: device.id,
    rotated: rot.rotated, generation: rot.generation, auth: 'device' };
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
  /* ردیف ۶۵: ورود گوشیِ بی‌سرور (/api/phone/login) هرگز توکن دستگاه را به کلاینت
     نمی‌دهد (هویت آن تیکت ۲۰۰ روزهٔ امضاشده است)؛ پس دستگاه یتیم نمی‌سازیم و سقف
     را مصرف نمی‌کنیم — فقط یک نشست کوتاه‌عمر بدون دستگاه. */
  if (input.__sessionOnly) {
    identity.audit(store, { id: null, user_id: user.id }, 'session_login', { platform: String(input.platform || 'phone').slice(0, 20) }, input.__ip);
    return { ok: true, user: publicUser(user), session: createSession(store, user.id, null), auth: 'password' };
  }
  /* نجات مدیر از خودِ رایانهٔ مدرسه (loopback، /api/auth/claim) مسیر بازیابی است و
     نباید پشت سقف دستگاه قفل شود؛ کلید عمومی همچنان اعتبارسنجی می‌شود. */
  const adm = input.__capExempt ? { pubkey: identity.parsePubkey(input.device_pubkey) } : admitDevice(store, user.id, input);
  if (adm.error) return adm.error;
  if (!adm.pubkey.ok) return { ok: false, error: adm.pubkey.error };
  const device = createDevice(store, user.id, {
    name: input.name || 'دستگاه', platform: input.platform || 'web', pubkey: adm.pubkey, via: 'login', ip: input.__ip,
  });
  return { ok: true, user: publicUser(user), session: device.session, device_token: device.device_token, device_id: device.device_id, auth: 'password' };
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
    password_enc: sealSecret(store, pw),   /* قابل‌بازخوانی فقط برای مدیر، رمزنگاری‌شده */
    password_plain: undefined,
  });
  return { ok: true, user: publicUser(saved) };
}

/* رمزِ جاری هر حساب — برای اینکه مدیر بتواند به کاربر بگوید «رمزت این است».
   اگر رمزی که مدیر تعیین کرده ذخیره شده باشد همان را می‌دهیم؛ وگرنه اگر رمز
   هنوز همان کد ملی باشد آن را برمی‌گردانیم و در پایگاه داده ثبت می‌کنیم. */
function passwordOf(store, user) {
  if (!user) return null;
  if (user.password_enc) {
    const plain = openSecret(store, user.password_enc);
    if (plain) return plain;
  }
  /* رمز پیش‌فرض (کد ملی) فقط در لحظه بررسی خوانده می‌شود؛ ذخیرهٔ خام ندارد */
  const nid = normDigits(user.national_id);
  if (nid.length >= 4 && user.password_hash && verifySecret(nid, user.password_hash)) return nid;
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

/* ── کد پیوند ────────────────────────────────────────────────────────
   قاعدهٔ کار: کد تا وقتی کار می‌کند که خودِ مدیر «کد تازه» بزند.
   یعنی نه یک‌بارمصرف است و نه با گذشت چند روز می‌سوزد؛ هر دستگاه
   می‌تواند با همان کد وارد شود (گوشی دانش‌آموز، تبلت خانه، …) و
   تنها راه باطل‌کردنش ساختن کد تازه در همان کارت است. */
const PAIR_TTL_MIN = 10 * 365 * 24 * 60;   /* عملاً بدون انقضا */

function pairRowOf(store, userId) {
  return store.db.prepare(
    'SELECT * FROM pair_codes WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).get(Number(userId)) || null;
}

function createPairCode(store, userId, createdBy, opts = {}) {
  const user = store.get('users', userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  const refresh = !!opts.refresh;
  const existing = pairRowOf(store, userId);
  if (existing && !refresh && existing.code_plain) {
    return {
      ok: true, code: existing.code_plain, display: existing.code_plain.slice(0, 4) + '-' + existing.code_plain.slice(4),
      expires_at: existing.expires_at, user: publicUser(user), reused: true, created_at: existing.created_at,
    };
  }
  if (existing) {
    /* کد تازه ⇒ کد قبلی همان لحظه باطل می‌شود */
    store.db.prepare('UPDATE pair_codes SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .run(nowISO(), Number(userId));
  }
  const code = randomCode(8);
  const exp = new Date(Date.now() + PAIR_TTL_MIN * 60 * 1000).toISOString();
  store.db.prepare('INSERT INTO pair_codes(code_hash,user_id,created_by,created_at,expires_at,code_plain) VALUES(?,?,?,?,?,?)')
    .run(sha256(code), Number(userId), createdBy || null, nowISO(), exp, code);
  return {
    ok: true, code, display: code.slice(0, 4) + '-' + code.slice(4), expires_at: exp,
    user: publicUser(user), reused: false, refreshed: !!existing,
  };
}

function pair(store, input) {
  /* فقط کد پیوند — بدون PIN */
  const code = String(input.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const row = store.db.prepare('SELECT * FROM pair_codes WHERE code_hash=?').get(sha256(code));
  if (!row) return { ok: false, error: 'bad_code' };
  if (row.revoked_at) return { ok: false, error: 'code_revoked' };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: 'code_expired' };
  const user = store.get('users', row.user_id);
  if (!user || user.active === false) return { ok: false, error: 'user_inactive' };

  const adm = admitDevice(store, user.id, input);
  if (adm.error) return adm.error;
  const dev = createDevice(store, user.id, { name: input.name || 'گوشی', platform: input.platform || 'web', pubkey: adm.pubkey, via: 'pair', ip: input.__ip });
  /* کد مصرف نمی‌شود؛ تا مدیر کد تازه نسازد، برای دستگاه‌های بعدی هم کار می‌کند */
  store.db.prepare('UPDATE pair_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL')
    .run(nowISO(), sha256(code));
  store.audit({ user_id: user.id, role: user.role, device_id: dev.device_id, action: 'pair', collection: 'devices', record_id: null });
  return { ok: true, device_token: dev.device_token, device_id: dev.device_id, session: dev.session, user: publicUser(user) };
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
  /* PIN حذف شده است: همین رمز عبور خودِ کاربر تأیید می‌شود */
  const pw = String(opts.password || '');
  if (!pw) return { ok: false, error: 'bad_password' };
  if (!user.password_hash || !verifySecret(pw, user.password_hash)) return { ok: false, error: 'bad_password' };

  const adm = admitDevice(store, user.id, opts);
  if (adm.error) return adm.error;
  const dev = createDevice(store, user.id, {
    name: opts.name || 'دستگاه منتقل‌شده', platform: opts.platform || 'web', pin: '', pubkey: adm.pubkey, via: 'transfer', ip: opts.__ip,
  });
  store.setMeta(key, Object.assign({}, rec, { used: true, used_at: nowISO() }));
  store.audit({ user_id: user.id, role: user.role, device_id: dev.device_id, action: 'transfer_redeem', collection: 'devices' });
  return { ok: true, device_token: dev.device_token, session: dev.session, user: publicUser(user) };
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
      key_bound: !!d.pubkey, revoke_reason: d.revoke_reason || null,
    };
  });
}

function revokeDevice(store, deviceId, reason = 'manager') {
  identity.revokeDevice(store, deviceId, reason);
  return { ok: true };
}

function revokeAll(store, userId, exceptTokenHash) {
  const now = nowISO();
  /* ردیف ۶۵: «بستن همهٔ نشست‌ها» بدون ابطال دستگاه‌ها بی‌اثر بود — توکن دستگاه
     همان لحظه نشست تازه می‌گرفت. حالا همهٔ دستگاه‌های کاربر (جز دستگاه جاری در
     keep_current) باطل و پاک‌سازی از راه دور می‌شوند. */
  let keepDevice = null;
  if (exceptTokenHash) {
    const cur = store.db.prepare('SELECT device_id FROM sessions WHERE token_hash=?').get(exceptTokenHash);
    keepDevice = cur ? cur.device_id : null;
  }
  const devices = identity.revokeUserDevices(store, userId, keepDevice, 'revoke_all');
  if (exceptTokenHash) {
    store.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND token_hash<>?').run(now, Number(userId), exceptTokenHash);
  } else {
    store.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, Number(userId));
  }
  const n = store.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked_at=?').get(Number(userId), now);
  try { store.audit({ user_id: Number(userId), role: 'system', action: 'revoke_all_sessions', collection: 'users', record_id: Number(userId), after: { devices } }); } catch (e) { /* noop */ }
  return { ok: true, revoked: n ? n.n : 0, devices_revoked: devices };
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
function applyDefaultCredentials(row, store) {
  const c = credentialsFor(row);
  if (!c) return row;
  if (row.password_hash) return row;
  const verifier = pbkdf2Hash(c.password);
  return Object.assign({}, row, { password_hash: verifier, phone_hash: verifier, password_enc: store ? sealSecret(store, c.password) : null });
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
  identity.prune(store);
}

module.exports = {
  findUserByLogin,
  needsSetup, setup, createPairCode, pair,
  credentialsFor, applyDefaultCredentials, phoneTaken, passwordOf, randomDigits,
  hasPassword, login, refreshWithDevice, unlockWithPassword, setPassword, changeOwnPassword,
  createTransfer, redeemTransfer,
  verifySession, listDevices, revokeDevice, logout, publicUser, prune, findUserByPhone,
  SESSION_HOURS, accessTtlMs, deviceFromToken,
  sessionDeviceRevoked: identity.sessionDeviceRevoked,
  sealSecret, openSecret, migrateSecrets, revokeAll,
};
