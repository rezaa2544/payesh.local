-- Owner platform data model v1. Versioned, additive, and isolated from school data.
-- Apply with a PostgreSQL migration administrator. See README.md in this directory.
BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'payesh_platform_owner') THEN
    CREATE ROLE payesh_platform_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    COMMENT ON ROLE payesh_platform_owner IS 'managed by owner-platform migration 001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'payesh_platform_runtime') THEN
    CREATE ROLE payesh_platform_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    COMMENT ON ROLE payesh_platform_runtime IS 'managed by owner-platform migration 001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('payesh_platform_owner', 'payesh_platform_runtime') AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'platform roles must not be superuser or bypass RLS';
  END IF;
END
$roles$;

CREATE SCHEMA owner_platform AUTHORIZATION payesh_platform_owner;
REVOKE ALL ON SCHEMA owner_platform FROM PUBLIC;
GRANT USAGE ON SCHEMA owner_platform TO payesh_platform_runtime;

CREATE TABLE owner_platform.platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id text NOT NULL UNIQUE,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_users_login_id_check CHECK (length(btrim(login_id)) > 0),
  CONSTRAINT platform_users_role_check CHECK (role IN ('platform_owner', 'platform_operator', 'platform_support')),
  CONSTRAINT platform_users_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE owner_platform.plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  max_users integer,
  max_students integer,
  storage_mb bigint NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount bigint NOT NULL DEFAULT 0,
  price_cycle text NOT NULL DEFAULT 'none',
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT plans_code_check CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  CONSTRAINT plans_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT plans_max_users_check CHECK (max_users IS NULL OR max_users >= 0),
  CONSTRAINT plans_max_students_check CHECK (max_students IS NULL OR max_students >= 0),
  CONSTRAINT plans_storage_mb_check CHECK (storage_mb >= 0),
  CONSTRAINT plans_features_object_check CHECK (jsonb_typeof(features) = 'object'),
  CONSTRAINT plans_price_amount_check CHECK (price_amount >= 0),
  CONSTRAINT plans_price_cycle_check CHECK (price_cycle IN ('monthly', 'yearly', 'none'))
);

