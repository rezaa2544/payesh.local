-- Owner platform — migration 003: two-person tenant deletion with a 24h delay.
--
-- Source rules (not new decisions):
--   docs/cloud/12b-owner-panel-boundaries.md §100  حذف مستأجر = owner + تأیید دوم (four-eyes) + تأخیر ۲۴ ساعته
--   docs/cloud/12b-owner-panel-boundaries.md §32   حذف کامل مستأجر فقط owner، دو مرحله
--   docs/cloud/16b-tenant-provisioning-migration.md §1.3 / D-22  داده ≥۱۸۰ روز حفظ می‌شود؛
--     نابودی کلید فقط پس از ۱۸۰ روز و با تأیید مالک، خارج از این API
--
-- "Execute" therefore means: the request is closed, every live subscription
-- of the tenant is canceled (service stops), and a retention date of at least
-- 180 days is recorded. No school row, backup, key or storage object is
-- removed here. Physical destruction stays an offline, owner-approved step.
--
-- Additive and reversible. Runtime gets SELECT only on the new table; every
-- state change goes through a SECURITY DEFINER function owned by
-- payesh_platform_owner that re-reads the actor's real role (002's
-- require_actor). The four-eyes and 24h invariants are also CHECK constraints,
-- so even a privileged direct UPDATE cannot shorten the delay or self-approve.
--
-- Apply only after 001 and 002. Roll back 003 before 002.
BEGIN;

CREATE TABLE owner_platform.tenant_deletion_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  approved_at timestamptz,
  not_before timestamptz,
  canceled_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canceled_at timestamptz,
  cancel_reason text,
  executed_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  executed_at timestamptz,
  retain_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_deletion_reason_check CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT tenant_deletion_status_check CHECK (status IN ('pending', 'approved', 'canceled', 'executed')),
  CONSTRAINT tenant_deletion_four_eyes_check CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT tenant_deletion_approval_shape_check CHECK (
    (approved_by IS NULL AND approved_at IS NULL AND not_before IS NULL)
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND not_before IS NOT NULL)),
  CONSTRAINT tenant_deletion_delay_check CHECK (not_before IS NULL OR not_before >= approved_at + interval '24 hours'),
  CONSTRAINT tenant_deletion_approved_check CHECK (status NOT IN ('approved', 'executed') OR approved_by IS NOT NULL),
  CONSTRAINT tenant_deletion_cancel_check CHECK (
    (status = 'canceled') = (canceled_at IS NOT NULL AND canceled_by IS NOT NULL
                             AND length(btrim(coalesce(cancel_reason, ''))) >= 10)),
  CONSTRAINT tenant_deletion_executed_check CHECK (
    (status = 'executed') = (executed_at IS NOT NULL AND executed_by IS NOT NULL AND retain_until IS NOT NULL)),
  CONSTRAINT tenant_deletion_not_early_check CHECK (executed_at IS NULL OR executed_at >= not_before),
  CONSTRAINT tenant_deletion_retention_check CHECK (retain_until IS NULL OR retain_until >= executed_at + interval '180 days')
);

-- At most one open (pending/approved) request per tenant.
CREATE UNIQUE INDEX tenant_deletion_one_open_idx
  ON owner_platform.tenant_deletion_request (tenant_id)
  WHERE status IN ('pending', 'approved');

ALTER TABLE owner_platform.tenant_deletion_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.tenant_deletion_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_deletion_request_tenant_isolation ON owner_platform.tenant_deletion_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_deletion_request_runtime_read ON owner_platform.tenant_deletion_request
  FOR SELECT TO payesh_platform_runtime USING (true);
CREATE POLICY tenant_deletion_request_owner ON owner_platform.tenant_deletion_request
  TO payesh_platform_owner USING (true) WITH CHECK (true);

-- Read only. No INSERT/UPDATE/DELETE for the runtime role.
GRANT SELECT ON owner_platform.tenant_deletion_request TO payesh_platform_runtime;

-- SECURITY DEFINER functions write subscriptions/subscription_event as the
-- function owner. 001 already gives payesh_platform_owner full metadata
-- access through the _migration_metadata_access policies.

