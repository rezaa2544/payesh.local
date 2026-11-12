#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۲۶ — بستر آزمون یکپارچهٔ اپ Native پنل مالک (Flutter/Dart)

   همان پشتهٔ واقعی local-up (Gateway واقعی server/gateway.js + platform-api +
   migrationهای 001..006 روی PostgreSQL جاسازی‌شده PGlite، یا DATABASE_URL محلی)
   فقط روی 127.0.0.1 و با پوشهٔ دادهٔ موقت بالا می‌آید؛ سه حساب واقعی (دو مالک برای
   قواعد چهارچشمی + یک اپراتور) با رمز تصادفی و TOTP واقعی ساخته می‌شوند؛ یک پلن و دو
   اشتراک/مدرسه با سقف و مصرف seed می‌شود.

   خروجی: یک خط «NATIVE-IT-READY {json}» روی stdout (نشانی Gateway و پنل، شناسه/رمز/راز
   TOTP هر حساب — فقط در حافظهٔ همین فرایند آزمون). با بسته‌شدن stdin همه‌چیز خاموش و
   پوشهٔ موقت حذف می‌شود. فقط برای آزمون؛ هرگز در تولید.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const up = require('./local-up');
const { createOperator } = require('./create-operator');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-owner-native-it-'));
  const databaseUrl = process.env.DATABASE_URL ? up.assertLocalDatabaseUrl(process.env.DATABASE_URL) : null;
  const secrets = up.loadOrCreateSecrets(dataDir);
  const db = await up.openDb({ databaseUrl, dataDir });
  let servers = null;
  const stop = async () => {
    if (servers) { await up.closeServer(servers.panel); await up.closeServer(servers.gw.server); servers = null; }
    try { await db.close(); } catch (_) { /* noop */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await up.migrate(db);
    const accounts = {};
    for (const [key, role] of [['owner', 'platform_owner'], ['owner2', 'platform_owner'], ['operator', 'platform_operator']]) {
      const password = crypto.randomBytes(18).toString('base64url');
      const loginId = 'native-' + key;
      const r = await db.tx('payesh_platform_owner', q => createOperator(q, { loginId, role, password }));
      accounts[key] = { login_id: loginId, password, totp_secret: r.totpSecret, id: r.userId, role };
    }
    const tenants = [crypto.randomUUID(), crypto.randomUUID()];
    await db.query(`INSERT INTO owner_platform.plans(code,name,storage_mb,max_users,max_students) VALUES ('basic','پایه',1024,50,400)`);
    for (const t of tenants) {
      await db.query(`INSERT INTO owner_platform.subscriptions (tenant_id,plan_code,status,starts_at,ends_at)
        VALUES ($1,'basic','active',now()-interval '1 day',now()+interval '30 days')`, [t]);
    }
    await db.query(`INSERT INTO owner_platform.tenant_limits(tenant_id,max_users,max_students,storage_bytes) VALUES ($1,50,400,1073741824)`, [tenants[0]]);
    await db.query(`INSERT INTO owner_platform.tenant_usage(tenant_id,users_count,students_count,storage_bytes,last_recalc_at) VALUES ($1,12,230,268435456,now())`, [tenants[0]]);

    servers = await up.startServers({ db, secret: secrets.secret, host: '127.0.0.1', gatewayPort: 0, panelPort: 0 });
    process.stdout.write('NATIVE-IT-READY ' + JSON.stringify({
      gateway: `http://127.0.0.1:${servers.gwPort}`,
      panel: `http://127.0.0.1:${servers.port}`,
      database: db.kind,
      accounts,
      tenants,
    }) + '\n');
  } catch (e) {
    process.stderr.write('NATIVE-IT-HARNESS-FAIL ' + (e && e.stack || e) + '\n');
    await stop();
    process.exit(1);
  }
  const done = async () => { await stop(); process.exit(0); };
  process.stdin.on('end', done);
  process.stdin.on('close', done);
  process.stdin.resume();
  process.once('SIGTERM', done);
  process.once('SIGINT', done);
}

main();
