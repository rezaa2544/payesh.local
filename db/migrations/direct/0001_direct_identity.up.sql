-- phase: expand
-- Row 106 (ADR-105 §3.1, status Proposed): identity, capabilities, revocation and
-- RLS for the direct path (device -> managed PostgreSQL, no self-hosted Gateway).
--
-- Standard PostgreSQL 13+ only: no extension, no provider schema (no auth.*,
-- no provider roles). The single provider seam is the pair of functions
-- payesh_direct.auth_subject() / payesh_direct.request_device_id(). They read
-- the verified token claims that a PostgREST-style API layer puts into the
-- transaction-local GUC request.jwt.claims. A provider adapter may replace
-- only these two functions.
--
-- Rules enforced here, inside the database:
--   * a role or tenant claim sent by the client is never trusted; role, tenant
--     and capabilities are read from payesh_direct tables only;
--   * a disabled or revoked user, or a revoked or unknown device, resolves to
--     no identity => every policy returns 0 rows;
--   * capabilities, users and devices are written only through SECURITY
--     DEFINER functions, and only by an active manager of the same school;
--   * the client role has no INSERT/UPDATE/DELETE on any identity table and no
--     DELETE on records (deletion = tombstone via deleted_at).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payesh_direct_owner') THEN
    CREATE ROLE payesh_direct_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payesh_direct_client') THEN
    -- group role; the provider's request role (for example the API's
    -- "authenticated" role) is made a member of it at deployment time
    CREATE ROLE payesh_direct_client NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS payesh_direct AUTHORIZATION payesh_direct_owner;
REVOKE ALL ON SCHEMA payesh_direct FROM PUBLIC;
GRANT USAGE ON SCHEMA payesh_direct TO payesh_direct_client;

-- ── tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payesh_direct.app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_code text NOT NULL CHECK (user_code ~ '^[A-Za-z0-9._-]{1,64}$'),
  auth_subject text NOT NULL UNIQUE CHECK (length(auth_subject) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('manager', 'teacher', 'parent', 'student', 'counselor', 'guard')),
  person_id bigint CHECK (person_id IS NULL OR person_id > 0),
  disabled boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS payesh_direct.device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  label text CHECK (label IS NULL OR length(label) <= 80),
  enrolled_by uuid NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES payesh_direct.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, enrolled_by) REFERENCES payesh_direct.app_user (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS device_user_idx ON payesh_direct.device (user_id);

CREATE TABLE IF NOT EXISTS payesh_direct.capability (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('read', 'write')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('school', 'class', 'student')),
  scope_id bigint,
  collection text CHECK (collection IS NULL OR collection ~ '^[a-z_]{1,40}$'),
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT capability_scope_chk CHECK ((scope_kind = 'school') = (scope_id IS NULL)),
  FOREIGN KEY (tenant_id, user_id) REFERENCES payesh_direct.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES payesh_direct.app_user (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS capability_user_idx ON payesh_direct.capability (user_id, tenant_id) WHERE revoked_at IS NULL;

-- append-only trail of identity changes (written only by the functions below)
CREATE TABLE IF NOT EXISTS payesh_direct.identity_audit (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor uuid,
  action text NOT NULL,
  target text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_audit_tenant_idx ON payesh_direct.identity_audit (tenant_id, id);

-- school data for the direct path. Only routing metadata is in clear
-- (tenant, collection, scope ids, version, timestamps, tombstone); row 107
-- turns payload into client-side ciphertext, row 108 adds sync_pull/sync_push.
CREATE TABLE IF NOT EXISTS payesh_direct.record (
  tenant_id uuid NOT NULL,
  collection text NOT NULL CHECK (collection ~ '^[a-z_]{1,40}$'),
  record_id bigint NOT NULL CHECK (record_id > 0),
  class_id bigint,
  student_id bigint,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, collection, record_id)
);
CREATE INDEX IF NOT EXISTS record_class_idx ON payesh_direct.record (tenant_id, class_id);
CREATE INDEX IF NOT EXISTS record_student_idx ON payesh_direct.record (tenant_id, student_id);

ALTER TABLE payesh_direct.app_user OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.device OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.capability OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.identity_audit OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.record OWNER TO payesh_direct_owner;
ALTER SEQUENCE payesh_direct.capability_id_seq OWNER TO payesh_direct_owner;
ALTER SEQUENCE payesh_direct.identity_audit_id_seq OWNER TO payesh_direct_owner;

-- ── provider seam: verified token claims -> subject / device ──────────────

CREATE OR REPLACE FUNCTION payesh_direct.auth_subject() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
           current_setting('request.jwt.claim.sub', true)), '')
