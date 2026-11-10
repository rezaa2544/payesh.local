-- Owner platform API v1 — PR-2. Versioned, additive, reversible.
--
-- PR-1 deliberately gave the runtime role NO insert/update/delete on
-- subscriptions and NO privilege on school content. This migration does not
-- widen those grants. Every write goes through a SECURITY DEFINER function
-- owned by payesh_platform_owner which re-reads the actor's real role from
-- owner_platform.platform_users (never from the request body or a token
-- claim) and re-checks the invariant at the data boundary.
--
-- Apply only after 001_owner_panel.up.sql. See README.md in this directory.
BEGIN;

-- The plans table had a runtime policy but no owner policy; SECURITY DEFINER
-- functions owned by payesh_platform_owner need one to write plans.
CREATE POLICY plans_owner ON owner_platform.plans
  TO payesh_platform_owner USING (true) WITH CHECK (true);

-- Rate limiting is a database row (one bucket per actor per fixed window), so
-- two Gateway instances share it. It is not an in-process counter.
CREATE TABLE owner_platform.api_rate_limit (
  subject text NOT NULL,
  window_start bigint NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, window_start)
);

-- A grant is created only when an active platform owner approves it (PR-1's
-- approved_by is NOT NULL). The request/approve split lives here so PR-1's
-- four-eyes and non-renewable invariants stay unchanged.
CREATE TABLE owner_platform.support_grant_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  case_ref text,
  scope text NOT NULL,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  school_notified_at timestamptz NOT NULL,
  max_actions integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

ALTER TABLE owner_platform.api_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.api_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY api_rate_limit_runtime ON owner_platform.api_rate_limit
  TO payesh_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY api_rate_limit_owner ON owner_platform.api_rate_limit
  TO payesh_platform_owner USING (true) WITH CHECK (true);

ALTER TABLE owner_platform.support_grant_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.support_grant_request FORCE ROW LEVEL SECURITY;
CREATE POLICY support_grant_request_tenant_isolation ON owner_platform.support_grant_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY support_grant_request_runtime ON owner_platform.support_grant_request
  TO payesh_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY support_grant_request_owner ON owner_platform.support_grant_request
  TO payesh_platform_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON owner_platform.api_rate_limit TO payesh_platform_runtime;
GRANT SELECT, INSERT, UPDATE ON owner_platform.support_grant_request TO payesh_platform_runtime;

-- Actor identity is the token's `sub`, placed in a transaction-local GUC by
-- the API. The authoritative role/status is read back from the table: a
-- forged role claim in a token buys nothing.
CREATE FUNCTION owner_platform.current_actor() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, owner_platform
AS $fn$
  SELECT nullif(current_setting('app.platform_user_id', true), '')::uuid
$fn$;

