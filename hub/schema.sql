-- پایگاه‌دادهٔ Hub (Cloudflare D1 — SQLite)
-- فقط «نمای خانواده»؛ دادهٔ خام مدرسه این‌جا نمی‌آید.

CREATE TABLE IF NOT EXISTS projection (
  student_id INTEGER PRIMARY KEY,
  family_key TEXT NOT NULL,          -- sha256(توکن خانواده) — مدرسه می‌سازد
  payload    TEXT NOT NULL,          -- JSON خلاصه: حضور، نمرات، اطلاعیه‌ها
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_projection_family ON projection(family_key);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT UNIQUE NOT NULL,
  student_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  drained_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(drained_at);
