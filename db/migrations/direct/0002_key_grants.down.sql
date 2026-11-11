-- Row 107 rollback: removes the key tables, functions and columns added by 0002.
-- Ciphertext in record.sealed is dropped with the column — run only on a
-- database that has no production data on the direct path (rollback drill).
DROP FUNCTION IF EXISTS payesh_direct.put_key_grant(uuid, text, integer, integer, text);
DROP FUNCTION IF EXISTS payesh_direct.publish_scope_key(text, integer, integer, text);
DROP FUNCTION IF EXISTS payesh_direct.register_device_key(text);
DROP FUNCTION IF EXISTS payesh_direct.scope_covered(uuid, uuid, text);
DROP TABLE IF EXISTS payesh_direct.key_grant;
DROP TABLE IF EXISTS payesh_direct.scope_key;
ALTER TABLE payesh_direct.record DROP CONSTRAINT IF EXISTS record_live_is_sealed;
ALTER TABLE payesh_direct.record DROP CONSTRAINT IF EXISTS record_payload_empty;
ALTER TABLE payesh_direct.record DROP COLUMN IF EXISTS sealed;
ALTER TABLE payesh_direct.device DROP COLUMN IF EXISTS public_key;
