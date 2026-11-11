-- phase: expand
-- Row 108 (ADR-105 §3.3, Proposed): the sync logic of the Gateway, ported to SQL.
--
--   sync_push(ops, idempotency_key)   batch write   (SECURITY INVOKER ⇒ RLS of 0001)
--   sync_pull(since_seq, limit, cols) change-feed   (SECURITY INVOKER ⇒ RLS of 0001)
--   sync_resolve_conflict(id, dec)    human verdict (SECURITY INVOKER, manager by RLS)
--
-- Reference: server/tenancy.js applyOps/listFeed (Gateway) and server/sync.js
-- (convergence, D-28 / row 41). What moves where:
--   • change-feed     record.seq from one sequence, assigned by a trigger while the
--                     tenant's usage row is locked ⇒ per tenant, seq order = commit
--                     order, so a cursor never skips a row that commits later.
--   • idempotency     sync_op (tenant, uid): a uid is applied at most once; a
--                     conflict verdict is final (retry = duplicate), like the Gateway.
--                     Request level: sync_batch replays the stored response.
--   • OCC             every put/del names base_version; the write happens only on
--                     top of exactly that version (version = base + 1, enforced by
--                     the trigger too). Blind overwrites do not exist on this path.
--   • conflicts       rows are end-to-end encrypted (row 107), so the database can
--                     not read fields and can not run the field-level domain rules.
--                     A stale op comes back as `stale` with the current ciphertext;
--                     the DEVICE decrypts and runs the same rules (server/convergence.js
--                     ⇔ conflict-v1 vectors ⇔ Dart conformance) and re-sends the SAME
--                     uid as a merged put (base = current), as `noop`, or as
--                     `conflict` (both versions kept in sync_conflict for a manager).
--                     The database guarantees the part that needs a single authority:
--                     server-receipt order and "only on top of what you have seen".
--   • plan quota      tenant_plan (written by provisioning only) + tenant_usage,
--                     enforced by the record trigger (records, bytes) and at the
--                     start of every push (ops per push, ops per window, op size).
-- Standard PostgreSQL only (13+). No extension, no provider objects.

CREATE SEQUENCE IF NOT EXISTS payesh_direct.record_seq;
ALTER SEQUENCE payesh_direct.record_seq OWNER TO payesh_direct_owner;

ALTER TABLE payesh_direct.record ADD COLUMN IF NOT EXISTS seq bigint;
-- existing rows (normally none on the direct path) enter the feed once
UPDATE payesh_direct.record SET seq = nextval('payesh_direct.record_seq') WHERE seq IS NULL;
-- the feed index (tenant_id, seq) is 0004, built CONCURRENTLY outside a transaction

-- ── plan and usage ─────────────────────────────────────────────────────────
-- A school without a row gets the built-in default plan (plan_for). Rows are
-- written by provisioning (table owner) only — never by a client or a manager.
CREATE TABLE IF NOT EXISTS payesh_direct.tenant_plan (
  tenant_id uuid PRIMARY KEY,
  max_records integer NOT NULL DEFAULT 200000 CHECK (max_records > 0),
  max_bytes bigint NOT NULL DEFAULT 536870912 CHECK (max_bytes > 0),
  max_ops_per_push integer NOT NULL DEFAULT 200 CHECK (max_ops_per_push BETWEEN 1 AND 1000),
  max_ops_per_window integer NOT NULL DEFAULT 1200 CHECK (max_ops_per_window > 0),
  window_sec integer NOT NULL DEFAULT 60 CHECK (window_sec BETWEEN 1 AND 86400),
  max_op_bytes integer NOT NULL DEFAULT 131072 CHECK (max_op_bytes BETWEEN 1024 AND 1048576),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payesh_direct.tenant_usage (
  tenant_id uuid PRIMARY KEY,
  records bigint NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  window_start timestamptz,
  window_ops integer NOT NULL DEFAULT 0
);
-- usage of schools that already have rows (the migrator runs as an admin that
-- is not subject to RLS); every later write is counted by the trigger
INSERT INTO payesh_direct.tenant_usage (tenant_id, records, bytes)
  SELECT tenant_id, count(*) FILTER (WHERE deleted_at IS NULL), coalesce(sum(octet_length(sealed)), 0)
    FROM payesh_direct.record GROUP BY tenant_id
ON CONFLICT (tenant_id) DO NOTHING;

-- ── idempotency and conflicts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payesh_direct.sync_op (
  tenant_id uuid NOT NULL,
  uid text NOT NULL CHECK (length(uid) BETWEEN 1 AND 80),
  user_id uuid NOT NULL,
  device_id uuid,
  collection text NOT NULL,
  record_id bigint NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pending', 'applied', 'deleted', 'noop', 'conflict')),
  version integer,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, uid)
);

