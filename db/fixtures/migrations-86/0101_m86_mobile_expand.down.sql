DROP TRIGGER IF EXISTS m86_sync_mobile_trg ON m86_students;
DROP FUNCTION IF EXISTS m86_sync_mobile();
ALTER TABLE m86_students DROP COLUMN IF EXISTS mobile;
