-- Owner-platform migration 005 — create a school from the owner panel (row 121).
-- 16b §1 provision steps 1,2,5,8 on the platform side: registry row (slug, name), a fresh
-- unguessable tenant_id, the subscription in `provisioning`, tenant limits from the plan, and
-- the audit trail. The school side (initial manager + one-time activation code) is written by
-- the Gateway with the SCHOOL runtime role under the school table's forced RLS — this migration
-- grants the platform nothing on product data.
-- Idempotent by provision_op_id (16b §1.4): the same op returns the same tenant, never a second
-- one. A slug belongs to one tenant forever (UNIQUE), so a retried request cannot fork a school.
-- Activation (provisioning → active) is a separate owner-only call made after the school side
-- succeeded, so a half-provisioned school never shows as active.
BEGIN;

CREATE TABLE owner_platform.tenant_registry (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'provisioning',
  provision_op_id uuid NOT NULL UNIQUE,
  plan_code text NOT NULL REFERENCES owner_platform.plans(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT tenant_registry_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  CONSTRAINT tenant_registry_name_check CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  CONSTRAINT tenant_registry_status_check CHECK (status IN ('provisioning', 'active')),
  CONSTRAINT tenant_registry_active_check CHECK ((status = 'active') = (activated_at IS NOT NULL))
);

ALTER TABLE owner_platform.tenant_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.tenant_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_registry_tenant_isolation ON owner_platform.tenant_registry
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_registry_runtime_read ON owner_platform.tenant_registry
  FOR SELECT TO payesh_platform_runtime USING (true);
CREATE POLICY tenant_registry_owner ON owner_platform.tenant_registry
  TO payesh_platform_owner USING (true) WITH CHECK (true);

CREATE FUNCTION owner_platform.provision_tenant(
  p_op_id uuid, p_slug text, p_name text, p_plan_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  actor uuid;
  actor_ref text;
  reg owner_platform.tenant_registry%ROWTYPE;
  pl owner_platform.plans%ROWTYPE;
  sid uuid;
  t timestamptz := clock_timestamp();
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  actor := owner_platform.current_actor();
  IF p_op_id IS NULL THEN
    RAISE EXCEPTION 'provision_op_id is required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO reg FROM owner_platform.tenant_registry WHERE provision_op_id = p_op_id;
  IF FOUND THEN
    IF reg.slug <> p_slug THEN
      RAISE EXCEPTION 'provision_op_id was used for another school' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(reg) || jsonb_build_object('idempotent', true);
  END IF;
  SELECT * INTO pl FROM owner_platform.plans WHERE code = p_plan_code AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown or archived plan' USING ERRCODE = '23503';
  END IF;
  INSERT INTO owner_platform.tenant_registry (slug, display_name, provision_op_id, plan_code, created_by)
    VALUES (p_slug, btrim(p_name), p_op_id, p_plan_code, actor)
    RETURNING * INTO reg;
  INSERT INTO owner_platform.subscriptions (tenant_id, plan_code, status, starts_at, ends_at)
    VALUES (reg.tenant_id, p_plan_code, 'provisioning', t, t + interval '30 days')
    RETURNING id INTO sid;
  SELECT login_id INTO actor_ref FROM owner_platform.platform_users WHERE id = actor;
  INSERT INTO owner_platform.subscription_event
    (tenant_id, subscription_id, from_status, to_status, reason, actor_ref, idempotency_key)
    VALUES (reg.tenant_id, sid, NULL, 'provisioning', 'owner_action',
            coalesce(actor_ref, actor::text), 'provision:' || p_op_id::text);
  INSERT INTO owner_platform.tenant_limits (tenant_id, max_users, max_students, storage_bytes)
    VALUES (reg.tenant_id, pl.max_users, pl.max_students, pl.storage_mb * 1048576);
  RETURN to_jsonb(reg) || jsonb_build_object('idempotent', false, 'subscription_id', sid);
END
$fn$;

CREATE FUNCTION owner_platform.activate_tenant(p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  actor uuid;
  actor_ref text;
  reg owner_platform.tenant_registry%ROWTYPE;
  s record;
  t timestamptz := clock_timestamp();
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  actor := owner_platform.current_actor();
  SELECT * INTO reg FROM owner_platform.tenant_registry WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'school is not in the registry' USING ERRCODE = '42501';
  END IF;
  IF reg.status = 'active' THEN
    RETURN to_jsonb(reg) || jsonb_build_object('idempotent', true);
  END IF;
  SELECT login_id INTO actor_ref FROM owner_platform.platform_users WHERE id = actor;
  FOR s IN SELECT id FROM owner_platform.subscriptions
           WHERE tenant_id = p_tenant_id AND status = 'provisioning' FOR UPDATE LOOP
    INSERT INTO owner_platform.subscription_event
      (tenant_id, subscription_id, from_status, to_status, reason, actor_ref, idempotency_key)
      VALUES (p_tenant_id, s.id, 'provisioning', 'active', 'owner_action',
              coalesce(actor_ref, actor::text), 'activate:' || reg.provision_op_id::text);
    UPDATE owner_platform.subscriptions
      SET status = 'active', version = version + 1, updated_at = t WHERE id = s.id;
  END LOOP;
  UPDATE owner_platform.tenant_registry SET status = 'active', activated_at = t
    WHERE tenant_id = p_tenant_id RETURNING * INTO reg;
  RETURN to_jsonb(reg) || jsonb_build_object('idempotent', false);
END
$fn$;

ALTER TABLE owner_platform.tenant_registry OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.provision_tenant(uuid, text, text, text) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.activate_tenant(uuid) OWNER TO payesh_platform_owner;
REVOKE ALL ON owner_platform.tenant_registry FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.provision_tenant(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.activate_tenant(uuid) FROM PUBLIC;
GRANT SELECT ON owner_platform.tenant_registry TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.provision_tenant(uuid, text, text, text) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.activate_tenant(uuid) TO payesh_platform_runtime;

COMMIT;
