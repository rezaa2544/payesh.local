-- Row 106 rollback: removes the direct-path identity schema and everything in it.
-- The two group roles are cluster-wide and may be used by other databases, so
-- they are kept; drop them by hand only after every database is rolled back:
--   DROP ROLE payesh_direct_client; DROP ROLE payesh_direct_owner;
DROP SCHEMA IF EXISTS payesh_direct CASCADE;
