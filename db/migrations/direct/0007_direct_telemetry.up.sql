-- phase: expand
-- ═══════════════════════════════════════════════════════════════════════════
-- Row 80: opt-in error reports / telemetry WITHOUT PII on the direct path
-- (row 110 transport — no self-hosted Gateway). Contract:
-- docs/cloud/contracts/telemetry-v1.schema.json · doc: docs/security/80-telemetry.md
--
--   • FIELD ALLOWLIST, enforced three times: the typed table below has no free
--     column (no jsonb blob, no message text); telemetry_ingest refuses an event
--     that carries ANY key outside the allowlist (field_not_allowed, whole batch);
--     every string must match a closed pattern. national_id / name / phone /
--     user or student ids are not in the allowlist — they cannot be stored.
--   • VALUE GUARD: no string may carry a run of 7+ digits, an '@' or whitespace
--     (a national id, phone number or e-mail smuggled into `code`/`where`).
--   • CONSENT: p_consent must be true (the client sends only after opt-in;
--     the server refuses a batch without it — defence in depth).
--   • RATE LIMIT: per device 60 events / hour, per school 2000 events / hour,
--     at most 20 events per call; over ⇒ telemetry_rate_limited (54000).
--   • tenant and device come from the verified token (current_tenant_id /
--     request_device_id); the event has no tenant/device/user field at all.
--   • clients cannot read or write the tables directly (RLS on, no policy,
--     no grant); only telemetry_ingest (SECURITY DEFINER) writes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payesh_direct.telemetry_event (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  v smallint NOT NULL DEFAULT 1,
  type text NOT NULL DEFAULT 'error',
  code text NOT NULL DEFAULT 'unknown',
  where_ref text,
  platform text NOT NULL DEFAULT 'web',
  app_version text,
  count integer,
  duration_ms integer
);
CREATE INDEX IF NOT EXISTS telemetry_event_tenant_idx ON payesh_direct.telemetry_event (tenant_id, received_at);

CREATE TABLE IF NOT EXISTS payesh_direct.telemetry_usage (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,          -- the all-zero uuid = the school-wide bucket
  window_start timestamptz NOT NULL DEFAULT now(),
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, device_id)
);

ALTER TABLE payesh_direct.telemetry_event OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.telemetry_usage OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.telemetry_event ENABLE ROW LEVEL SECURITY;   -- no policy: clients see nothing
ALTER TABLE payesh_direct.telemetry_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payesh_direct.telemetry_event, payesh_direct.telemetry_usage FROM PUBLIC;
REVOKE ALL ON SEQUENCE payesh_direct.telemetry_event_id_seq FROM PUBLIC;

