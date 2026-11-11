-- Row 109 down: back to the 0003 behaviour (no write tickets).
DROP TRIGGER IF EXISTS sync_write_guard ON payesh_direct.sync_op;
DROP TRIGGER IF EXISTS sync_write_guard ON payesh_direct.sync_conflict;
DROP TRIGGER IF EXISTS sync_write_guard ON payesh_direct.sync_batch;
DROP FUNCTION IF EXISTS payesh_direct.sync_write_guard();

CREATE OR REPLACE FUNCTION payesh_direct.take_push_quota(p_ops integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; p payesh_direct.tenant_plan; u payesh_direct.tenant_usage;
BEGIN
  t := payesh_direct.current_tenant_id();
  IF t IS NULL OR payesh_direct.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  p := payesh_direct.plan_for(t);
  IF p_ops IS NULL OR p_ops < 0 THEN RAISE EXCEPTION 'bad_ops' USING ERRCODE = '22023'; END IF;
  IF p_ops > p.max_ops_per_push THEN
    RAISE EXCEPTION 'too_many_ops' USING ERRCODE = '54000', DETAIL = 'limit ' || p.max_ops_per_push;
  END IF;
  INSERT INTO payesh_direct.tenant_usage (tenant_id) VALUES (t) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO u FROM payesh_direct.tenant_usage WHERE tenant_id = t FOR UPDATE;
  IF u.window_start IS NULL OR u.window_start <= now() - make_interval(secs => p.window_sec) THEN
    u.window_start := now(); u.window_ops := 0;
  END IF;
  IF u.window_ops + p_ops > p.max_ops_per_window THEN
    RAISE EXCEPTION 'plan_rate_exceeded' USING ERRCODE = '54000',
      DETAIL = 'limit ' || p.max_ops_per_window || ' ops per ' || p.window_sec || ' s';
  END IF;
  UPDATE payesh_direct.tenant_usage SET window_start = u.window_start, window_ops = u.window_ops + p_ops
   WHERE tenant_id = t;
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u payesh_direct.tenant_usage; p payesh_direct.tenant_plan; d_rec integer; d_bytes bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.collection IS DISTINCT FROM OLD.collection
       OR NEW.record_id IS DISTINCT FROM OLD.record_id THEN
      RAISE EXCEPTION 'record_identity_immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
      RAISE EXCEPTION 'version_not_next' USING ERRCODE = '40001';
    END IF;
    d_rec := (CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE 0 END) - (CASE WHEN OLD.deleted_at IS NULL THEN 1 ELSE 0 END);
    d_bytes := coalesce(octet_length(NEW.sealed), 0) - coalesce(octet_length(OLD.sealed), 0);
  ELSE
    IF NEW.version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'version_not_next' USING ERRCODE = '40001';
    END IF;
    d_rec := CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE 0 END;
    d_bytes := coalesce(octet_length(NEW.sealed), 0);
  END IF;
  INSERT INTO payesh_direct.tenant_usage (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO u FROM payesh_direct.tenant_usage WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  p := payesh_direct.plan_for(NEW.tenant_id);
  IF d_rec > 0 AND u.records + d_rec > p.max_records THEN
    RAISE EXCEPTION 'plan_records_exceeded' USING ERRCODE = '54000', DETAIL = 'limit ' || p.max_records;
  END IF;
  IF d_bytes > 0 AND u.bytes + d_bytes > p.max_bytes THEN
    RAISE EXCEPTION 'plan_bytes_exceeded' USING ERRCODE = '54000', DETAIL = 'limit ' || p.max_bytes;
  END IF;
  UPDATE payesh_direct.tenant_usage SET records = records + d_rec, bytes = bytes + d_bytes
   WHERE tenant_id = NEW.tenant_id;
  NEW.seq := nextval('payesh_direct.record_seq');
  NEW.updated_at := now();
  RETURN NEW;
END $$;

ALTER FUNCTION payesh_direct.take_push_quota(integer) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.record_guard() OWNER TO payesh_direct_owner;
DROP FUNCTION IF EXISTS payesh_direct.spend_write_ticket(uuid, text, integer);
DROP TABLE IF EXISTS payesh_direct.write_ticket;