CREATE TABLE owner_platform.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_code text NOT NULL REFERENCES owner_platform.plans(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  grace_days integer,
  auto_renew boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  renewed_from uuid,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_status_check CHECK (status IN ('draft', 'provisioning', 'active', 'grace', 'suspended', 'expired', 'canceled')),
  CONSTRAINT subscriptions_dates_check CHECK (ends_at > starts_at),
  CONSTRAINT subscriptions_grace_days_check CHECK (grace_days IS NULL OR grace_days BETWEEN 0 AND 365),
  CONSTRAINT subscriptions_version_check CHECK (version > 0),
  UNIQUE (id, tenant_id),
  CONSTRAINT subscriptions_renewed_from_tenant_fk FOREIGN KEY (renewed_from, tenant_id)
    REFERENCES owner_platform.subscriptions(id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX subscriptions_one_current_per_tenant
  ON owner_platform.subscriptions (tenant_id)
  WHERE status IN ('draft', 'provisioning', 'active', 'grace', 'suspended');
CREATE INDEX subscriptions_status_ends_idx ON owner_platform.subscriptions (status, ends_at);
CREATE INDEX subscriptions_tenant_starts_idx ON owner_platform.subscriptions (tenant_id, starts_at DESC);

CREATE TABLE owner_platform.subscription_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  actor_ref text NOT NULL,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_event_from_status_check CHECK (from_status IS NULL OR from_status IN ('draft', 'provisioning', 'active', 'grace', 'suspended', 'expired', 'canceled')),
  CONSTRAINT subscription_event_to_status_check CHECK (to_status IN ('draft', 'provisioning', 'active', 'grace', 'suspended', 'expired', 'canceled')),
  CONSTRAINT subscription_event_reason_check CHECK (reason IN ('payment', 'expiry', 'owner_action', 'cancel', 'renew', 'system')),
  CONSTRAINT subscription_event_idempotency_key_check CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT subscription_event_subscription_tenant_fk FOREIGN KEY (subscription_id, tenant_id)
    REFERENCES owner_platform.subscriptions(id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id)
);
CREATE INDEX subscription_event_tenant_time_idx ON owner_platform.subscription_event (tenant_id, occurred_at DESC);

CREATE TABLE owner_platform.tenant_limits (
  tenant_id uuid PRIMARY KEY,
  max_users integer,
  max_students integer,
  storage_bytes bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_limits_max_users_check CHECK (max_users IS NULL OR max_users >= 0),
  CONSTRAINT tenant_limits_max_students_check CHECK (max_students IS NULL OR max_students >= 0),
  CONSTRAINT tenant_limits_storage_bytes_check CHECK (storage_bytes >= 0)
);

CREATE TABLE owner_platform.tenant_usage (
  tenant_id uuid PRIMARY KEY,
  users_count integer NOT NULL DEFAULT 0,
  students_count integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  last_recalc_at timestamptz,
  CONSTRAINT tenant_usage_users_count_check CHECK (users_count >= 0),
  CONSTRAINT tenant_usage_students_count_check CHECK (students_count >= 0),
  CONSTRAINT tenant_usage_storage_bytes_check CHECK (storage_bytes >= 0)
);

CREATE TABLE owner_platform.support_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  approved_by uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  case_ref text,
  scope text NOT NULL,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  school_notified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  used_reads integer NOT NULL DEFAULT 0,
  max_actions integer NOT NULL DEFAULT 1,
  open_slot smallint DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_grant_scope_check CHECK (scope IN ('metadata', 'content_read')),
  CONSTRAINT support_grant_reason_check CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT support_grant_window_check CHECK (ends_at > starts_at),
  CONSTRAINT support_grant_max_72h_check CHECK (ends_at <= starts_at + interval '72 hours'),
  CONSTRAINT support_grant_approver_check CHECK (approved_by <> operator_id),
  CONSTRAINT support_grant_school_notified_check CHECK (school_notified_at < starts_at),
  CONSTRAINT support_grant_used_reads_check CHECK (used_reads >= 0),
  CONSTRAINT support_grant_max_actions_check CHECK (max_actions > 0),
  CONSTRAINT support_grant_reads_within_cap_check CHECK (used_reads <= max_actions),
  CONSTRAINT support_grant_open_slot_check CHECK (open_slot IS NULL OR open_slot = 1),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX support_grant_one_open_per_operator
  ON owner_platform.support_grant (operator_id, open_slot)
  WHERE open_slot = 1;
CREATE INDEX support_grant_tenant_window_idx ON owner_platform.support_grant (tenant_id, starts_at, ends_at);

CREATE TABLE owner_platform.support_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  record_ref text NOT NULL,
  CONSTRAINT support_access_log_record_ref_check CHECK (length(btrim(record_ref)) > 0),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT support_access_log_grant_tenant_fk
    FOREIGN KEY (grant_id, tenant_id) REFERENCES owner_platform.support_grant(id, tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (id, tenant_id)
);
CREATE INDEX support_access_log_tenant_time_idx ON owner_platform.support_access_log (tenant_id, read_at DESC);

CREATE TABLE owner_platform.platform_audit (
  sequence_id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_ref text NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_ref text,
  tenant_id uuid,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash bytea NOT NULL,
  event_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_audit_action_check CHECK (length(btrim(action)) > 0),
  CONSTRAINT platform_audit_subject_type_check CHECK (length(btrim(subject_type)) > 0),
  CONSTRAINT platform_audit_previous_hash_len_check CHECK (octet_length(previous_hash) = 32),
  CONSTRAINT platform_audit_event_hash_len_check CHECK (octet_length(event_hash) = 32),
  CONSTRAINT platform_audit_details_object_check CHECK (jsonb_typeof(details) = 'object')
);

-- Invoice is intentionally a data structure only: no runtime privileges, payment code, or UI.
CREATE TABLE owner_platform.invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subscription_id uuid,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount bigint NOT NULL,
  currency text NOT NULL DEFAULT 'IRR',
  status text NOT NULL DEFAULT 'draft',
  payment_ref text,
  issued_at timestamptz,
  paid_at timestamptz,
  CONSTRAINT invoice_period_check CHECK (period_end > period_start),
  CONSTRAINT invoice_amount_check CHECK (amount >= 0),
  CONSTRAINT invoice_currency_check CHECK (currency = 'IRR'),
  CONSTRAINT invoice_status_check CHECK (status IN ('draft', 'issued', 'paid', 'void', 'refunded')),
  CONSTRAINT invoice_subscription_tenant_fk FOREIGN KEY (subscription_id, tenant_id)
    REFERENCES owner_platform.subscriptions(id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, period_start, period_end)
);
CREATE INDEX invoice_status_idx ON owner_platform.invoice (status);