CREATE OR REPLACE FUNCTION payesh_direct.telemetry_ingest(p_events jsonb, p_consent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- the field allowlist (keep equal to telemetry-v1.schema.json and client/telemetry.js)
  allowed constant text[] := ARRAY['v', 'type', 'code', 'where', 'platform', 'app_version', 'count', 'duration_ms'];
  max_batch constant integer := 20;
  per_device constant integer := 60;
  per_school constant integer := 2000;
  window_sec constant integer := 3600;
  school_bucket constant uuid := '00000000-0000-0000-0000-000000000000';
  t uuid; d uuid; e jsonb; k text; sv text; cnt integer; lim integer; u payesh_direct.telemetry_usage;
BEGIN
  t := payesh_direct.current_tenant_id();
  d := payesh_direct.request_device_id();
  IF t IS NULL OR d IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF p_consent IS DISTINCT FROM true THEN RAISE EXCEPTION 'consent_required' USING ERRCODE = '42501'; END IF;
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN RAISE EXCEPTION 'bad_events' USING ERRCODE = '22023'; END IF;
  cnt := jsonb_array_length(p_events);
  IF cnt = 0 THEN RETURN jsonb_build_object('accepted', 0); END IF;
  IF cnt > max_batch THEN RAISE EXCEPTION 'too_many_events' USING ERRCODE = '54000', DETAIL = 'limit ' || max_batch; END IF;

  -- 1) validate the WHOLE batch first (all or nothing)
  FOR e IN SELECT x FROM jsonb_array_elements(p_events) AS a(x) LOOP
    IF jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'bad_event' USING ERRCODE = '22023'; END IF;
    FOR k IN SELECT jsonb_object_keys(e) LOOP
      IF NOT (k = ANY (allowed)) THEN
        RAISE EXCEPTION 'field_not_allowed' USING ERRCODE = '22023', DETAIL = left(k, 40);
      END IF;
      -- v / count / duration_ms are JSON numbers; every other field is a JSON string
      IF k IN ('v', 'count', 'duration_ms') THEN
        IF jsonb_typeof(e -> k) <> 'number' THEN RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = k; END IF;
      ELSE
        IF jsonb_typeof(e -> k) <> 'string' THEN RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = k; END IF;
        sv := e ->> k;
        IF sv ~ '[0-9]{7,}' OR position('@' IN sv) > 0 OR sv ~ '\s' OR length(sv) > 64 THEN
          RAISE EXCEPTION 'pii_suspected' USING ERRCODE = '22023', DETAIL = k;
        END IF;
      END IF;
    END LOOP;
    IF coalesce(e ->> 'v', '1') <> '1' THEN RAISE EXCEPTION 'bad_version' USING ERRCODE = '22023'; END IF;
    IF NOT coalesce(e ->> 'type', '') = ANY (ARRAY['error', 'crash', 'sync_failure', 'perf']) THEN
      RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'type';
    END IF;
    IF coalesce(e ->> 'code', '') !~ '^[a-z][a-z0-9_.]{0,63}$' THEN RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'code'; END IF;
    IF e ? 'where' AND (e ->> 'where') !~ '^[a-z][a-z0-9_./-]{0,63}$' THEN RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'where'; END IF;
    IF NOT coalesce(e ->> 'platform', '') = ANY (ARRAY['android', 'windows', 'web']) THEN
      RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'platform';
    END IF;
    IF e ? 'app_version' AND (e ->> 'app_version') !~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}([+-][0-9A-Za-z.]{1,20})?$' THEN
      RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'app_version';
    END IF;
    IF e ? 'count' AND NOT ((e ->> 'count') ~ '^[0-9]{1,6}$') THEN RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'count'; END IF;
    IF e ? 'duration_ms' AND NOT ((e ->> 'duration_ms') ~ '^[0-9]{1,8}$') THEN RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023', DETAIL = 'duration_ms'; END IF;
  END LOOP;

  -- 2) rate limit: the device bucket, then the school bucket (same table, row locks)
  FOR k IN SELECT unnest(ARRAY['device', 'school']) LOOP
    INSERT INTO payesh_direct.telemetry_usage (tenant_id, device_id)
      VALUES (t, CASE WHEN k = 'device' THEN d ELSE school_bucket END) ON CONFLICT DO NOTHING;
    SELECT * INTO u FROM payesh_direct.telemetry_usage
     WHERE tenant_id = t AND device_id = CASE WHEN k = 'device' THEN d ELSE school_bucket END FOR UPDATE;
    IF u.window_start <= now() - make_interval(secs => window_sec) THEN u.window_start := now(); u.n := 0; END IF;
    IF k = 'device' THEN lim := per_device; ELSE lim := per_school; END IF;
    IF u.n + cnt > lim THEN
      RAISE EXCEPTION 'telemetry_rate_limited' USING ERRCODE = '54000',
        DETAIL = k || ' limit ' || lim || ' per ' || window_sec || ' s';
    END IF;
    UPDATE payesh_direct.telemetry_usage SET window_start = u.window_start, n = u.n + cnt
     WHERE tenant_id = t AND device_id = u.device_id;
  END LOOP;

  -- 3) store typed columns only
  INSERT INTO payesh_direct.telemetry_event (tenant_id, device_id, v, type, code, where_ref, platform, app_version, count, duration_ms)
  SELECT t, d, 1, x ->> 'type', x ->> 'code', x ->> 'where', x ->> 'platform', x ->> 'app_version',
         (x ->> 'count')::integer, (x ->> 'duration_ms')::integer
    FROM jsonb_array_elements(p_events) AS a(x);
  RETURN jsonb_build_object('accepted', cnt);
END $$;
ALTER FUNCTION payesh_direct.telemetry_ingest(jsonb, boolean) OWNER TO payesh_direct_owner;
REVOKE ALL ON FUNCTION payesh_direct.telemetry_ingest(jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payesh_direct.telemetry_ingest(jsonb, boolean) TO payesh_direct_client;