CREATE TABLE IF NOT EXISTS payesh_direct.sync_batch (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  idem_key text NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 120),
  response jsonb NOT NULL,
  final boolean NOT NULL DEFAULT true,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, idem_key)
);

-- both versions are kept: the server one is the record row (version
-- server_version), the local one is local_sealed, sealed by the device for
-- (record, server_version + 1). Neither is readable by the database.
CREATE TABLE IF NOT EXISTS payesh_direct.sync_conflict (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  collection text NOT NULL CHECK (collection ~ '^[a-z_]{1,40}$'),
  record_id bigint NOT NULL CHECK (record_id > 0),
  class_id bigint,
  student_id bigint,
  kind text NOT NULL CHECK (kind IN ('edit_vs_edit', 'delete_vs_edit')),
  base_version integer NOT NULL CHECK (base_version >= 0),
  server_version integer NOT NULL CHECK (server_version >= 0),
  local_sealed text CHECK (local_sealed IS NULL OR (length(local_sealed) <= 1048576
         AND local_sealed ~ '^e2e1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_:@+!~-]+$')),
  uid text NOT NULL,
  reported_by uuid NOT NULL,
  device_id uuid,
  status text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'resolved')),
  decision text CHECK (decision IS NULL OR decision IN ('local', 'server')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_conflict_open_idx ON payesh_direct.sync_conflict (tenant_id, status, id);

ALTER TABLE payesh_direct.tenant_plan OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.tenant_usage OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.sync_op OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.sync_batch OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.sync_conflict OWNER TO payesh_direct_owner;
ALTER SEQUENCE payesh_direct.sync_conflict_id_seq OWNER TO payesh_direct_owner;

-- ── plan (internal) ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION payesh_direct.plan_for(p_tenant uuid) RETURNS payesh_direct.tenant_plan
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_tenant,
         coalesce(t.max_records, 200000), coalesce(t.max_bytes, 536870912),
         coalesce(t.max_ops_per_push, 200), coalesce(t.max_ops_per_window, 1200),
         coalesce(t.window_sec, 60), coalesce(t.max_op_bytes, 131072),
         coalesce(t.updated_at, now())
    FROM (SELECT 1) one
    LEFT JOIN payesh_direct.tenant_plan t ON t.tenant_id = p_tenant
$$;

-- the caller's own plan (clients may see their limits, nobody else's)
CREATE OR REPLACE FUNCTION payesh_direct.my_plan() RETURNS payesh_direct.tenant_plan
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT (payesh_direct.plan_for(t)).* FROM payesh_direct.current_tenant_id() t WHERE t IS NOT NULL
$$;

-- start of every push: count the ops against the window and take the tenant
-- lock (held to COMMIT; serialises the writers of one school, see record_guard)
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

-- ── record trigger: versions, feed position, plan caps ─────────────────────
-- DEFINER only to maintain tenant_usage; it reads nothing of the record table.
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

DROP TRIGGER IF EXISTS record_guard ON payesh_direct.record;
CREATE TRIGGER record_guard BEFORE INSERT OR UPDATE ON payesh_direct.record
  FOR EACH ROW EXECUTE FUNCTION payesh_direct.record_guard();

