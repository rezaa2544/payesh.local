-- phase: expand
-- ═══════════════════════════════════════════════════════════════════════════
-- Row 109 (ADR-105, Proposed): findings of the RLS pentest, fixed.
--
-- sync_push is SECURITY INVOKER (row 108 AC), so the client role holds INSERT /
-- UPDATE on record, sync_op, sync_batch and sync_conflict. The pentest showed
-- that a client could use those privileges directly, around sync_push:
--   F1  write records without paying the per-window rate limit (take_push_quota
--       is only called by sync_push);
--   F2  insert rows that are tombstones from birth — not counted by the records
--       cap, so unbounded table growth;
--   F3  insert a conflict with an unbounded local_sealed (op_too_large and the
--       bytes cap only ran inside sync_push);
--   F4  store an unbounded sync_batch.response;
--   F5  write a record larger than the plan's per-op limit (op_too_large only
--       ran inside sync_push).
-- Fix: a WRITE TICKET bound to the transaction. take_push_quota (which charges
-- the window) records how many ops this transaction may write; the triggers on
-- record / sync_op / sync_conflict / sync_batch spend from it and refuse a
-- write without a ticket or over it. Direct table writes are now exactly as
-- limited as sync_push (they must pay the same quota first); RLS still decides
-- WHAT may be written. Plus: records are born live, conflict and batch sizes
-- are capped, a conflict's device_id comes from the token.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payesh_direct.write_ticket (
  txid bigint PRIMARY KEY,
  tenant_id uuid NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  granted integer NOT NULL DEFAULT 0,
  used_ops integer NOT NULL DEFAULT 0,
  used_records integer NOT NULL DEFAULT 0,
  used_conflicts integer NOT NULL DEFAULT 0,
  used_batches integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payesh_direct.write_ticket OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.write_ticket ENABLE ROW LEVEL SECURITY;   -- no policy: clients see nothing
REVOKE ALL ON payesh_direct.write_ticket FROM PUBLIC;

-- spend from this transaction's ticket (internal: triggers only)
CREATE OR REPLACE FUNCTION payesh_direct.spend_write_ticket(p_tenant uuid, p_kind text, p_n integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w payesh_direct.write_ticket;
BEGIN
  UPDATE payesh_direct.write_ticket
     SET used_ops = used_ops + CASE WHEN p_kind = 'op' THEN p_n ELSE 0 END,
         used_records = used_records + CASE WHEN p_kind = 'record' THEN p_n ELSE 0 END,
         used_conflicts = used_conflicts + CASE WHEN p_kind = 'conflict' THEN p_n ELSE 0 END,
         used_batches = used_batches + CASE WHEN p_kind = 'batch' THEN p_n ELSE 0 END
   WHERE txid = txid_current() AND tenant_id = p_tenant
  RETURNING * INTO w;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'write_quota_not_taken' USING ERRCODE = '42501',
      DETAIL = p_kind || ': call take_push_quota (or sync_push) first';
  END IF;
  IF w.used_ops > w.granted OR w.used_records > w.granted OR w.used_conflicts > w.granted
     OR w.used_batches > w.calls THEN
    RAISE EXCEPTION 'write_quota_exceeded' USING ERRCODE = '54000', DETAIL = p_kind;
  END IF;
END $$;

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
  -- row 109: the quota just paid becomes this transaction's write ticket
  DELETE FROM payesh_direct.write_ticket WHERE txid IN (
    SELECT w.txid FROM payesh_direct.write_ticket w
     WHERE w.at < now() - interval '15 minutes' LIMIT 200 FOR UPDATE SKIP LOCKED);
  INSERT INTO payesh_direct.write_ticket (txid, tenant_id, calls, granted)
  VALUES (txid_current(), t, 1, p_ops)
  ON CONFLICT (txid) DO UPDATE SET calls = payesh_direct.write_ticket.calls + 1,
                                   granted = payesh_direct.write_ticket.granted + EXCLUDED.granted;
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u payesh_direct.tenant_usage; p payesh_direct.tenant_plan; d_rec integer; d_bytes bigint;
BEGIN
  -- row 109: no row is born as a tombstone (a free row outside the records cap)
  IF TG_OP = 'INSERT' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'record_must_be_live' USING ERRCODE = '42501';
  END IF;
  -- row 109: every record write is paid by take_push_quota in this transaction
  PERFORM payesh_direct.spend_write_ticket(NEW.tenant_id, 'record', 1);
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
  -- row 109: the per-op size limit also holds for a direct table write
  IF coalesce(octet_length(NEW.sealed), 0) > p.max_op_bytes THEN
    RAISE EXCEPTION 'op_too_large' USING ERRCODE = '54000', DETAIL = 'record, limit ' || p.max_op_bytes;
  END IF;
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

-- sync_op / sync_conflict / sync_batch: paid, bounded, identity from the token
CREATE OR REPLACE FUNCTION payesh_direct.sync_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p payesh_direct.tenant_plan;
BEGIN
  IF TG_TABLE_NAME = 'sync_op' THEN
    PERFORM payesh_direct.spend_write_ticket(NEW.tenant_id, 'op', 1);
    NEW.device_id := payesh_direct.request_device_id();
  ELSIF TG_TABLE_NAME = 'sync_conflict' THEN
    p := payesh_direct.plan_for(NEW.tenant_id);
    IF coalesce(octet_length(NEW.local_sealed), 0) > p.max_op_bytes THEN
      RAISE EXCEPTION 'op_too_large' USING ERRCODE = '54000', DETAIL = 'conflict, limit ' || p.max_op_bytes;
    END IF;
    PERFORM payesh_direct.spend_write_ticket(NEW.tenant_id, 'conflict', 1);
    NEW.device_id := payesh_direct.request_device_id();
  ELSE
    p := payesh_direct.plan_for(NEW.tenant_id);
    IF octet_length(NEW.response::text) > p.max_ops_per_push::bigint * (p.max_op_bytes + 1024) + 65536 THEN
      RAISE EXCEPTION 'batch_too_large' USING ERRCODE = '54000';
    END IF;
    -- an insert opens one batch per take_push_quota call; the upsert's update half needs only the ticket
    PERFORM payesh_direct.spend_write_ticket(NEW.tenant_id, 'batch', CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sync_write_guard ON payesh_direct.sync_op;
CREATE TRIGGER sync_write_guard BEFORE INSERT ON payesh_direct.sync_op
  FOR EACH ROW EXECUTE FUNCTION payesh_direct.sync_write_guard();
DROP TRIGGER IF EXISTS sync_write_guard ON payesh_direct.sync_conflict;
CREATE TRIGGER sync_write_guard BEFORE INSERT ON payesh_direct.sync_conflict
  FOR EACH ROW EXECUTE FUNCTION payesh_direct.sync_write_guard();
DROP TRIGGER IF EXISTS sync_write_guard ON payesh_direct.sync_batch;
CREATE TRIGGER sync_write_guard BEFORE INSERT OR UPDATE ON payesh_direct.sync_batch
  FOR EACH ROW EXECUTE FUNCTION payesh_direct.sync_write_guard();

ALTER FUNCTION payesh_direct.spend_write_ticket(uuid, text, integer) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.sync_write_guard() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.take_push_quota(integer) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.record_guard() OWNER TO payesh_direct_owner;
REVOKE ALL ON FUNCTION payesh_direct.spend_write_ticket(uuid, text, integer), payesh_direct.sync_write_guard() FROM PUBLIC;
-- both stay internal: no EXECUTE for payesh_direct_client
