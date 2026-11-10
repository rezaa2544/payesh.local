#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ساخت حساب اپراتور پنل مالک روی سرور — D‑45 (O‑17 = A)

   نخستین حساب (و هر حساب بعدی تا سقف ۳) فقط با همین اسکریپت، روی سرور و با
   اتصال مدیر migration ساخته می‌شود؛ API هیچ مسیر ثبت‌نام/بازنشانی ندارد.

   اجرا:
     PAYESH_PLATFORM_MIGRATION_URL=postgres://… \
       node apps/owner-panel/scripts/create-operator.js --login-id <id> [--role platform_owner]

   رمز عبور (حداقل ۱۲ نویسه) بدون نمایش از ترمینال پرسیده می‌شود؛ برای اجرای
   غیرتعاملی می‌توان PAYESH_OPERATOR_PASSWORD را فقط در همان فرمان داد.
   خروجی: یک URI از نوع otpauth:// که باید یک‌بار در برنامهٔ Authenticator ثبت
   شود. راز TOTP جای دیگری چاپ یا ذخیره نمی‌شود؛ رمز عبور هرگز چاپ نمی‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const auth = require('../server/owner-auth');

const ROLES = ['platform_owner', 'platform_operator', 'platform_support'];
const LOGIN_RE = /^[A-Za-z0-9._@-]{3,120}$/;

/**
 * Creates (or attaches credentials to) one platform user inside an already open
 * transaction. `q(sql, params)` must run as the migration owner
 * (payesh_platform_owner). Throws on the 3-account cap (23514).
 */
async function createOperator(q, { loginId, role = 'platform_owner', password }) {
  if (!LOGIN_RE.test(String(loginId || ''))) throw new Error('login id: 3–120 chars of A-Z a-z 0-9 . _ @ -');
  if (!ROLES.includes(role)) throw new Error('role must be one of ' + ROLES.join(', '));
  const passwordHash = await auth.hashPassword(password);
  const totpSecret = auth.newTotpSecret();
  const existing = await q('SELECT id, role FROM owner_platform.platform_users WHERE login_id = $1', [loginId]);
  let userId;
  if (existing.rows.length) {
    userId = existing.rows[0].id;
    if (existing.rows[0].role !== role) throw new Error('existing user has a different role; refusing to change it');
  } else {
    const r = await q(`INSERT INTO owner_platform.platform_users (login_id, role, status)
      VALUES ($1, $2, 'active') RETURNING id`, [loginId, role]);
    userId = r.rows[0].id;
  }
  await q(`INSERT INTO owner_platform.platform_credentials (user_id, password_hash, totp_secret)
    VALUES ($1, $2, $3)`, [userId, passwordHash, totpSecret]);
  return { userId, role, otpauth: auth.otpauthUri(loginId, totpSecret), totpSecret };
}

function parseArgs(argv) {
  const out = { role: 'platform_owner' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--login-id') out.loginId = argv[++i];
    else if (argv[i] === '--role') out.role = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error('unknown argument: ' + argv[i]);
  }
  return out;
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('no TTY: set PAYESH_OPERATOR_PASSWORD for non-interactive use'));
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stderr.write('\n'); resolve(value);
      } else if (ch === '\u0003') { stdin.setRawMode(false); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.loginId) {
    process.stderr.write('usage: PAYESH_PLATFORM_MIGRATION_URL=… node create-operator.js --login-id <id> [--role platform_owner|platform_operator|platform_support]\n');
    process.exit(args.help ? 0 : 2);
  }
  const url = process.env.PAYESH_PLATFORM_MIGRATION_URL;
  if (!url) throw new Error('PAYESH_PLATFORM_MIGRATION_URL is not set');
  let password = process.env.PAYESH_OPERATOR_PASSWORD;
  if (!password) {
    password = await askHidden('password (min 12 chars): ');
    const again = await askHidden('repeat password: ');
    if (password !== again) throw new Error('passwords do not match');
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, application_name: 'payesh-owner-create-operator' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE payesh_platform_owner');
    const r = await createOperator((sql, p = []) => client.query(sql, p), { loginId: args.loginId, role: args.role, password });
    await client.query('COMMIT');
    process.stdout.write(`created: login_id=${args.loginId} role=${r.role} user_id=${r.userId}\n`);
    process.stdout.write('Scan once in an authenticator app, then clear this terminal:\n');
    process.stdout.write(r.otpauth + '\n');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e && e.code === '23514') throw new Error('operator cap reached: at most 3 login accounts (D-45)');
    throw e;
  } finally {
    await client.end();
  }
}

module.exports = { createOperator, parseArgs, LOGIN_RE };

if (require.main === module) {
  main().catch((e) => { process.stderr.write('create-operator: ' + (e && e.message || e) + '\n'); process.exit(1); });
}
