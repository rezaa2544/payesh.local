-- Owner platform — migration 004: human login issuer (password + TOTP).
--
-- Decision D-45 (O-17 = option A, Owner, 2026-11-10):
--   * every owner-panel operator logs in with password + TOTP (both mandatory);
--   * no IP allowlist;
--   * at most 3 operator login accounts;
--   * the first account is created by a server-side script
--     (apps/owner-panel/scripts/create-operator.js), never through the API.
--
-- Data boundary:
--   * platform_credentials holds the scrypt hash and the TOTP secret. The
--     runtime role has NO table privilege on it. It can only call
--     login_lookup(login_id) — one row for one exact login id, no listing —
--     and record_login_attempt(...), which atomically enforces TOTP replay
--     protection (accepted step must be > last accepted step) and lockout
--     (5 consecutive failures => 15 minutes).
--   * login_event is append-only (runtime: no direct grant; written by the
--     SECURITY DEFINER function). Raw login ids and IPs are not stored, only
--     truncated SHA-256 references.
--   * The 3-account cap is a trigger under a table lock, so two concurrent
--     inserts cannot both pass.
--
-- Additive and reversible. Apply only after 001, 002 and 003. Roll back 004
-- before 003.
BEGIN;

CREATE TABLE owner_platform.platform_credentials (
  user_id uuid PRIMARY KEY REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  password_hash text NOT NULL,
  totp_secret text NOT NULL,
  totp_last_step bigint NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_credentials_hash_check CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$'),
  CONSTRAINT platform_credentials_totp_check CHECK (totp_secret ~ '^[A-Z2-7]{26,64}$'),
  CONSTRAINT platform_credentials_step_check CHECK (totp_last_step >= 0),
  CONSTRAINT platform_credentials_failed_check CHECK (failed_count >= 0)
);

CREATE TABLE owner_platform.login_event (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES owner_platform.platform_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  login_ref text NOT NULL,
  ip_ref text,
  outcome text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT login_event_outcome_check CHECK (outcome IN
    ('ok', 'bad_credentials', 'unknown_login', 'disabled', 'locked', 'replay')),
  CONSTRAINT login_event_ref_check CHECK (login_ref ~ '^[0-9a-f]{24}$')
);

CREATE FUNCTION owner_platform.enforce_operator_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, owner_platform
AS $fn$
BEGIN
  LOCK TABLE owner_platform.platform_credentials IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) FROM owner_platform.platform_credentials) >= 3 THEN
    RAISE EXCEPTION 'owner panel allows at most 3 operator login accounts (D-45)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER platform_credentials_cap
  BEFORE INSERT ON owner_platform.platform_credentials
  FOR EACH ROW EXECUTE FUNCTION owner_platform.enforce_operator_cap();

CREATE FUNCTION owner_platform.reject_login_event_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, owner_platform
AS $fn$
BEGIN
  RAISE EXCEPTION 'login_event is append-only' USING ERRCODE = '42501';
END
$fn$;

CREATE TRIGGER login_event_append_only
  BEFORE UPDATE OR DELETE ON owner_platform.login_event
  FOR EACH ROW EXECUTE FUNCTION owner_platform.reject_login_event_change();

ALTER TABLE owner_platform.platform_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.platform_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_credentials_owner ON owner_platform.platform_credentials
  TO payesh_platform_owner USING (true) WITH CHECK (true);
ALTER TABLE owner_platform.login_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_platform.login_event FORCE ROW LEVEL SECURITY;
CREATE POLICY login_event_owner ON owner_platform.login_event
  TO payesh_platform_owner USING (true) WITH CHECK (true);