-- conflict resolution: who and when come from the database, never the client
CREATE OR REPLACE FUNCTION payesh_direct.sync_conflict_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'needs_review' THEN
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'resolved' OR NEW.decision IS NULL THEN
    RAISE EXCEPTION 'bad_decision' USING ERRCODE = '22023';
  END IF;
  NEW.decided_by := payesh_direct.current_user_id();
  NEW.decided_at := now();
  IF NEW.decided_by IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sync_conflict_guard ON payesh_direct.sync_conflict;
CREATE TRIGGER sync_conflict_guard BEFORE UPDATE ON payesh_direct.sync_conflict
  FOR EACH ROW EXECUTE FUNCTION payesh_direct.sync_conflict_guard();

-- ── row level security ─────────────────────────────────────────────────────
ALTER TABLE payesh_direct.tenant_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.tenant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.sync_op ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.sync_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.sync_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.sync_op FORCE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.sync_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.sync_conflict FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_plan_read ON payesh_direct.tenant_plan;
CREATE POLICY tenant_plan_read ON payesh_direct.tenant_plan FOR SELECT TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id());

DROP POLICY IF EXISTS tenant_usage_read ON payesh_direct.tenant_usage;
CREATE POLICY tenant_usage_read ON payesh_direct.tenant_usage FOR SELECT TO payesh_direct_client
  USING (tenant_id = payesh_direct.managed_tenant_id());

DROP POLICY IF EXISTS sync_op_own ON payesh_direct.sync_op;
CREATE POLICY sync_op_own ON payesh_direct.sync_op FOR ALL TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id())
  WITH CHECK (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id());

DROP POLICY IF EXISTS sync_batch_own ON payesh_direct.sync_batch;
CREATE POLICY sync_batch_own ON payesh_direct.sync_batch FOR ALL TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id())
  WITH CHECK (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id());

DROP POLICY IF EXISTS sync_conflict_read ON payesh_direct.sync_conflict;
CREATE POLICY sync_conflict_read ON payesh_direct.sync_conflict FOR SELECT TO payesh_direct_client
  USING (reported_by = payesh_direct.current_user_id() OR tenant_id = payesh_direct.managed_tenant_id());

DROP POLICY IF EXISTS sync_conflict_report ON payesh_direct.sync_conflict;
CREATE POLICY sync_conflict_report ON payesh_direct.sync_conflict FOR INSERT TO payesh_direct_client
  WITH CHECK (tenant_id = payesh_direct.current_tenant_id()
              AND reported_by = payesh_direct.current_user_id()
              AND status = 'needs_review' AND decision IS NULL AND decided_by IS NULL
              AND payesh_direct.can_access('write', tenant_id, collection, class_id, student_id));

DROP POLICY IF EXISTS sync_conflict_resolve ON payesh_direct.sync_conflict;
CREATE POLICY sync_conflict_resolve ON payesh_direct.sync_conflict FOR UPDATE TO payesh_direct_client
  USING (tenant_id = payesh_direct.managed_tenant_id())
  WITH CHECK (tenant_id = payesh_direct.managed_tenant_id());

REVOKE ALL ON payesh_direct.tenant_plan, payesh_direct.tenant_usage, payesh_direct.sync_op,
              payesh_direct.sync_batch, payesh_direct.sync_conflict FROM PUBLIC;
GRANT SELECT ON payesh_direct.tenant_plan, payesh_direct.tenant_usage TO payesh_direct_client;
GRANT SELECT, INSERT, UPDATE, DELETE ON payesh_direct.sync_op TO payesh_direct_client;
GRANT SELECT, INSERT, UPDATE ON payesh_direct.sync_batch TO payesh_direct_client;
GRANT SELECT, INSERT ON payesh_direct.sync_conflict TO payesh_direct_client;
GRANT UPDATE (status, decision) ON payesh_direct.sync_conflict TO payesh_direct_client;
GRANT USAGE ON SEQUENCE payesh_direct.sync_conflict_id_seq TO payesh_direct_client;

