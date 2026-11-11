-- phase: expand
-- Row 107 (ADR-105 §3.2, Proposed): device-side end-to-end encryption, database half.
--
-- The database stores ONLY public keys and ciphertext:
--   device.public_key   X25519 public key of each device (the private half stays
--                       in the device's secure store).
--   scope_key           published X25519 PUBLIC key of every scope generation, so
--                       any writer can encrypt to a scope (e2e1 envelope).
--   key_grant           a scope private key (or the school master key for scope
--                       'smk') sealed to ONE device public key. Own rows only.
--   record.sealed       the e2e1 envelope; record.payload must stay '{}' (no clear
--                       text). Format/crypto: tools/e2e1.js, payesh_secure e2e1.dart.
--
-- Rules enforced here (the AC), all through SECURITY DEFINER functions:
--   • a device registers its own public key once (no silent key replacement);
--   • only a manager of the school publishes scope keys, and every publication
--     must be strictly newer than the last one of that scope (no downgrade, no
--     publishing under an older school-master generation);
--   • only a manager grants, only to an active device of an active user of the
--     same school, and only for a scope the user's capabilities cover ('smk'
--     only to managers);
--   • a client reads only the grants of its own current device.
-- Standard PostgreSQL only.

ALTER TABLE payesh_direct.device ADD COLUMN IF NOT EXISTS public_key text
  CHECK (public_key IS NULL OR public_key ~ '^[A-Za-z0-9_-]{43}$');

ALTER TABLE payesh_direct.record ADD COLUMN IF NOT EXISTS sealed text
  CHECK (sealed IS NULL OR (length(sealed) <= 1048576
         AND sealed ~ '^e2e1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_:@+!~-]+$'));
-- no clear text: payload must stay empty and a live row must carry ciphertext.
-- NOT VALID = enforced for every new/updated row without rewriting old rows
-- (expand-safe); a later contract migration can VALIDATE.
ALTER TABLE payesh_direct.record ADD CONSTRAINT record_payload_empty
  CHECK (payload = '{}'::jsonb) NOT VALID;
ALTER TABLE payesh_direct.record ADD CONSTRAINT record_live_is_sealed
  CHECK (deleted_at IS NOT NULL OR sealed IS NOT NULL) NOT VALID;

CREATE TABLE IF NOT EXISTS payesh_direct.scope_key (
  tenant_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(smk|school:[a-z_]{1,40}|class:[0-9]{1,18}:[a-z_]{1,40}|student:[0-9]{1,18}:[a-z_]{1,40})$'),
  smk_gen integer NOT NULL CHECK (smk_gen > 0),
  gen integer NOT NULL CHECK (gen >= 0),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  published_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, smk_gen, gen),
  FOREIGN KEY (tenant_id, published_by) REFERENCES payesh_direct.app_user (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS payesh_direct.key_grant (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES payesh_direct.device (id),
  scope text NOT NULL,
  smk_gen integer NOT NULL,
  gen integer NOT NULL,
  sealed text NOT NULL CHECK (length(sealed) <= 4096
    AND sealed ~ '^e2e1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}\.device![A-Za-z0-9_-]{16}![A-Za-z0-9_-]{64}$'),
  granted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, scope, smk_gen, gen),
  FOREIGN KEY (tenant_id, user_id) REFERENCES payesh_direct.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES payesh_direct.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, scope, smk_gen, gen) REFERENCES payesh_direct.scope_key (tenant_id, scope, smk_gen, gen)
);
CREATE INDEX IF NOT EXISTS key_grant_device_idx ON payesh_direct.key_grant (device_id);

ALTER TABLE payesh_direct.scope_key OWNER TO payesh_direct_owner;
ALTER TABLE payesh_direct.key_grant OWNER TO payesh_direct_owner;
ALTER SEQUENCE payesh_direct.key_grant_id_seq OWNER TO payesh_direct_owner;

-- ── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE payesh_direct.scope_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE payesh_direct.key_grant ENABLE ROW LEVEL SECURITY;

-- public keys: every active user of the school may encrypt to any scope of it
DROP POLICY IF EXISTS scope_key_read ON payesh_direct.scope_key;
CREATE POLICY scope_key_read ON payesh_direct.scope_key FOR SELECT TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id());

-- grants: only those of the caller's own CURRENT device (current_user_id() is
-- NULL for a disabled/revoked user or a revoked/foreign device ⇒ nothing);
-- managers see grant metadata of their school (needed to re-grant on rotation)
DROP POLICY IF EXISTS key_grant_read ON payesh_direct.key_grant;
CREATE POLICY key_grant_read ON payesh_direct.key_grant FOR SELECT TO payesh_direct_client
  USING ((user_id = payesh_direct.current_user_id() AND device_id = payesh_direct.request_device_id())
         OR tenant_id = payesh_direct.managed_tenant_id());

-- ── functions ───────────────────────────────────────────────────────────

-- does user u (active, of tenant t) hold a capability covering scope p_scope?
CREATE OR REPLACE FUNCTION payesh_direct.scope_covered(p_user uuid, p_tenant uuid, p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM payesh_direct.app_user u
     WHERE u.id = p_user AND u.tenant_id = p_tenant AND NOT u.disabled AND u.revoked_at IS NULL
       AND (u.role = 'manager'
            OR (split_part(p_scope, ':', 1) <> 'smk' AND EXISTS (
              SELECT 1 FROM payesh_direct.capability c
               WHERE c.user_id = u.id AND c.tenant_id = p_tenant AND c.revoked_at IS NULL
                 AND c.action = 'read'
                 AND c.scope_kind = split_part(p_scope, ':', 1)
                 AND (c.scope_kind = 'school' OR c.scope_id::text = split_part(p_scope, ':', 2))
                 AND (c.collection IS NULL
                      OR c.collection = CASE WHEN c.scope_kind = 'school' THEN split_part(p_scope, ':', 2)
                                             ELSE split_part(p_scope, ':', 3) END)))))
