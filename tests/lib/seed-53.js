'use strict';
/* کاشت شبیه‌سازی سه‌ساله برای ردیف ۵۳ — مشترک بین آزمون و ابزار اندازه‌گیری */
function seed(store, { totalRows = 120000, collections, now = new Date('2026-11-07T00:00:00.000Z') } = {}) {
  const cols = collections;
  const ins = store.db.prepare(
    `INSERT INTO records(collection,id,data,version,ref1,ref2,day,created_at,updated_at,deleted_at)
     VALUES(?,?,?,?,?,?,?,?,?,NULL)`
  );
  const ids = {};
  const year = now.getUTCFullYear(), month = now.getUTCMonth();
  store.db.exec('BEGIN');
  for (let i = 0; i < totalRows; i++) {
    const c = cols[i % cols.length];
    ids[c] = (ids[c] || 0) + 1;
    const id = ids[c];
    const monthOffset = i % 34;                              /* ۰..۳۳ ماه پیش */
    const d = new Date(Date.UTC(year, month - monthOffset, (i % 27) + 1));
    const day = d.toISOString().slice(0, 10);
    ins.run(c, id, JSON.stringify({ student_id: (i % 500) + 1, class_id: (i % 30) + 1, status: 'present', note: 'ردیف ' + id }), 1,
      (i % 30) + 1, (i % 500) + 1, day, day + 'T00:00:00.000Z', day + 'T00:00:00.000Z');
  }
  store.db.exec('COMMIT');
  return { collections: cols, rows: totalRows };
}
module.exports = { seed };
