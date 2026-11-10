-- Rollback for owner-platform migration 004. Removes only objects created by
-- 004 (credentials, login events, their functions/triggers). 001–003 stay.
-- After rollback no human can log in: the API answers 501 login_not_installed
-- (fail-closed). Login events are destroyed with the table — export them first
-- if they must be kept.
BEGIN;

REVOKE EXECUTE ON FUNCTION owner_platform.record_login_attempt(uuid, text, text, text, bigint, text) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.login_lookup(text) FROM payesh_platform_runtime;

DROP FUNCTION IF EXISTS owner_platform.record_login_attempt(uuid, text, text, text, bigint, text);
DROP FUNCTION IF EXISTS owner_platform.login_lookup(text);
DROP TABLE IF EXISTS owner_platform.login_event;
DROP TABLE IF EXISTS owner_platform.platform_credentials;
DROP FUNCTION IF EXISTS owner_platform.reject_login_event_change();
DROP FUNCTION IF EXISTS owner_platform.enforce_operator_cap();

COMMIT;