$$;

CREATE OR REPLACE FUNCTION payesh_direct.request_device_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              THEN v::uuid END
    FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'device_id',
                          current_setting('request.jwt.claim.device_id', true)) AS v) s
$$;

-- ── identity resolution (definer: reads identity tables past their RLS) ───

-- the caller's user id, or NULL when the user is disabled/revoked or the
-- token's device is missing, unknown, revoked or belongs to someone else
CREATE OR REPLACE FUNCTION payesh_direct.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id
    FROM payesh_direct.app_user u
    JOIN payesh_direct.device d ON d.user_id = u.id AND d.tenant_id = u.tenant_id
   WHERE u.auth_subject = payesh_direct.auth_subject()
     AND NOT u.disabled AND u.revoked_at IS NULL
     AND d.id = payesh_direct.request_device_id()
     AND d.revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION payesh_direct.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.tenant_id FROM payesh_direct.app_user u WHERE u.id = payesh_direct.current_user_id()
$$;

-- tenant of the caller if the caller is an active manager, else NULL
CREATE OR REPLACE FUNCTION payesh_direct.managed_tenant_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.tenant_id FROM payesh_direct.app_user u
   WHERE u.id = payesh_direct.current_user_id() AND u.role = 'manager'
$$;

-- may the caller do p_action on a record with this routing metadata?
CREATE OR REPLACE FUNCTION payesh_direct.can_access(p_action text, p_tenant uuid, p_collection text,
                                                    p_class bigint, p_student bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM payesh_direct.app_user u
     WHERE u.id = payesh_direct.current_user_id()
       AND u.tenant_id = p_tenant
       AND (u.role = 'manager'
            OR EXISTS (
              SELECT 1 FROM payesh_direct.capability c
               WHERE c.user_id = u.id AND c.tenant_id = p_tenant
                 AND c.revoked_at IS NULL
                 AND c.action = p_action
                 AND (c.collection IS NULL OR c.collection = p_collection)
                 AND (c.scope_kind = 'school'
                      OR (c.scope_kind = 'class' AND p_class IS NOT NULL AND c.scope_id = p_class)
                      OR (c.scope_kind = 'student' AND p_student IS NOT NULL AND c.scope_id = p_student)))))
$$;

-- ── row level security ────────────────────────────────────────────────────
-- identity tables: ENABLE (owner = definer functions bypass; clients do not)
-- record: ENABLE + FORCE (nobody reads school data past the policies)

ALTER TABLE payesh_direct.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.device ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.identity_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.record ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.record FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_user_read ON payesh_direct.app_user;
CREATE POLICY app_user_read ON payesh_direct.app_user FOR SELECT TO payesh_direct_client
  USING (id = payesh_direct.current_user_id() OR tenant_id = payesh_direct.managed_tenant_id());

DROP POLICY IF EXISTS device_read ON payesh_direct.device;
CREATE POLICY device_read ON payesh_direct.device FOR SELECT TO payesh_direct_client
  USING (user_id = payesh_direct.current_user_id() OR tenant_id = payesh_direct.managed_tenant_id());

DROP POLICY IF EXISTS capability_read ON payesh_direct.capability;
CREATE POLICY capability_read ON payesh_direct.capability FOR SELECT TO payesh_direct_client
  USING (user_id = payesh_direct.current_user_id() OR tenant_id = payesh_direct.managed_tenant_id());

DROP POLICY IF EXISTS identity_audit_read ON payesh_direct.identity_audit;
CREATE POLICY identity_audit_read ON payesh_direct.identity_audit FOR SELECT TO payesh_direct_client
  USING (tenant_id = payesh_direct.managed_tenant_id());

DROP POLICY IF EXISTS record_read ON payesh_direct.record;
CREATE POLICY record_read ON payesh_direct.record FOR SELECT TO payesh_direct_client
  USING (payesh_direct.can_access('read', tenant_id, collection, class_id, student_id));