-- One exact login id → one row. No listing, no wildcard.
CREATE FUNCTION owner_platform.login_lookup(p_login_id text)
RETURNS TABLE (user_id uuid, role text, status text, password_hash text,
               totp_secret text, locked boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
  SELECT u.id, u.role, u.status, c.password_hash, c.totp_secret,
         coalesce(c.locked_until > clock_timestamp(), false)
    FROM owner_platform.platform_users u
    JOIN owner_platform.platform_credentials c ON c.user_id = u.id
   WHERE u.login_id = p_login_id
   LIMIT 1
$fn$;

-- Final authority for a login attempt. p_outcome is what the API measured
-- ('ok' only if both password and TOTP matched). Returns the recorded outcome.
CREATE FUNCTION owner_platform.record_login_attempt(
  p_user uuid, p_login_ref text, p_ip_ref text, p_outcome text,
  p_step bigint, p_request_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, owner_platform
AS $fn$
DECLARE
  c owner_platform.platform_credentials%ROWTYPE;
  st text;
  outcome text := p_outcome;
BEGIN
  IF p_outcome NOT IN ('ok', 'bad_credentials', 'unknown_login') THEN
    RAISE EXCEPTION 'invalid login outcome' USING ERRCODE = '22023';
  END IF;
  IF p_user IS NULL THEN
    INSERT INTO owner_platform.login_event(user_id, login_ref, ip_ref, outcome, request_id)
      VALUES (NULL, p_login_ref, p_ip_ref, 'unknown_login', p_request_id);
    RETURN 'unknown_login';
  END IF;

  SELECT * INTO c FROM owner_platform.platform_credentials WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO owner_platform.login_event(user_id, login_ref, ip_ref, outcome, request_id)
      VALUES (NULL, p_login_ref, p_ip_ref, 'unknown_login', p_request_id);
    RETURN 'unknown_login';
  END IF;
  SELECT status INTO st FROM owner_platform.platform_users WHERE id = p_user;

  IF c.locked_until IS NOT NULL AND c.locked_until > clock_timestamp() THEN
    outcome := 'locked';
  ELSIF st IS DISTINCT FROM 'active' THEN
    outcome := 'disabled';
  ELSIF p_outcome = 'ok' AND (p_step IS NULL OR p_step <= c.totp_last_step) THEN
    outcome := 'replay';
  ELSIF p_outcome = 'ok' THEN
    UPDATE owner_platform.platform_credentials
       SET totp_last_step = p_step, failed_count = 0, locked_until = NULL,
           last_login_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE user_id = p_user;
  ELSE
    outcome := 'bad_credentials';
  END IF;

  IF outcome IN ('bad_credentials', 'replay') THEN
    UPDATE owner_platform.platform_credentials
       SET failed_count = CASE WHEN failed_count + 1 >= 5 THEN 0 ELSE failed_count + 1 END,
           locked_until = CASE WHEN failed_count + 1 >= 5 THEN clock_timestamp() + interval '15 minutes' ELSE locked_until END,
           updated_at = clock_timestamp()
     WHERE user_id = p_user;
  END IF;

  INSERT INTO owner_platform.login_event(user_id, login_ref, ip_ref, outcome, request_id)
    VALUES (p_user, p_login_ref, p_ip_ref, outcome, p_request_id);
  RETURN outcome;
END
$fn$;

ALTER TABLE owner_platform.platform_credentials OWNER TO payesh_platform_owner;
ALTER TABLE owner_platform.login_event OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.enforce_operator_cap() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.reject_login_event_change() OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.login_lookup(text) OWNER TO payesh_platform_owner;
ALTER FUNCTION owner_platform.record_login_attempt(uuid, text, text, text, bigint, text) OWNER TO payesh_platform_owner;

REVOKE ALL ON owner_platform.platform_credentials FROM PUBLIC;
REVOKE ALL ON owner_platform.login_event FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION owner_platform.record_login_attempt(uuid, text, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_platform.login_lookup(text) TO payesh_platform_runtime;
GRANT EXECUTE ON FUNCTION owner_platform.record_login_attempt(uuid, text, text, text, bigint, text) TO payesh_platform_runtime;

COMMIT;
