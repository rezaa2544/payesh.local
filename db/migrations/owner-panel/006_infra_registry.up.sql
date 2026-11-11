-- Owner-platform migration 006 — provider-agnostic infrastructure layer (row 122).
-- Control-plane metadata only: which providers / services / endpoints the owner registered by
-- hand, a limited health-check history, labelled capacity/usage/error measurements, alerts, and
-- owner approval for risky operations. NOTHING here provisions anything: there is no provider API
-- call and no "auto-provisioning" (forbidden claim until a real API is proven, row 124).
--
-- Credentials never live here. A provider row may carry only a REFERENCE to a secret held outside
-- the database and the repo (`secret:NAME`, resolved from the environment by the operator's host);
-- endpoint URLs must not embed user:password; free-text fields are length-capped.
-- Numbers are never invented: a measurement is either a value with a label ([M] measured,
-- [E] estimate) or NULL with label '?' — the UI shows "unknown".
BEGIN;

CREATE TABLE owner_platform.infra_provider (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  kind text NOT NULL,
  api_mode text NOT NULL DEFAULT 'manual',
  credential_ref text,
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_by uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT infra_provider_code_check CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  CONSTRAINT infra_provider_name_check CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  CONSTRAINT infra_provider_kind_check CHECK (kind IN ('host', 'vps', 'vpc', 'db', 'storage', 'other')),
  -- 'api' is declared but no adapter implements it yet (row 124); the API refuses it.
  CONSTRAINT infra_provider_api_mode_check CHECK (api_mode IN ('manual', 'api')),
  CONSTRAINT infra_provider_credential_ref_check CHECK (credential_ref IS NULL OR credential_ref ~ '^secret:[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT infra_provider_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT infra_provider_notes_check CHECK (notes IS NULL OR length(notes) <= 500)
);

CREATE TABLE owner_platform.infra_service (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES owner_platform.infra_provider(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text NOT NULL,
  kind text NOT NULL,
  region text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT infra_service_name_check CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT infra_service_kind_check CHECK (kind IN ('gateway', 'postgres', 'host', 'vps', 'vpc', 'storage', 'backup', 'other')),
  CONSTRAINT infra_service_region_check CHECK (region IS NULL OR region ~ '^[A-Za-z0-9 ._-]{1,40}$'),
  CONSTRAINT infra_service_status_check CHECK (status IN ('active', 'disabled')),
  UNIQUE (provider_id, name)
);

CREATE TABLE owner_platform.infra_endpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES owner_platform.infra_service(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  url text NOT NULL,
  check_kind text NOT NULL,
  expected_status integer,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT infra_endpoint_url_check CHECK (url ~ '^(https?|tcp)://[A-Za-z0-9.\-\[\]:]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%-]*)?$' AND length(url) <= 300),
  -- no userinfo (user:password@host) in an endpoint: credentials never in the registry
  CONSTRAINT infra_endpoint_no_userinfo_check CHECK (position('@' IN url) = 0),
  CONSTRAINT infra_endpoint_kind_check CHECK (check_kind IN ('http', 'tcp')),
  CONSTRAINT infra_endpoint_kind_scheme_check CHECK ((check_kind = 'tcp') = (url LIKE 'tcp://%')),
  CONSTRAINT infra_endpoint_expected_check CHECK (expected_status IS NULL OR expected_status BETWEEN 100 AND 599),
  UNIQUE (service_id, url)
);

-- Limited health check history: append-only, short error codes only (no bodies, no headers).
CREATE TABLE owner_platform.infra_health_check (
  id bigserial PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES owner_platform.infra_endpoint(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ok boolean NOT NULL,
  latency_ms integer,
  status_code integer,
  error_code text,
  checked_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT infra_health_latency_check CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  CONSTRAINT infra_health_status_check CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  CONSTRAINT infra_health_error_check CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{2,40}$'),
  CONSTRAINT infra_health_shape_check CHECK (ok = (error_code IS NULL))
);
CREATE INDEX infra_health_endpoint_time_idx ON owner_platform.infra_health_check (endpoint_id, checked_at DESC);

-- Capacity / usage / errors. value NULL ⇔ label '?' (unknown); otherwise [M] or [E] with a source.
CREATE TABLE owner_platform.infra_metric (
  id bigserial PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES owner_platform.infra_service(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric text NOT NULL,
  value numeric,
  unit text NOT NULL,
  label text NOT NULL,
  source text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT infra_metric_name_check CHECK (metric IN ('capacity_cpu', 'capacity_memory', 'capacity_disk', 'capacity_connections',
    'usage_cpu', 'usage_memory', 'usage_disk', 'usage_connections', 'error_rate', 'latency_p95')),
  CONSTRAINT infra_metric_unit_check CHECK (unit IN ('cores', 'percent', 'mb', 'gb', 'count', 'ms', 'ratio')),
  CONSTRAINT infra_metric_label_check CHECK (label IN ('M', 'E', '?')),
  CONSTRAINT infra_metric_unknown_check CHECK ((value IS NULL) = (label = '?')),
  CONSTRAINT infra_metric_value_check CHECK (value IS NULL OR value >= 0),
  CONSTRAINT infra_metric_source_check CHECK (source IN ('manual', 'probe', 'provider_api'))
);
CREATE INDEX infra_metric_service_time_idx ON owner_platform.infra_metric (service_id, metric, observed_at DESC);

CREATE TABLE owner_platform.infra_alert (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES owner_platform.infra_endpoint(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind text NOT NULL,
  severity text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  detail text,
  CONSTRAINT infra_alert_kind_check CHECK (kind IN ('endpoint_down')),
  CONSTRAINT infra_alert_severity_check CHECK (severity IN ('warning', 'critical')),
  CONSTRAINT infra_alert_detail_check CHECK (detail IS NULL OR detail ~ '^[a-z_0-9 =,]{1,120}$'),
  CONSTRAINT infra_alert_window_check CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
CREATE UNIQUE INDEX infra_alert_one_open_idx ON owner_platform.infra_alert (endpoint_id, kind) WHERE closed_at IS NULL;

-- Risky operations (disable/enable a provider, change its credential reference, disable an
-- endpoint) never execute on request: an owner or operator REQUESTS with a reason, and only an
-- active platform_owner APPROVES in a separate call (an operator can never approve, a forged role
-- claim buys nothing — require_actor re-reads the table). Executed exactly once.
CREATE TABLE owner_platform.infra_change_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  target_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT infra_change_action_check CHECK (action IN ('disable_provider', 'enable_provider', 'set_credential_ref', 'disable_endpoint')),
  CONSTRAINT infra_change_reason_check CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT infra_change_status_check CHECK (status IN ('pending', 'executed', 'rejected')),
  CONSTRAINT infra_change_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT infra_change_decided_check CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE TRIGGER infra_health_check_append_only
  BEFORE UPDATE OR DELETE ON owner_platform.infra_health_check
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_append_only();
CREATE TRIGGER infra_metric_append_only
  BEFORE UPDATE OR DELETE ON owner_platform.infra_metric
  FOR EACH ROW EXECUTE FUNCTION owner_platform.guard_append_only();

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['infra_provider', 'infra_service', 'infra_endpoint', 'infra_health_check', 'infra_metric',
                           'infra_alert', 'infra_change_request'] LOOP
    EXECUTE format('ALTER TABLE owner_platform.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE owner_platform.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON owner_platform.%I FOR SELECT TO payesh_platform_runtime USING (true)', t || '_runtime_read', t);
    EXECUTE format('CREATE POLICY %I ON owner_platform.%I TO payesh_platform_owner USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('ALTER TABLE owner_platform.%I OWNER TO payesh_platform_owner', t);
    EXECUTE format('REVOKE ALL ON owner_platform.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON owner_platform.%I TO payesh_platform_runtime', t);
  END LOOP;
END
$rls$;

-- ── write functions (the runtime role has SELECT only; every write goes through these) ──────
CREATE FUNCTION owner_platform.infra_register_provider(
  p_code text, p_name text, p_kind text, p_credential_ref text, p_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE r owner_platform.infra_provider%ROWTYPE;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  INSERT INTO owner_platform.infra_provider (code, display_name, kind, credential_ref, notes, created_by)
    VALUES (p_code, btrim(p_name), p_kind, nullif(p_credential_ref, ''), nullif(p_notes, ''), owner_platform.current_actor())
    RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$fn$;

CREATE FUNCTION owner_platform.infra_register_service(
  p_provider_id uuid, p_name text, p_kind text, p_region text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE r owner_platform.infra_service%ROWTYPE; st text;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  SELECT status INTO st FROM owner_platform.infra_provider WHERE id = p_provider_id;
  IF st IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'provider missing or disabled' USING ERRCODE = '23503';
  END IF;
  INSERT INTO owner_platform.infra_service (provider_id, name, kind, region)
    VALUES (p_provider_id, btrim(p_name), p_kind, nullif(p_region, ''))
    RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$fn$;

CREATE FUNCTION owner_platform.infra_register_endpoint(
  p_service_id uuid, p_url text, p_check_kind text, p_expected integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE r owner_platform.infra_endpoint%ROWTYPE;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  INSERT INTO owner_platform.infra_endpoint (service_id, url, check_kind, expected_status)
    VALUES (p_service_id, p_url, p_check_kind, p_expected)
    RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$fn$;

-- Records one check and keeps the alert state: 3 consecutive failures open one alert per
-- endpoint; the next success closes it. Returns the alert transition so the API can audit it.
CREATE FUNCTION owner_platform.infra_record_check(
  p_endpoint_id uuid, p_ok boolean, p_latency integer, p_status integer, p_error text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  fails integer;
  opened uuid;
  closed uuid;
  hid bigint;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  PERFORM 1 FROM owner_platform.infra_endpoint WHERE id = p_endpoint_id AND enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'endpoint missing or disabled' USING ERRCODE = '23503';
  END IF;
  INSERT INTO owner_platform.infra_health_check (endpoint_id, ok, latency_ms, status_code, error_code, checked_by)
    VALUES (p_endpoint_id, p_ok, p_latency, p_status, CASE WHEN p_ok THEN NULL ELSE p_error END, owner_platform.current_actor())
    RETURNING id INTO hid;
  IF p_ok THEN
    UPDATE owner_platform.infra_alert SET closed_at = clock_timestamp()
      WHERE endpoint_id = p_endpoint_id AND kind = 'endpoint_down' AND closed_at IS NULL
      RETURNING id INTO closed;
  ELSE
    SELECT count(*) INTO fails FROM (
      SELECT ok FROM owner_platform.infra_health_check WHERE endpoint_id = p_endpoint_id
      ORDER BY id DESC LIMIT 3) last3 WHERE NOT last3.ok;
    IF fails >= 3 THEN
      INSERT INTO owner_platform.infra_alert (endpoint_id, kind, severity, detail)
        VALUES (p_endpoint_id, 'endpoint_down', 'critical', 'consecutive_failures=3')
        ON CONFLICT DO NOTHING
        RETURNING id INTO opened;
    END IF;
  END IF;
  RETURN jsonb_build_object('check_id', hid, 'alert_opened', opened, 'alert_closed', closed);
END
$fn$;

CREATE FUNCTION owner_platform.infra_record_metric(
  p_service_id uuid, p_metric text, p_value numeric, p_unit text, p_label text, p_source text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE r owner_platform.infra_metric%ROWTYPE;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  IF p_source = 'provider_api' THEN
    -- no provider adapter exists yet (row 124): a provider-API number cannot be recorded
    RAISE EXCEPTION 'no provider API adapter is installed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO owner_platform.infra_metric (service_id, metric, value, unit, label, source, recorded_by)
    VALUES (p_service_id, p_metric, p_value, p_unit, p_label, p_source, owner_platform.current_actor())
    RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$fn$;

CREATE FUNCTION owner_platform.infra_request_change(
  p_action text, p_target uuid, p_payload jsonb, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE r owner_platform.infra_change_request%ROWTYPE;
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner', 'platform_operator']);
  IF p_action IN ('disable_provider', 'enable_provider', 'set_credential_ref') THEN
    PERFORM 1 FROM owner_platform.infra_provider WHERE id = p_target;
  ELSE
    PERFORM 1 FROM owner_platform.infra_endpoint WHERE id = p_target;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'change target not found' USING ERRCODE = '23503';
  END IF;
  IF p_action = 'set_credential_ref' AND NOT (coalesce(p_payload->>'credential_ref', '') ~ '^secret:[A-Z][A-Z0-9_]{2,63}$'
                                             OR coalesce(p_payload->>'credential_ref', 'x') = '') THEN
    RAISE EXCEPTION 'credential_ref must be a secret:NAME reference' USING ERRCODE = '23514';
  END IF;
  INSERT INTO owner_platform.infra_change_request (action, target_id, payload, reason, requested_by)
    VALUES (p_action, p_target, coalesce(p_payload, '{}'::jsonb), p_reason, owner_platform.current_actor())
    RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$fn$;

CREATE FUNCTION owner_platform.infra_approve_change(p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE r owner_platform.infra_change_request%ROWTYPE; actor uuid; t timestamptz := clock_timestamp();
BEGIN
  PERFORM owner_platform.require_actor(ARRAY['platform_owner']);
  actor := owner_platform.current_actor();
  SELECT * INTO r FROM owner_platform.infra_change_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'no pending change request' USING ERRCODE = '42501';
  END IF;
  IF r.action = 'disable_provider' THEN
    UPDATE owner_platform.infra_provider SET status = 'disabled', updated_at = t WHERE id = r.target_id;
  ELSIF r.action = 'enable_provider' THEN
    UPDATE owner_platform.infra_provider SET status = 'active', updated_at = t WHERE id = r.target_id;
  ELSIF r.action = 'set_credential_ref' THEN
    UPDATE owner_platform.infra_provider SET credential_ref = nullif(r.payload->>'credential_ref', ''), updated_at = t
      WHERE id = r.target_id;
  ELSE
    UPDATE owner_platform.infra_endpoint SET enabled = false WHERE id = r.target_id;
  END IF;
  UPDATE owner_platform.infra_change_request SET status = 'executed', approved_by = actor, decided_at = t
    WHERE id = r.id RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$fn$;

DO $fns$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'owner_platform.infra_register_provider(text, text, text, text, text)',
    'owner_platform.infra_register_service(uuid, text, text, text)',
    'owner_platform.infra_register_endpoint(uuid, text, text, integer)',
    'owner_platform.infra_record_check(uuid, boolean, integer, integer, text)',
    'owner_platform.infra_record_metric(uuid, text, numeric, text, text, text)',
    'owner_platform.infra_request_change(text, uuid, jsonb, text)',
    'owner_platform.infra_approve_change(uuid)'] LOOP
    EXECUTE 'ALTER FUNCTION ' || f || ' OWNER TO payesh_platform_owner';
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO payesh_platform_runtime';
  END LOOP;
END
$fns$;

COMMIT;
