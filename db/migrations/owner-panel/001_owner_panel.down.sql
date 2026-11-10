-- Rollback for owner-panel migration 001. This removes only the dedicated schema
-- and roles created by this migration. External role memberships must be removed first.
BEGIN;

DROP SCHEMA IF EXISTS owner_platform CASCADE;

DO $rollback_roles$
BEGIN
  IF (SELECT shobj_description(oid, 'pg_authid') FROM pg_catalog.pg_roles WHERE rolname = 'payesh_platform_runtime')
      = 'managed by owner-platform migration 001' THEN
    DROP ROLE payesh_platform_runtime;
  END IF;
  IF (SELECT shobj_description(oid, 'pg_authid') FROM pg_catalog.pg_roles WHERE rolname = 'payesh_platform_owner')
      = 'managed by owner-platform migration 001' THEN
    DROP ROLE payesh_platform_owner;
  END IF;
END
$rollback_roles$;

COMMIT;
