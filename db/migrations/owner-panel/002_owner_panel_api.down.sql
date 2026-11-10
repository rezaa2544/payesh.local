-- Rollback for owner-platform API migration 002. Removes only objects created
-- by 002 and leaves 001's schema, roles, policies and grants intact.
BEGIN;

REVOKE EXECUTE ON FUNCTION owner_platform.read_school_record(uuid, uuid, text, text) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.revoke_support_grant(uuid, uuid, text) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.approve_support_grant(uuid, uuid) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.request_support_grant(uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.register_platform_user(text, text, text) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.apply_subscription_transition(uuid, uuid, text, text, text, integer) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.create_plan(text, text, integer, integer, bigint, jsonb, bigint, text, boolean) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.require_actor(text[]) FROM payesh_platform_runtime;
REVOKE EXECUTE ON FUNCTION owner_platform.current_actor() FROM payesh_platform_runtime;

DROP FUNCTION IF EXISTS owner_platform.read_school_record(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS owner_platform.revoke_support_grant(uuid, uuid, text);
DROP FUNCTION IF EXISTS owner_platform.approve_support_grant(uuid, uuid);
DROP FUNCTION IF EXISTS owner_platform.request_support_grant(uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer);
DROP FUNCTION IF EXISTS owner_platform.register_platform_user(text, text, text);
DROP FUNCTION IF EXISTS owner_platform.apply_subscription_transition(uuid, uuid, text, text, text, integer);
DROP FUNCTION IF EXISTS owner_platform.create_plan(text, text, integer, integer, bigint, jsonb, bigint, text, boolean);
DROP FUNCTION IF EXISTS owner_platform.require_actor(text[]);
DROP FUNCTION IF EXISTS owner_platform.current_actor();

DO $revoke_content$
BEGIN
  IF to_regclass('public.product_records') IS NOT NULL THEN
    REVOKE SELECT ON public.product_records FROM payesh_platform_owner;
  END IF;
END
$revoke_content$;

DROP TABLE IF EXISTS owner_platform.support_grant_request;
DROP TABLE IF EXISTS owner_platform.api_rate_limit;
DROP POLICY IF EXISTS plans_owner ON owner_platform.plans;

COMMIT;