CREATE FUNCTION owner_platform.request_tenant_deletion(
  p_tenant_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'deletion reason must be at least 10 characters' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM owner_platform.subscriptions WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'unknown tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO owner_platform.tenant_deletion_request (tenant_id, requested_by, reason, status)
  VALUES (p_tenant_id, owner_platform.current_actor(), btrim(p_reason), 'pending')
  RETURNING to_jsonb(tenant_deletion_request) INTO result;
  RETURN result;
END
$fn$;

-- Second person: an active platform_owner who is not the requester. The
-- earliest execution time is fixed here and cannot be shortened later.
CREATE FUNCTION owner_platform.approve_tenant_deletion(
  p_request_id uuid, p_tenant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  r owner_platform.tenant_deletion_request%ROWTYPE;
  approver uuid;
  t timestamptz := clock_timestamp();
  result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  approver := owner_platform.current_actor();
  SELECT * INTO r FROM owner_platform.tenant_deletion_request
    WHERE id = p_request_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'no pending deletion request for this tenant' USING ERRCODE = '42501';
  END IF;
  IF r.requested_by = approver THEN
    RAISE EXCEPTION 'the requester cannot approve their own deletion request' USING ERRCODE = '42501';
  END IF;
  UPDATE owner_platform.tenant_deletion_request
    SET status = 'approved', approved_by = approver, approved_at = t,
        not_before = t + interval '24 hours'
    WHERE id = r.id
    RETURNING to_jsonb(tenant_deletion_request) INTO result;
  RETURN result;
END
$fn$;

-- Any active owner may stop a pending or approved request before execution.
CREATE FUNCTION owner_platform.cancel_tenant_deletion(
  p_request_id uuid, p_tenant_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'cancel reason must be at least 10 characters' USING ERRCODE = '23514';
  END IF;
  UPDATE owner_platform.tenant_deletion_request
    SET status = 'canceled', canceled_by = owner_platform.current_actor(),
        canceled_at = clock_timestamp(), cancel_reason = btrim(p_reason)
    WHERE id = p_request_id AND tenant_id = p_tenant_id AND status IN ('pending', 'approved')
    RETURNING to_jsonb(tenant_deletion_request) INTO result;
  IF result IS NULL THEN
    RAISE EXCEPTION 'no open deletion request for this tenant' USING ERRCODE = '42501';
  END IF;
  RETURN result;
END
$fn$;

-- Only after approval and only once not_before has passed. The effect is a
-- service stop plus a retention date; no school data is destroyed.
CREATE FUNCTION owner_platform.execute_tenant_deletion(
  p_request_id uuid, p_tenant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  r owner_platform.tenant_deletion_request%ROWTYPE;
  actor uuid;
  actor_ref text;
  t timestamptz := clock_timestamp();
  s record;
  n integer := 0;
  result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  actor := owner_platform.current_actor();
  SELECT * INTO r FROM owner_platform.tenant_deletion_request
    WHERE id = p_request_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'approved' THEN
    RAISE EXCEPTION 'no approved deletion request for this tenant' USING ERRCODE = '42501';
  END IF;
  IF t < r.not_before THEN
    RAISE EXCEPTION 'the 24 hour deletion delay has not elapsed' USING ERRCODE = '42501';
  END IF;
  SELECT login_id INTO actor_ref FROM owner_platform.platform_users WHERE id = actor;
  FOR s IN SELECT id, status FROM owner_platform.subscriptions
           WHERE tenant_id = p_tenant_id
             AND status IN ('draft', 'provisioning', 'active', 'grace', 'suspended')
           FOR UPDATE LOOP
    INSERT INTO owner_platform.subscription_event
      (tenant_id, subscription_id, from_status, to_status, reason, actor_ref, idempotency_key)
    VALUES (p_tenant_id, s.id, s.status, 'canceled', 'cancel',
            coalesce(actor_ref, actor::text), 'tenant-deletion:' || r.id::text || ':' || s.id::text);
    UPDATE owner_platform.subscriptions
      SET status = 'canceled', canceled_at = t, auto_renew = false,
          version = version + 1, updated_at = t
      WHERE id = s.id;
    n := n + 1;
  END LOOP;
  UPDATE owner_platform.tenant_deletion_request
    SET status = 'executed', executed_by = actor, executed_at = t,
        retain_until = t + interval '180 days'
    WHERE id = r.id
    RETURNING to_jsonb(tenant_deletion_request) INTO result;
  RETURN result || jsonb_build_object('subscriptions_canceled', n, 'data_destroyed', false);
END
$fn$;

ALTER TABLE owner_platform.tenant_deletion_request OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.request_tenant_deletion(uuid, text) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.approve_tenant_deletion(uuid, uuid) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.cancel_tenant_deletion(uuid, uuid, text) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.execute_tenant_deletion(uuid, uuid) OWNER TO payesh_platform_owner;

REVOKE ALL ON FUNCTION owner_platform.request_tenant_deletion(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.approve_tenant_deletion(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.cancel_tenant_deletion(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.execute_tenant_deletion(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_platform.request_tenant_deletion(uuid, text) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.approve_tenant_deletion(uuid, uuid) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.cancel_tenant_deletion(uuid, uuid, text) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.execute_tenant_deletion(uuid, uuid) TO payesh_platform_runtime;

COMMIT;