$$;

-- a device registers its own public key, once
CREATE OR REPLACE FUNCTION payesh_direct.register_device_key(p_public_key text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid; dev uuid; t uuid;
BEGIN
  me := payesh_direct.current_user_id();
  dev := payesh_direct.request_device_id();
  IF me IS NULL OR dev IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  UPDATE payesh_direct.device SET public_key = p_public_key
   WHERE id = dev AND user_id = me AND revoked_at IS NULL AND public_key IS NULL
   RETURNING tenant_id INTO t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'device_key_already_set' USING ERRCODE = '42501';
  END IF;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'register_device_key', dev::text, '{}'::jsonb);
END $$;

-- a manager publishes the public key of a new scope generation
CREATE OR REPLACE FUNCTION payesh_direct.publish_scope_key(p_scope text, p_smk_gen integer, p_gen integer,
                                                           p_public_key text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid; cur_smk integer; cur record;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  -- publications are rare: serialise them so the "newer" checks cannot race
  -- (readers are not blocked by this lock mode)
  LOCK TABLE payesh_direct.scope_key IN SHARE ROW EXCLUSIVE MODE;
  SELECT max(smk_gen) INTO cur_smk FROM payesh_direct.scope_key WHERE tenant_id = t;
  IF cur_smk IS NOT NULL AND p_smk_gen < cur_smk THEN
    RAISE EXCEPTION 'smk_generation_superseded' USING ERRCODE = '22023';
  END IF;
  SELECT smk_gen, gen INTO cur FROM payesh_direct.scope_key
   WHERE tenant_id = t AND scope = p_scope ORDER BY smk_gen DESC, gen DESC LIMIT 1;
  IF FOUND AND (p_smk_gen, p_gen) <= (cur.smk_gen, cur.gen) THEN
    RAISE EXCEPTION 'key_generation_not_newer' USING ERRCODE = '22023';
  END IF;
  INSERT INTO payesh_direct.scope_key (tenant_id, scope, smk_gen, gen, public_key, published_by)
       VALUES (t, p_scope, p_smk_gen, p_gen, p_public_key, me);
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'publish_scope_key', p_scope, jsonb_build_object('smk_gen', p_smk_gen, 'gen', p_gen));
END $$;

-- a manager seals a scope key (or the SMK) to one device of a user who may hold it
CREATE OR REPLACE FUNCTION payesh_direct.put_key_grant(p_device uuid, p_scope text, p_smk_gen integer,
                                                       p_gen integer, p_sealed text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid; me uuid; d payesh_direct.device; gid bigint;
BEGIN
  t := payesh_direct.require_manager();
  me := payesh_direct.current_user_id();
  SELECT * INTO d FROM payesh_direct.device WHERE id = p_device AND tenant_id = t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'device_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF d.revoked_at IS NOT NULL OR d.public_key IS NULL THEN
    RAISE EXCEPTION 'device_not_eligible' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payesh_direct.scope_key
                  WHERE tenant_id = t AND scope = p_scope AND smk_gen = p_smk_gen AND gen = p_gen) THEN
    RAISE EXCEPTION 'scope_key_not_published' USING ERRCODE = 'P0002';
  END IF;
  IF NOT payesh_direct.scope_covered(d.user_id, t, p_scope) THEN
    RAISE EXCEPTION 'scope_not_covered' USING ERRCODE = '42501';
  END IF;
  INSERT INTO payesh_direct.key_grant (tenant_id, user_id, device_id, scope, smk_gen, gen, sealed, granted_by)
       VALUES (t, d.user_id, p_device, p_scope, p_smk_gen, p_gen, p_sealed, me)
  ON CONFLICT (device_id, scope, smk_gen, gen)
  DO UPDATE SET sealed = EXCLUDED.sealed, granted_by = EXCLUDED.granted_by, created_at = now()
  RETURNING id INTO gid;
  INSERT INTO payesh_direct.identity_audit (tenant_id, actor, action, target, detail)
       VALUES (t, me, 'put_key_grant', gid::text,
               jsonb_build_object('device', p_device, 'scope', p_scope, 'smk_gen', p_smk_gen, 'gen', p_gen));
  RETURN gid;
END $$;

ALTER FUNCTION payesh_direct.scope_covered(uuid, uuid, text) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.register_device_key(text) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.publish_scope_key(text, integer, integer, text) OWNER TO payesh_direct_owner;
ALTER FUNCTION payesh_direct.put_key_grant(uuid, text, integer, integer, text) OWNER TO payesh_direct_owner;

REVOKE ALL ON FUNCTION payesh_direct.scope_covered(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION payesh_direct.register_device_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION payesh_direct.publish_scope_key(text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION payesh_direct.put_key_grant(uuid, text, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payesh_direct.register_device_key(text),
                          payesh_direct.publish_scope_key(text, integer, integer, text),
                          payesh_direct.put_key_grant(uuid, text, integer, integer, text)
  TO payesh_direct_client;

REVOKE ALL ON payesh_direct.scope_key, payesh_direct.key_grant FROM PUBLIC;
GRANT SELECT ON payesh_direct.scope_key, payesh_direct.key_grant TO payesh_direct_client;