DROP POLICY IF EXISTS record_insert ON payesh_direct.record;
CREATE POLICY record_insert ON payesh_direct.record FOR INSERT TO payesh_direct_client
  WITH CHECK (payesh_direct.can_access('write', tenant_id, collection, class_id, student_id));

DROP POLICY IF EXISTS record_update ON payesh_direct.record;
CREATE POLICY record_update ON payesh_direct.record FOR UPDATE TO payesh_direct_client
  USING (payesh_direct.can_access('write', tenant_id, collection, class_id, student_id))
  WITH CHECK (payesh_direct.can_access('write', tenant_id, collection, class_id, student_id));

-- ── grants: read-only identity, no delete on records ──────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA payesh_direct FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA payesh_direct FROM PUBLIC;
GRANT SELECT ON payesh_direct.app_user, payesh_direct.device, payesh_direct.capability,
                payesh_direct.identity_audit TO payesh_direct_client;
GRANT SELECT, INSERT, UPDATE ON payesh_direct.record TO payesh_direct_client;

-- ── write path: SECURITY DEFINER, manager of the same school only ─────────

CREATE OR REPLACE FUNCTION payesh_direct.require_manager() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid;
BEGIN
  t := payesh_direct.managed_tenant_id();
  IF t IS NULL THEN
    RAISE EXCEPTION 'not_manager' USING ERRCODE = '42501';
  END IF;
  RETURN t;
END $$;

-- a user of the caller's own school, or an error (other schools look absent)
CREATE OR REPLACE FUNCTION payesh_direct.user_in_tenant(p_user uuid, p_tenant uuid) RETURNS payesh_direct.app_user
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r payesh_direct.app_user;
BEGIN
  SELECT * INTO r FROM payesh_direct.app_user WHERE id = p_user AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.create_user(p_user_code text, p_auth_subject text, p_role text,
                                                     p_person_id bigint DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid; nid uuid;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  INSERT INTO payesh_direct.app_user (tenant_id, user_code, auth_subject, role, person_id)
       VALUES (t, p_user_code, p_auth_subject, p_role, p_person_id) RETURNING id INTO nid;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'create_user', nid::text, jsonb_build_object('role', p_role, 'user_code', p_user_code));
  RETURN nid;
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.set_user_disabled(p_user uuid, p_disabled boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  PERFORM payesh_direct.user_in_tenant(p_user, t);
  IF p_user = me THEN
    RAISE EXCEPTION 'cannot_disable_self' USING ERRCODE = '42501';
  END IF;
  UPDATE payesh_direct.app_user SET disabled = p_disabled WHERE id = p_user AND tenant_id = t;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, CASE WHEN p_disabled THEN 'disable_user' ELSE 'enable_user' END, p_user::text, '{}'::jsonb);
END $$;

