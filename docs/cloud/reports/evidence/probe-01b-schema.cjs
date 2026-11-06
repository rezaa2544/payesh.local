const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
const out = [];
function t(label, sql) {
  try { db.exec(sql); out.push(`[OK]   ${label}`); }
  catch (e) { out.push(`[ERR]  ${label} → ${e.message}`); }
}
t('N1 partial unique با now() در predicate',
  `CREATE TABLE g1(id TEXT PRIMARY KEY, operator_id TEXT, revoked_at TEXT, ends_at TEXT);
   CREATE UNIQUE INDEX u1 ON g1(operator_id) WHERE revoked_at IS NULL AND ends_at > CURRENT_TIMESTAMP;`);
t('N2 partial unique با تابع deterministic (datetime) در predicate',
  `CREATE TABLE g2(id TEXT PRIMARY KEY, operator_id TEXT, revoked_at TEXT, ends_at TEXT);
   CREATE UNIQUE INDEX u2 ON g2(operator_id) WHERE revoked_at IS NULL AND datetime(ends_at) > '2020-01-01';`);
t('N3 راه‌حل open_slot (UNIQUE + CHECK)',
  `CREATE TABLE g3(id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, open_slot INTEGER,
     CHECK(open_slot IS NULL OR open_slot = 1));
   CREATE UNIQUE INDEX u3 ON g3(operator_id, open_slot);`);
t('N3b درج دو مجوز باز برای یک اپراتور (باید رد شود)',
  `INSERT INTO g3 VALUES ('a','op1',1); INSERT INTO g3 VALUES ('b','op1',1);`);
t('N3c درج سومی پس از بستن اولی (باید موفق شود)',
  `UPDATE g3 SET open_slot=NULL WHERE id='a'; INSERT INTO g3 VALUES ('c','op1',1);`);
t('N4 CHECK حل‌شده با max_ends_at',
  `CREATE TABLE g4(id TEXT PRIMARY KEY, starts_at TEXT, ends_at TEXT, max_ends_at TEXT,
     CHECK(ends_at > starts_at AND ends_at <= max_ends_at));`);
t('N4b نقض سقف ۷۲ ساعت (باید رد شود)',
  `INSERT INTO g4 VALUES ('x','2026-01-01T00:00:00Z','2026-01-05T00:00:00Z','2026-01-04T00:00:00Z');`);
t('N5 partial unique روی ستون status برای subscription',
  `CREATE TABLE s(id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT);
   CREATE UNIQUE INDEX u5 ON s(tenant_id) WHERE status IN ('draft','provisioning','active','grace','suspended');`);
t('N5b دو اشتراک جاری برای یک مدرسه (باید رد شود)',
  `INSERT INTO s VALUES ('s1','t1','active'); INSERT INTO s VALUES ('s2','t1','grace');`);
t('N5c اشتراک تازه پس از expired (باید موفق شود)',
  `UPDATE s SET status='expired' WHERE id='s1'; UPDATE s SET status='expired' WHERE id='s2'; INSERT INTO s VALUES ('s3','t1','active');`);
console.log(out.join('\n'));
