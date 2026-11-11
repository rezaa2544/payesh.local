-- Row 108 rollback: removes sync_push/sync_pull, the feed column, plan/usage,
-- idempotency and conflict tables added by 0003. Run only where the direct path
-- carries no production data (rollback drill); 0001/0002 stay intact.
DROP FUNCTION IF EXISTS payesh_direct.sync_resolve_conflict(bigint, text);
DROP FUNCTION IF EXISTS payesh_direct.sync_pull(bigint, text, text[]);
DROP FUNCTION IF EXISTS payesh_direct.sync_push(jsonb, text);
DROP TRIGGER IF EXISTS sync_conflict_guard ON payesh_direct.sync_conflict;
DROP TRIGGER IF EXISTS record_guard ON payesh_direct.record;
DROP FUNCTION IF EXISTS payesh_direct.sync_conflict_guard();
DROP FUNCTION IF EXISTS payesh_direct.record_guard();
DROP FUNCTION IF EXISTS payesh_direct.take_push_quota(integer);
DROP FUNCTION IF EXISTS payesh_direct.my_plan();
DROP FUNCTION IF EXISTS payesh_direct.plan_for(uuid);
DROP TABLE IF EXISTS payesh_direct.sync_conflict;
DROP TABLE IF EXISTS payesh_direct.sync_batch;
DROP TABLE IF EXISTS payesh_direct.sync_op;
DROP TABLE IF EXISTS payesh_direct.tenant_usage;
DROP TABLE IF EXISTS payesh_direct.tenant_plan;
ALTER TABLE payesh_direct.record DROP COLUMN IF EXISTS seq;
DROP SEQUENCE IF EXISTS payesh_direct.record_seq;