-- permanent: a revoked user cannot be re-enabled
CREATE OR REPLACE FUNCTION payesh_direct.revoke_user(p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  PERFORM payesh_direct.user_in_tenant(p_user, t);
  IF p_user = me THEN
    RAISE EXCEPTION 'cannot_revoke_self' USING ERRCODE = '42501';
  END IF;
  UPDATE payesh_direct.app_user SET revoked_at = coalesce(revoked_at, now()) WHERE id = p_user AND tenant_id = t;
  UPDATE payesh_direct.capability SET revoked_at = now() WHERE user_id = p_user AND tenant_id = t AND revoked_at IS NULL;
  UPDATE payesh_direct.device SET revoked_at = now() WHERE user_id = p_user AND tenant_id = t AND revoked_at IS NULL;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'revoke_user', p_user::text, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.enroll_device(p_user uuid, p_label text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid; u payesh_direct.app_user; nid uuid;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  u := payesh_direct.user_in_tenant(p_user, t);
  IF u.revoked_at IS NOT NULL OR u.disabled THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = '42501';
  END IF;
  INSERT INTO payesh_direct.device (tenant_id, user_id, label, enrolled_by)
       VALUES (t, p_user, p_label, me) RETURNING id INTO nid;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'enroll_device', nid::text, jsonb_build_object('user', p_user));
  RETURN nid;
END $$;

-- a manager revokes any device of the school; a user may revoke an own device
CREATE OR REPLACE FUNCTION payesh_direct.revoke_device(p_device uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid; mt uuid; d payesh_direct.device;
BEGIN
  me := payesh_direct.current_user_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  mt := payesh_direct.managed_tenant_id();
  SELECT * INTO d FROM payesh_direct.device WHERE id = p_device;
  -- coalesce: for a non-manager mt is NULL, and NOT (false OR NULL) is NULL,
  -- which IF treats as false — without it anyone could revoke any device
  IF NOT FOUND OR NOT coalesce(d.user_id = me OR d.tenant_id = mt, false) THEN
    RAISE EXCEPTION 'device_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE payesh_direct.device SET revoked_at = coalesce(revoked_at, now()) WHERE id = p_device;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (d.tenant_id, me, 'revoke_device', p_device::text, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.grant_capability(p_user uuid, p_action text, p_scope_kind text,
                                                          p_scope_id bigint DEFAULT NULL,
                                                          p_collection text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid; u payesh_direct.app_user; nid bigint;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  u := payesh_direct.user_in_tenant(p_user, t);
  IF u.revoked_at IS NOT NULL OR u.disabled THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = '42501';
  END IF;
  INSERT INTO payesh_direct.capability (tenant_id, user_id, action, scope_kind, scope_id, collection, granted_by)
       VALUES (t, p_user, p_action, p_scope_kind, p_scope_id, p_collection, me) RETURNING id INTO nid;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'grant_capability', nid::text,
               jsonb_build_object('user', p_user, 'action', p_action, 'scope_kind', p_scope_kind,
                                  'scope_id', p_scope_id, 'collection', p_collection));
  RETURN nid;
END $$;

CREATE OR REPLACE FUNCTION payesh_direct.revoke_capability(p_capability bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  UPDATE payesh_direct.capability SET revoked_at = coalesce(revoked_at, now())
   WHERE id = p_capability AND tenant_id = t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'revoke_capability', p_capability::text, '{}'::jsonb);
END $$;

-- provisioning only (owner tooling with the migration/admin connection):
-- first manager + first device of a new school. Never granted to clients.
CREATE OR REPLACE FUNCTION payesh_direct.bootstrap_school(p_tenant uuid, p_user_code text, p_auth_subject text,
                                                          p_device_label text DEFAULT NULL,
                                                          OUT user_id uuid, OUT device_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payesh_direct.app_user WHERE tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'school_already_bootstrapped' USING ERRCODE = '23505';
  END IF;
  INSERT INTO payesh_direct.app_user (tenant_id, user_code, auth_subject, role)
       VALUES (p_tenant, p_user_code, p_auth_subject, 'manager') RETURNING id INTO user_id;
  INSERT INTO payesh_direct.device (tenant_id, user_id, label, enrolled_by)
       VALUES (p_tenant, user_id, p_device_label, user_id) RETURNING id INTO device_id;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (p_tenant, NULL, 'bootstrap_school', user_id::text, '{}'::jsonb);
END $$;

-- ── function ownership and EXECUTE (nothing for PUBLIC) ───────────────────

ALTER FUNCTION payesh_direct.auth_subject() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.request_device_id() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.current_user_id() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.current_tenant_id() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.managed_tenant_id() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.can_access(text, uuid, text, bigint, bigint) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.require_manager() OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.user_in_tenant(uuid, uuid) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.create_user(text, text, text, bigint) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.set_user_disabled(uuid, boolean) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.revoke_user(uuid) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.enroll_device(uuid, text) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.revoke_device(uuid) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.grant_capability(uuid, text, text, bigint, text) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.revoke_capability(bigint) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.bootstrap_school(uuid, text, text, text) OWNER TO payesh_direct_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA payesh_direct FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  payesh_direct.auth_subject(),
  payesh_direct.request_device_id(),
  payesh_direct.current_user_id(),
  payesh_direct.current_tenant_id(),
  payesh_direct.managed_tenant_id(),
  payesh_direct.can_access(text, uuid, text, bigint, bigint),
  payesh_direct.create_user(text, text, text, bigint),
  payesh_direct.set_user_disabled(uuid, boolean),
  payesh_direct.revoke_user(uuid),
  payesh_direct.enroll_device(uuid, text),
  payesh_direct.revoke_device(uuid),
  payesh_direct.grant_capability(uuid, text, text, bigint, text),
  payesh_direct.revoke_capability(bigint)
TO payesh_direct_client;
-- require_manager / user_in_tenant are internal helpers; bootstrap_school is
-- provisioning-only: none of them is executable by the client role.