CREATE FUNCTION owner_platform.require_actor(p_allowed text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  a uuid;
  r text;
BEGIN
  a := owner_platform.current_actor();
  IF a IS NULL THEN
    RAISE EXCEPTION 'platform actor context is missing' USING ERRCODE = '42501';
  END IF;
  SELECT CASE WHEN status = 'active' THEN role ELSE NULL END INTO r
    FROM owner_platform.platform_users WHERE id = a;
  IF r IS NULL OR NOT (r = ANY (p_allowed)) THEN
    RAISE EXCEPTION 'platform actor is not allowed to perform this action'
      USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE FUNCTION owner_platform.create_plan(
  p_code text, p_name text, p_max_users integer, p_max_students integer,
  p_storage_mb bigint, p_features jsonb, p_price_amount bigint,
  p_price_cycle text, p_is_public boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  INSERT INTO owner_platform.plans
    (code, name, max_users, max_students, storage_mb, features,
     price_amount, price_cycle, is_public)
  VALUES (p_code, p_name, p_max_users, p_max_students, p_storage_mb,
          coalesce(p_features, '{}'::jsonb), coalesce(p_price_amount, 0),
          p_price_cycle, coalesce(p_is_public, false))
  RETURNING to_jsonb(plans) INTO result;
  RETURN result;
END
$fn$;

-- Only an active platform_owner may renew/activate/cancel. An operator may
-- suspend, but only with a recorded reason; operators never renew or delete.
CREATE FUNCTION owner_platform.apply_subscription_transition(
  p_subscription_id uuid, p_tenant_id uuid, p_to_status text,
  p_note text, p_idempotency_key text, p_extend_days integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  s owner_platform.subscriptions%ROWTYPE;
  actor uuid;
  actor_ref text;
  reason_code text;
  prior jsonb;
BEGIN
  IF p_to_status = 'suspended' THEN
    PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  ELSE
    PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  END IF;
  IF p_to_status NOT IN ('active', 'suspended', 'canceled') THEN
    RAISE EXCEPTION 'unsupported subscription transition' USING ERRCODE = '23514';
  END IF;
  IF length(btrim(coalesce(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required' USING ERRCODE = '23514';
  END IF;
  IF length(btrim(coalesce(p_idempotency_key, ''))) = 0 THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '23514';
  END IF;

  SELECT to_jsonb(e) INTO prior FROM owner_platform.subscription_event e
    WHERE e.tenant_id = p_tenant_id AND e.idempotency_key = p_idempotency_key;
  IF prior IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'event', prior);
  END IF;

  SELECT * INTO s FROM owner_platform.subscriptions
    WHERE id = p_subscription_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription does not belong to this tenant' USING ERRCODE = '42501';
  END IF;

  actor := owner_platform.current_actor();
  SELECT login_id INTO actor_ref FROM owner_platform.platform_users WHERE id = actor;
  reason_code := CASE p_to_status
    WHEN 'active' THEN 'renew'
    WHEN 'canceled' THEN 'cancel'
    ELSE 'owner_action' END;

  INSERT INTO owner_platform.subscription_event
    (tenant_id, subscription_id, from_status, to_status, reason, actor_ref, idempotency_key)
  VALUES (p_tenant_id, p_subscription_id, s.status, p_to_status, reason_code,
          coalesce(actor_ref, actor::text), p_idempotency_key);

  IF p_to_status = 'active' THEN
    UPDATE owner_platform.subscriptions
      SET status = 'active', version = version + 1, updated_at = now(),
          ends_at = greatest(ends_at, now()) + (greatest(coalesce(p_extend_days, 30), 1) * interval '1 day'),
          canceled_at = NULL
      WHERE id = p_subscription_id AND tenant_id = p_tenant_id;
  ELSIF p_to_status = 'canceled' THEN
    UPDATE owner_platform.subscriptions
      SET status = 'canceled', version = version + 1, updated_at = now(),
          canceled_at = now(), auto_renew = false
      WHERE id = p_subscription_id AND tenant_id = p_tenant_id;
  ELSE
    UPDATE owner_platform.subscriptions
      SET status = 'suspended', version = version + 1, updated_at = now()
      WHERE id = p_subscription_id AND tenant_id = p_tenant_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'idempotent', false,
    'subscription_id', p_subscription_id, 'tenant_id', p_tenant_id,
    'from_status', s.status, 'to_status', p_to_status, 'note', p_note);
END
$fn$;

CREATE FUNCTION owner_platform.register_platform_user(
  p_login_id text, p_role text, p_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  IF p_role NOT IN ('platform_owner', 'platform_operator', 'platform_support')
     OR p_status NOT IN ('active', 'disabled')
     OR length(btrim(coalesce(p_login_id, ''))) = 0 THEN
    RAISE EXCEPTION 'invalid platform user attributes' USING ERRCODE = '23514';
  END IF;
  INSERT INTO owner_platform.platform_users (login_id, role, status)
  VALUES (btrim(p_login_id), p_role, p_status)
  RETURNING to_jsonb(platform_users) INTO result;
  RETURN result;
END
$fn$;

-- Requester may be an operator or support engineer. content_write is not a
-- valid scope at all; the school must be notified before the window opens.
CREATE FUNCTION owner_platform.request_support_grant(
  p_tenant_id uuid, p_scope text, p_reason text, p_case_ref text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_school_notified_at timestamptz, p_max_actions integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  actor uuid;
  result jsonb;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_operator', 'platform_support']);
  IF p_scope NOT IN ('metadata', 'content_read') THEN
    RAISE EXCEPTION 'grant scope must be metadata or content_read' USING ERRCODE = '23514';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'grant reason must be at least 10 characters' USING ERRCODE = '23514';
  END IF;
  IF p_ends_at <= p_starts_at OR p_ends_at > p_starts_at + interval '72 hours' THEN
    RAISE EXCEPTION 'grant window must be positive and at most 72 hours' USING ERRCODE = '23514';
  END IF;
  IF p_school_notified_at >= p_starts_at THEN
    RAISE EXCEPTION 'school must be notified before the grant starts' USING ERRCODE = '23514';
  END IF;
  IF coalesce(p_max_actions, 0) < 1 OR coalesce(p_max_actions, 0) > 50 THEN
    RAISE EXCEPTION 'grant action cap must be between 1 and 50' USING ERRCODE = '23514';
  END IF;
  actor := owner_platform.current_actor();
  INSERT INTO owner_platform.support_grant_request
    (tenant_id, operator_id, case_ref, scope, reason, starts_at, ends_at,
     school_notified_at, max_actions, status)
  VALUES (p_tenant_id, actor, p_case_ref, p_scope, p_reason, p_starts_at,
          p_ends_at, p_school_notified_at, p_max_actions, 'pending')
  RETURNING to_jsonb(support_grant_request) INTO result;
  RETURN result;
END
$fn$;

-- Four eyes: an active platform_owner, never the requester, creates the grant.
-- PR-1's insert trigger re-checks the approver at the data boundary.
CREATE FUNCTION owner_platform.approve_support_grant(
  p_request_id uuid, p_tenant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  r owner_platform.support_grant_request%ROWTYPE;
  approver uuid;
  gid uuid;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  approver := owner_platform.current_actor();
  SELECT * INTO r FROM owner_platform.support_grant_request
    WHERE id = p_request_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'no pending grant request for this tenant' USING ERRCODE = '42501';
  END IF;
  IF r.operator_id = approver THEN
    RAISE EXCEPTION 'the requester cannot approve their own grant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO owner_platform.support_grant
    (id, tenant_id, operator_id, approved_by, case_ref, scope, reason,
     starts_at, ends_at, school_notified_at, max_actions, open_slot)
  VALUES (gen_random_uuid(), r.tenant_id, r.operator_id, approver, r.case_ref,
          r.scope, r.reason, r.starts_at, r.ends_at, r.school_notified_at,
          r.max_actions, 1)
  RETURNING id INTO gid;
  UPDATE owner_platform.support_grant_request
    SET status = 'approved', approved_by = approver WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'grant_id', gid,
    'request_id', r.id, 'approved_by', approver);
END
$fn$;

CREATE FUNCTION owner_platform.revoke_support_grant(
  p_grant_id uuid, p_tenant_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE n integer;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'revocation reason must be at least 10 characters' USING ERRCODE = '23514';
  END IF;
  UPDATE owner_platform.support_grant SET revoked_at = clock_timestamp()
    WHERE id = p_grant_id AND tenant_id = p_tenant_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'grant not found, already revoked, or wrong tenant' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('ok', true, 'grant_id', p_grant_id, 'revoked', true);
END
$fn$;

-- One record, one tenant, one logged read. The INSERT into support_access_log
-- fires PR-1's guard which enforces an active content_read grant, the tenant
-- binding, the actor binding, the window and the action cap. No bulk read and
-- no list/export path is exposed. RLS on public.product_records is left ON:
-- the function sets app.tenant_id transaction-locally before the SELECT.
CREATE FUNCTION owner_platform.read_school_record(
  p_grant_id uuid, p_tenant_id uuid, p_collection text, p_record_ref text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform, public
AS $fn$
DECLARE
  log_id uuid;
  body jsonb;
  found boolean := false;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_operator', 'platform_support']);
  IF p_collection !~ '^[a-z0-9_]{1,40}$' OR p_record_ref !~ '^[0-9]{1,18}$' THEN
    RAISE EXCEPTION 'invalid collection or record reference' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  INSERT INTO owner_platform.support_access_log (grant_id, tenant_id, record_ref)
  VALUES (p_grant_id, p_tenant_id, p_collection || '/' || p_record_ref)
  RETURNING id INTO log_id;
  SELECT r.data INTO body FROM public.product_records r
    WHERE r.tenant_id = p_tenant_id AND r.collection = p_collection
      AND r.record_id = p_record_ref::bigint AND r.deleted_at IS NULL
    LIMIT 1;
  found := body IS NOT NULL;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN jsonb_build_object('ok', true, 'found', found,
    'grant_id', p_grant_id, 'tenant_id', p_tenant_id,
    'collection', p_collection, 'record_ref', p_record_ref,
    'read_log_id', log_id, 'data', body);
END
$fn$;

-- PR-1 deliberately withheld content privileges from payesh_platform_runtime.
-- The grant here is for the SECURITY DEFINER function owner only, and only on
-- the single product table. It is conditional: a deployment that has not yet
-- run the school tenancy migration simply gets no content route.
DO $grant_content$
BEGIN
  IF to_regclass('public.product_records') IS NOT NULL THEN
    GRANT SELECT ON public.product_records TO payesh_platform_owner;
  END IF;
END
$grant_content$;

ALTER TABLE owner_platform.api_rate_limit OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.support_grant_request OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.current_actor() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.require_actor(text[]) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.create_plan(text, text, integer, integer, bigint, jsonb, bigint, text, boolean) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.apply_subscription_transition(uuid, uuid, text, text, text, integer) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.register_platform_user(text, text, text) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.request_support_grant(uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.approve_support_grant(uuid, uuid) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.revoke_support_grant(uuid, uuid, text) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.read_school_record(uuid, uuid, text, text) OWNER TO payesh_platform_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA owner_platform FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_platform.current_actor() TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.require_actor(text[]) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.create_plan(text, text, integer, integer, bigint, jsonb, bigint, text, boolean) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.apply_subscription_transition(uuid, uuid, text, text, text, integer) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.register_platform_user(text, text, text) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.request_support_grant(uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.approve_support_grant(uuid, uuid) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.revoke_support_grant(uuid, uuid, text) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.read_school_record(uuid, uuid, text, text) TO payesh_platform_runtime;

COMMIT;
