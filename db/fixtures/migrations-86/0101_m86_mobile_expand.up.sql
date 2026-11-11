-- phase: expand
-- Rename phone → mobile without downtime, step 1 (expand):
-- a new nullable column plus a trigger that keeps both columns in sync, so
-- release N-1 (reads/writes phone) and release N (reads/writes mobile) work
-- side by side on the same rows.
ALTER TABLE m86_students ADD COLUMN IF NOT EXISTS mobile text;
CREATE OR REPLACE FUNCTION m86_sync_mobile() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.mobile IS NULL THEN NEW.mobile := NEW.phone; END IF;
    IF NEW.phone IS NULL THEN NEW.phone := NEW.mobile; END IF;
  ELSE
    IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.mobile IS NOT DISTINCT FROM OLD.mobile THEN
      NEW.mobile := NEW.phone;
    ELSIF NEW.mobile IS DISTINCT FROM OLD.mobile AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
      NEW.phone := NEW.mobile;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS m86_sync_mobile_trg ON m86_students;
CREATE TRIGGER m86_sync_mobile_trg BEFORE INSERT OR UPDATE ON m86_students
  FOR EACH ROW EXECUTE FUNCTION m86_sync_mobile();