-- Tenant-bound metadata is isolated by tenant context. The dedicated platform
-- service role may query only this schema's metadata, never product content.
DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'subscription_event', 'tenant_limits', 'tenant_usage', 'support_grant', 'support_access_log', 'invoice'] LOOP
    EXECUTE format('ALTER TABLE owner_platform.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE owner_platform.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON owner_platform.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_tenant_isolation', t);
    EXECUTE format('CREATE POLICY %I ON owner_platform.%I TO payesh_platform_runtime USING (true) WITH CHECK (true)', t || '_platform_metadata_access', t);
    EXECUTE format('CREATE POLICY %I ON owner_platform.%I TO payesh_platform_owner USING (true) WITH CHECK (true)', t || '_migration_metadata_access', t);
  END LOOP;
END
$policies$;

ALTER TABLE owner_platform.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.platform_users FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_users_runtime ON owner_platform.platform_users
  TO payesh_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY platform_users_owner ON owner_platform.platform_users
  TO payesh_platform_owner USING (true) WITH CHECK (true);
ALTER TABLE owner_platform.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_runtime ON owner_platform.plans
  TO payesh_platform_runtime USING (true) WITH CHECK (true);
ALTER TABLE owner_platform.platform_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.platform_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_runtime ON owner_platform.platform_audit
  TO payesh_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY platform_audit_owner ON owner_platform.platform_audit
  TO payesh_platform_owner USING (true) WITH CHECK (true);

CREATE FUNCTION owner_platform.guard_support_grant_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, owner_platform
AS $fn$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    NEW.open_slot := NULL;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.operator_id, NEW.approved_by, NEW.case_ref, NEW.scope,
      NEW.reason, NEW.starts_at, NEW.ends_at, NEW.school_notified_at, NEW.max_actions,
      NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.operator_id, OLD.approved_by, OLD.case_ref, OLD.scope,
      OLD.reason, OLD.starts_at, OLD.ends_at, OLD.school_notified_at, OLD.max_actions,
      OLD.created_at) THEN
    RAISE EXCEPTION 'support grants cannot be renewed or re-scoped' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'support grant revocation is irreversible' USING ERRCODE = '42501';
  END IF;
  IF NEW.used_reads < OLD.used_reads OR NEW.used_reads > NEW.max_actions THEN
    RAISE EXCEPTION 'support grant read counter must be monotonic and within cap' USING ERRCODE = '42501';
  END IF;
  IF NEW.open_slot IS DISTINCT FROM OLD.open_slot
     AND NOT (NEW.open_slot IS NULL AND (NEW.revoked_at IS NOT NULL OR OLD.ends_at <= clock_timestamp())) THEN
    RAISE EXCEPTION 'support grant slot may close only on revoke or expiry' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER support_grant_update_guard
  BEFORE UPDATE ON owner_platform.support_grant
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_support_grant_update();

CREATE FUNCTION owner_platform.guard_support_access_log() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  g owner_platform.support_grant%ROWTYPE;
  platform_user_context uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'support access log is append-only' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(NEW.record_ref)) = 0 THEN
    RETURN NEW; -- let the named CHECK reject malformed references
  END IF;
  platform_user_context := nullif(current_setting('app.platform_user_id', true), '')::uuid;
  SELECT * INTO g FROM owner_platform.support_grant
    WHERE id = NEW.grant_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR g.scope <> 'content_read' OR g.revoked_at IS NOT NULL
     OR g.starts_at > clock_timestamp() OR g.ends_at <= clock_timestamp()
     OR g.school_notified_at >= g.starts_at
     OR platform_user_context IS NULL OR platform_user_context <> g.operator_id THEN
    RAISE EXCEPTION 'active content_read grant required for this tenant' USING ERRCODE = '42501';
  END IF;
  IF g.used_reads >= g.max_actions THEN
    RAISE EXCEPTION 'support grant action cap reached' USING ERRCODE = '42501';
  END IF;
  UPDATE owner_platform.support_grant SET used_reads = used_reads + 1
    WHERE id = g.id AND tenant_id = g.tenant_id;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER support_access_log_insert_guard
  BEFORE INSERT OR UPDATE OR DELETE ON owner_platform.support_access_log
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_support_access_log();

