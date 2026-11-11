-- Rollback for owner-platform migration 005 (row 121). Removes only the registry and its two
-- functions. Subscriptions, limits and audit rows written through 005 stay (they belong to 001).
-- School-side rows (initial manager, activation codes) live in the school database and are not
-- touched. Do not run against production without the Owner's change approval and a backup.
BEGIN;
REVOKE EXECUTE ON FUNCTION owner_platform.activate_tenant(uuid) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.provision_tenant(uuid, text, text, text) FROM payesh_platform_runtime;
DROP FUNCTION IF EXISTS owner_platform.activate_tenant(uuid);
DROP FUNCTION IF EXISTS owner_platform.provision_tenant(uuid, text, text, text);
DROP TABLE IF EXISTS owner_platform.tenant_registry;
COMMIT;
