-- Rollback for owner-platform migration 003. Removes only objects created by
-- 003; 001/002 schema, roles, policies, grants and subscription history stay.
-- Subscriptions already canceled by an executed request are NOT re-activated.
BEGIN;

REVOKE EXECUTE ON FUNCTION owner_platform.execute_tenant_deletion(uuid, uuid) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.cancel_tenant_deletion(uuid, uuid, text) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.approve_tenant_deletion(uuid, uuid) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.request_tenant_deletion(uuid, text) FROM payesh_platform_runtime;

DROP FUNCTION IF EXISTS owner_platform.execute_tenant_deletion(uuid, uuid);
DROP FUNCTION IF EXISTS owner_platform.cancel_tenant_deletion(uuid, uuid, text);
DROP FUNCTION IF EXISTS owner_platform.approve_tenant_deletion(uuid, uuid);
DROP FUNCTION IF EXISTS owner_platform.request_tenant_deletion(uuid, text);

DROP TABLE IF EXISTS owner_platform.tenant_deletion_request;

COMMIT;