-- ── sync_push ──────────────────────────────────────────────────────────────
-- op: { uid, collection, id, type: put|del, base_version, class_id, student_id,
--       sealed (put), verdict: null | 'noop' | 'conflict' | 'reject', error (reject) }
-- A batch whose answer contains stale ops is kept as a PARTIAL answer under its
-- idempotency key; the device re-sends only the stale ops (same uids, with a
-- verdict) under the same key and the database merges the answers. Only the
-- final answer (no stale op left) is replayed.
CREATE OR REPLACE FUNCTION payesh_direct.sync_push(p_ops jsonb, p_idem text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  me uuid := payesh_direct.current_user_id();
  t uuid := payesh_direct.current_tenant_id();
  dev uuid := payesh_direct.request_device_id();
  p payesh_direct.tenant_plan;
  op jsonb; i integer := 0;
  v_uid text; v_col text; v_id bigint; v_type text; v_base integer; v_verdict text;
  v_class bigint; v_student bigint; v_sealed text;
  cur record; got integer; cid bigint;
  applied jsonb := '[]'; duplicates jsonb := '[]'; conflicts jsonb := '[]';
  stale jsonb := '[]'; rejected jsonb := '[]'; out jsonb; hit jsonb; hit_final boolean;
BEGIN
  IF me IS NULL OR t IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN RAISE EXCEPTION 'bad_ops' USING ERRCODE = '22023'; END IF;
  IF p_idem IS NOT NULL AND (length(p_idem) < 1 OR length(p_idem) > 120) THEN
    RAISE EXCEPTION 'bad_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_idem IS NOT NULL THEN
    SELECT response, final INTO hit, hit_final FROM payesh_direct.sync_batch
     WHERE tenant_id = t AND user_id = me AND idem_key = p_idem FOR UPDATE;
    IF hit IS NOT NULL AND hit_final THEN
      RETURN hit || jsonb_build_object('replayed', true, 'idempotency_key', p_idem);
    END IF;
  END IF;
  PERFORM payesh_direct.take_push_quota(jsonb_array_length(p_ops));
  p := payesh_direct.my_plan();

  FOR op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    i := i + 1;
    v_uid := op ->> 'uid';
    v_col := op ->> 'collection';
    v_type := coalesce(op ->> 'type', 'put');
    v_verdict := op ->> 'verdict';
    v_sealed := op ->> 'sealed';
    IF v_uid IS NULL OR length(v_uid) < 1 OR length(v_uid) > 80 THEN
      RAISE EXCEPTION 'bad_uid' USING ERRCODE = '22023', DETAIL = 'op ' || i;
    END IF;
    IF v_col IS NULL OR v_col !~ '^[a-z_]{1,40}$' THEN
      RAISE EXCEPTION 'unknown_collection' USING ERRCODE = '22023', DETAIL = 'op ' || i;
    END IF;
    IF v_type NOT IN ('put', 'del') OR (v_verdict IS NOT NULL AND v_verdict NOT IN ('noop', 'conflict', 'reject'))
       OR (v_verdict = 'reject' AND coalesce(op ->> 'error', '') NOT IN ('write_failed', 'not_found')) THEN
      RAISE EXCEPTION 'bad_op' USING ERRCODE = '22023', DETAIL = 'op ' || i;
    END IF;
    IF jsonb_typeof(op -> 'id') <> 'number' OR (op ->> 'id') !~ '^[0-9]{1,18}$' OR (op ->> 'id')::bigint < 1 THEN
      RAISE EXCEPTION 'bad_id' USING ERRCODE = '22023', DETAIL = 'op ' || i;
    END IF;
    v_id := (op ->> 'id')::bigint;
    IF op ? 'base_version' AND jsonb_typeof(op -> 'base_version') <> 'null' THEN
      IF jsonb_typeof(op -> 'base_version') <> 'number' OR (op ->> 'base_version') !~ '^[0-9]{1,9}$' THEN
        RAISE EXCEPTION 'bad_base_version' USING ERRCODE = '22023', DETAIL = 'op ' || i;
      END IF;
      v_base := (op ->> 'base_version')::integer;
    ELSIF v_type = 'put' THEN
      v_base := 0;          -- no base ⇒ "create": never a blind overwrite
    ELSE
      RAISE EXCEPTION 'bad_base_version' USING ERRCODE = '22023', DETAIL = 'op ' || i || ': del needs base_version';
    END IF;
    v_class := CASE WHEN jsonb_typeof(op -> 'class_id') = 'number' THEN (op ->> 'class_id')::bigint END;
    v_student := CASE WHEN jsonb_typeof(op -> 'student_id') = 'number' THEN (op ->> 'student_id')::bigint END;
    IF v_type = 'put' AND coalesce(v_verdict, '') NOT IN ('noop', 'reject') AND v_sealed IS NULL THEN
      RAISE EXCEPTION 'sealed_required' USING ERRCODE = '22023', DETAIL = 'op ' || i;
    END IF;
    IF v_sealed IS NOT NULL AND octet_length(v_sealed) > p.max_op_bytes THEN
      RAISE EXCEPTION 'op_too_large' USING ERRCODE = '54000', DETAIL = 'op ' || i || ', limit ' || p.max_op_bytes;
    END IF;

    -- idempotency: a uid is consumed exactly once (a concurrent twin waits here)
    INSERT INTO payesh_direct.sync_op (tenant_id, uid, user_id, device_id, collection, record_id, outcome)
    VALUES (t, v_uid, me, dev, v_col, v_id, 'pending')
    ON CONFLICT (tenant_id, uid) DO NOTHING;
    GET DIAGNOSTICS got = ROW_COUNT;
    IF got = 0 THEN
      duplicates := duplicates || jsonb_build_object('uid', v_uid);
      CONTINUE;
    END IF;

    SELECT r.version, r.deleted_at IS NOT NULL AS deleted, r.sealed, r.class_id, r.student_id INTO cur
      FROM payesh_direct.record r
     WHERE r.tenant_id = t AND r.collection = v_col AND r.record_id = v_id
       FOR UPDATE;

    IF v_verdict = 'reject' THEN      -- the device found the op impossible: not final, nothing written
      DELETE FROM payesh_direct.sync_op WHERE tenant_id = t AND uid = v_uid;
      rejected := rejected || jsonb_build_object('uid', v_uid, 'id', v_id, 'error', op ->> 'error');
      CONTINUE;
    END IF;

    IF v_verdict = 'conflict' THEN
      INSERT INTO payesh_direct.sync_conflict (tenant_id, collection, record_id, class_id, student_id, kind,
             base_version, server_version, local_sealed, uid, reported_by, device_id)
      VALUES (t, v_col, v_id, coalesce(v_class, cur.class_id), coalesce(v_student, cur.student_id),
              CASE WHEN v_type = 'del' THEN 'delete_vs_edit' ELSE 'edit_vs_edit' END,
              v_base, coalesce(cur.version, 0), CASE WHEN v_type = 'put' THEN v_sealed END, v_uid, me, dev)
      RETURNING id INTO cid;
      UPDATE payesh_direct.sync_op SET outcome = 'conflict', version = coalesce(cur.version, 0)
       WHERE tenant_id = t AND uid = v_uid;
      conflicts := conflicts || jsonb_build_object('uid', v_uid, 'collection', v_col, 'id', v_id,
                     'server_version', coalesce(cur.version, 0), 'conflict_id', cid);
      CONTINUE;
    END IF;

    IF v_type = 'del' THEN
      IF cur.version IS NULL OR (cur.deleted AND v_base = cur.version) THEN
        DELETE FROM payesh_direct.sync_op WHERE tenant_id = t AND uid = v_uid;   -- not final: retry re-evaluates
        rejected := rejected || jsonb_build_object('uid', v_uid, 'id', v_id, 'error', 'not_found');
        CONTINUE;
      END IF;
    END IF;

    -- OCC: only on top of exactly the version the device has seen
    IF coalesce(cur.version, 0) <> v_base OR (v_type = 'del' AND cur.deleted) THEN
      DELETE FROM payesh_direct.sync_op WHERE tenant_id = t AND uid = v_uid;     -- the device decides, same uid
      stale := stale || jsonb_build_object('uid', v_uid, 'collection', v_col, 'id', v_id,
                 'server_version', coalesce(cur.version, 0), 'deleted', coalesce(cur.deleted, false),
                 'sealed', cur.sealed, 'class_id', cur.class_id, 'student_id', cur.student_id);
      CONTINUE;
    END IF;

    IF v_verdict = 'noop' THEN
      UPDATE payesh_direct.sync_op SET outcome = 'noop', version = coalesce(cur.version, 0)
       WHERE tenant_id = t AND uid = v_uid;
      applied := applied || jsonb_build_object('uid', v_uid, 'id', v_id, 'version', coalesce(cur.version, 0), 'noop', true);
      CONTINUE;
    END IF;

    IF v_type = 'del' THEN
      UPDATE payesh_direct.record SET deleted_at = now(), sealed = NULL, version = version + 1
       WHERE tenant_id = t AND collection = v_col AND record_id = v_id;
      UPDATE payesh_direct.sync_op SET outcome = 'deleted', version = cur.version + 1
       WHERE tenant_id = t AND uid = v_uid;
      applied := applied || jsonb_build_object('uid', v_uid, 'id', v_id, 'version', cur.version + 1, 'deleted', true);
      CONTINUE;
    END IF;

    IF cur.version IS NULL THEN
      INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id, version, sealed)
      VALUES (t, v_col, v_id, v_class, v_student, 1, v_sealed)
      ON CONFLICT (tenant_id, collection, record_id) DO NOTHING;
      GET DIAGNOSTICS got = ROW_COUNT;
      IF got = 0 THEN   -- the row exists but is outside the caller's scope
        RAISE EXCEPTION 'out_of_scope' USING ERRCODE = '42501', DETAIL = 'op ' || i;
      END IF;
    ELSE
      UPDATE payesh_direct.record SET sealed = v_sealed, class_id = v_class, student_id = v_student,
             version = version + 1, deleted_at = NULL
       WHERE tenant_id = t AND collection = v_col AND record_id = v_id;
    END IF;
    UPDATE payesh_direct.sync_op SET outcome = 'applied', version = coalesce(cur.version, 0) + 1
     WHERE tenant_id = t AND uid = v_uid;
    applied := applied || jsonb_build_object('uid', v_uid, 'id', v_id, 'version', coalesce(cur.version, 0) + 1);
  END LOOP;

  IF hit IS NOT NULL THEN          -- continue a partial answer of the same batch
    applied := (hit -> 'applied') || applied;
    duplicates := (hit -> 'duplicates') || duplicates;
    conflicts := (hit -> 'conflicts') || conflicts;
    rejected := (hit -> 'rejected') || rejected;
  END IF;
  out := jsonb_build_object('ok', true, 'schema_version', 1, 'server_time', now(),
           'applied', applied, 'duplicates', duplicates, 'conflicts', conflicts,
           'stale', stale, 'rejected', rejected,
           'counts', jsonb_build_object('applied', jsonb_array_length(applied),
                                        'duplicates', jsonb_array_length(duplicates),
                                        'conflicts', jsonb_array_length(conflicts),
                                        'stale', jsonb_array_length(stale),
                                        'rejected', jsonb_array_length(rejected)));
  IF p_idem IS NOT NULL THEN
    INSERT INTO payesh_direct.sync_batch (tenant_id, user_id, idem_key, response, final)
    VALUES (t, me, p_idem, out, jsonb_array_length(stale) = 0)
    ON CONFLICT (tenant_id, user_id, idem_key)
    DO UPDATE SET response = excluded.response, final = excluded.final, at = now();
    out := out || jsonb_build_object('idempotency_key', p_idem);
  END IF;
  RETURN out;