CREATE FUNCTION owner_platform.guard_audit_chain() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE expected_previous bytea;
BEGIN
  IF octet_length(NEW.previous_hash) <> 32 THEN
    RETURN NEW; -- let the named CHECK reject malformed hash length
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('owner_platform.platform_audit_chain'));
  SELECT event_hash INTO expected_previous
    FROM owner_platform.platform_audit ORDER BY sequence_id DESC LIMIT 1;
  IF expected_previous IS NULL THEN
    expected_previous := decode(repeat('00', 32), 'hex');
  END IF;
  IF NEW.previous_hash IS DISTINCT FROM expected_previous THEN
    RAISE EXCEPTION 'platform audit previous_hash does not match chain head' USING ERRCODE = '23514', CONSTRAINT = 'platform_audit_chain_check';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER platform_audit_chain_guard
  BEFORE INSERT ON owner_platform.platform_audit
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_audit_chain();

CREATE FUNCTION owner_platform.guard_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, owner_platform
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501', TABLE = TG_TABLE_NAME;
END
$fn$;
CREATE TRIGGER platform_audit_append_only
  BEFORE UPDATE OR DELETE ON owner_platform.platform_audit
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_append_only();

-- The approving principal must be an active platform owner. The requester cannot approve themself.
CREATE FUNCTION owner_platform.guard_support_grant_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE approver_role text; approver_status text;
BEGIN
  SELECT role, status INTO approver_role, approver_status
    FROM owner_platform.platform_users WHERE id = NEW.approved_by;
  IF approver_role IS DISTINCT FROM 'platform_owner' OR approver_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'active platform owner approval required' USING ERRCODE = '42501';
  END IF;
  IF NEW.open_slot IS NULL THEN
    RAISE EXCEPTION 'new support grants must occupy an open slot' USING ERRCODE = '23514', CONSTRAINT = 'support_grant_open_slot_check';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER support_grant_insert_guard
  BEFORE INSERT ON owner_platform.support_grant
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_support_grant_insert();

-- RLS on global metadata tables is not a substitute for SQL privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA owner_platform FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA owner_platform FROM PUBLIC;
GRANT SELECT ON owner_platform.platform_users TO payesh_platform_runtime;
GRANT SELECT ON owner_platform.plans TO payesh_platform_runtime;
-- Direct subscription mutation stays disabled in v1. PR-2 may add owner-only functions;
-- operators must not create, renew, change status, or delete subscriptions through table grants.
GRANT SELECT ON owner_platform.subscriptions TO payesh_platform_runtime;
GRANT SELECT ON owner_platform.subscription_event TO payesh_platform_runtime;
GRANT SELECT ON owner_platform.tenant_limits TO payesh_platform_runtime;
GRANT SELECT ON owner_platform.tenant_usage TO payesh_platform_runtime;
GRANT SELECT, INSERT, UPDATE ON owner_platform.support_grant TO payesh_platform_runtime;
GRANT SELECT, INSERT ON owner_platform.support_access_log TO payesh_platform_runtime;
GRANT SELECT, INSERT ON owner_platform.platform_audit TO payesh_platform_runtime;
GRANT USAGE, SELECT ON SEQUENCE owner_platform.platform_audit_sequence_id_seq TO payesh_platform_runtime;
-- Deliberately no invoice grant and no grants on public/product content tables.

ALTER TABLE owner_platform.platform_users OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.plans OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.subscriptions OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.subscription_event OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.tenant_limits OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.tenant_usage OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.support_grant OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.support_access_log OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.platform_audit OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.invoice OWNER TO payesh_platform_owner;
ALTER SEQUENCE owner_platform.platform_audit_sequence_id_seq OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.guard_support_grant_update() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.guard_support_access_log() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.guard_audit_chain() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.guard_append_only() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.guard_support_grant_insert() OWNER TO payesh_platform_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA owner_platform FROM PUBLIC;

COMMIT;
