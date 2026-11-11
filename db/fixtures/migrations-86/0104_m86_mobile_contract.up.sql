-- phase: contract
-- requires_client_floor: 0.10.0
-- Step 3 (contract): only after every client older than 0.10.0 (the last
-- release that used phone) is refused at the door. Irreversible.
DROP TRIGGER IF EXISTS m86_sync_mobile_trg ON m86_students;
DROP FUNCTION IF EXISTS m86_sync_mobile();
ALTER TABLE m86_students DROP COLUMN phone;