END $$;

-- ── sync_pull ──────────────────────────────────────────────────────────────
-- limit as the client sent it (text); clamped to 1..50 like the Gateway pull
CREATE OR REPLACE FUNCTION payesh_direct.sync_pull(p_since bigint DEFAULT 0, p_limit text DEFAULT NULL,
                                                   p_collections text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE lim integer; since bigint := coalesce(p_since, 0); rows jsonb; n integer; more boolean; last bigint;
BEGIN
  IF payesh_direct.current_user_id() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF since < 0 THEN RAISE EXCEPTION 'bad_since_seq' USING ERRCODE = '22023'; END IF;
  lim := CASE WHEN p_limit ~ '^\s*[0-9]{1,9}\s*$' THEN greatest(1, least(50, trim(p_limit)::integer)) ELSE 50 END;
  WITH page AS (
    SELECT r.seq, r.collection, r.record_id, r.version, r.class_id, r.student_id, r.sealed,
           r.deleted_at IS NOT NULL AS deleted, r.updated_at
      FROM payesh_direct.record r
     WHERE r.seq > since AND (p_collections IS NULL OR r.collection = ANY (p_collections))
     ORDER BY r.seq
     LIMIT lim + 1)
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'collection', collection, 'id', record_id,
           'version', version, 'class_id', class_id, 'student_id', student_id, 'sealed', sealed,
           'deleted', deleted, 'at', updated_at) ORDER BY seq), '[]'::jsonb), count(*)
    INTO rows, n FROM page;
  more := n > lim;
  IF more THEN rows := rows - lim; n := lim; END IF;
  last := CASE WHEN n > 0 THEN (rows -> (n - 1) ->> 'seq')::bigint ELSE since END;
  RETURN jsonb_build_object('ok', true, 'schema_version', 1, 'server_time', now(), 'rows', rows,
           'count', n, 'more', more, 'next_seq', last, 'limit', lim);
END $$;

-- ── sync_resolve_conflict ──────────────────────────────────────────────────
-- 'server' keeps the row; 'local' records the verdict — the manager device then
-- writes the local version through sync_push (it is the only one that can read it).
CREATE OR REPLACE FUNCTION payesh_direct.sync_resolve_conflict(p_id bigint, p_decision text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r payesh_direct.sync_conflict;
BEGIN
  IF payesh_direct.current_user_id() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('local', 'server') THEN
    RAISE EXCEPTION 'bad_decision' USING ERRCODE = '22023';
  END IF;
  UPDATE payesh_direct.sync_conflict SET status = 'resolved', decision = p_decision WHERE id = p_id
  RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('ok', true, 'id', r.id, 'decision', r.decision, 'decided_by', r.decided_by,
           'collection', r.collection, 'record_id', r.record_id, 'server_version', r.server_version);
END $$;

-- ── ownership and EXECUTE ──────────────────────────────────────────────────
ALTER FUNCTION payesh_direct.plan_for(uuid) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.my_plan() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.take_push_quota(integer) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.record_guard() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.sync_conflict_guard() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.sync_push(jsonb, text) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.sync_pull(bigint, text, text[]) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.sync_resolve_conflict(bigint, text) OWNER TO payesh_direct_owner;

REVOKE ALL ON FUNCTION
  payesh_direct.plan_for(uuid), payesh_direct.my_plan(), payesh_direct.take_push_quota(integer),
  payesh_direct.record_guard(), payesh_direct.sync_conflict_guard(),
  payesh_direct.sync_push(jsonb, text), payesh_direct.sync_pull(bigint, text, text[]),
  payesh_direct.sync_resolve_conflict(bigint, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  payesh_direct.my_plan(), payesh_direct.take_push_quota(integer),
  payesh_direct.sync_push(jsonb, text), payesh_direct.sync_pull(bigint, text, text[]),
  payesh_direct.sync_resolve_conflict(bigint, text)
TO payesh_direct_client;
-- plan_for is internal (any school's plan); the trigger functions need no grant.
