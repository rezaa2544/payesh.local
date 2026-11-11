-- phase: expand
-- ═══════════════════════════════════════════════════════════════════════════
-- Row 82 (load test of the direct path, ADR-105 Proposed): finding, fixed.
--
-- The direct-path load run [S] showed sync_pull at ~0.25 ms PER ROW SCANNED:
-- every record policy called payesh_direct.can_access(...) for each candidate
-- row, and can_access calls current_user_id() (claims parse + join, SECURITY
-- DEFINER with a pinned search_path — never inlined). The record policies also
-- carried no tenant predicate, so the feed walk of school A filtered the rows
-- of every other school through that function too: latency grew with the
-- WHOLE database, not with the school (p95 > 1 s at 200 devices / 4 schools).
--
-- Fix, same meaning, evaluated once per statement:
--   • caller-only functions are wrapped as (SELECT fn()) — PostgreSQL runs them
--     once as an InitPlan instead of once per row (they are STABLE: one value
--     per statement either way);
--   • record policies first require tenant_id = the caller's tenant — the feed
--     index record_feed_idx (tenant_id, seq) is now used as an index condition;
--   • a manager of that tenant passes without the per-row capability lookup;
--     everybody else still goes through can_access (capabilities by class /
--     student / collection), exactly as before.
-- Equivalence: can_access(a, t, ...) = [caller active, caller.tenant = t] AND
-- (caller is manager OR a matching capability). With current_tenant_id() NULL
-- (no / revoked / foreign device) "tenant_id = NULL" is never true ⇒ nothing.
-- rls-pentest-109 and direct-sync-108 run on top of this migration in CI.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS record_read ON payesh_direct.record;
CREATE POLICY record_read ON payesh_direct.record FOR SELECT TO payesh_direct_client
  USING (tenant_id = (SELECT payesh_direct.current_tenant_id())
         AND ((SELECT payesh_direct.managed_tenant_id()) IS NOT NULL
              OR payesh_direct.can_access('read', tenant_id, collection, class_id, student_id)));

DROP POLICY IF EXISTS record_insert ON payesh_direct.record;
CREATE POLICY record_insert ON payesh_direct.record FOR INSERT TO payesh_direct_client
  WITH CHECK (tenant_id = (SELECT payesh_direct.current_tenant_id())
              AND ((SELECT payesh_direct.managed_tenant_id()) IS NOT NULL
                   OR payesh_direct.can_access('write', tenant_id, collection, class_id, student_id)));

DROP POLICY IF EXISTS record_update ON payesh_direct.record;
CREATE POLICY record_update ON payesh_direct.record FOR UPDATE TO payesh_direct_client
  USING (tenant_id = (SELECT payesh_direct.current_tenant_id())
         AND ((SELECT payesh_direct.managed_tenant_id()) IS NOT NULL
              OR payesh_direct.can_access('write', tenant_id, collection, class_id, student_id)))
  WITH CHECK (tenant_id = (SELECT payesh_direct.current_tenant_id())
              AND ((SELECT payesh_direct.managed_tenant_id()) IS NOT NULL
                   OR payesh_direct.can_access('write', tenant_id, collection, class_id, student_id)));

DROP POLICY IF EXISTS sync_op_own ON payesh_direct.sync_op;
CREATE POLICY sync_op_own ON payesh_direct.sync_op FOR ALL TO payesh_direct_client
  USING (tenant_id = (SELECT payesh_direct.current_tenant_id()) AND user_id = (SELECT payesh_direct.current_user_id()))
  WITH CHECK (tenant_id = (SELECT payesh_direct.current_tenant_id()) AND user_id = (SELECT payesh_direct.current_user_id()));

DROP POLICY IF EXISTS sync_batch_own ON payesh_direct.sync_batch;
CREATE POLICY sync_batch_own ON payesh_direct.sync_batch FOR ALL TO payesh_direct_client
  USING (tenant_id = (SELECT payesh_direct.current_tenant_id()) AND user_id = (SELECT payesh_direct.current_user_id()))
  WITH CHECK (tenant_id = (SELECT payesh_direct.current_tenant_id()) AND user_id = (SELECT payesh_direct.current_user_id()));

DROP POLICY IF EXISTS tenant_plan_read ON payesh_direct.tenant_plan;
CREATE POLICY tenant_plan_read ON payesh_direct.tenant_plan FOR SELECT TO payesh_direct_client
  USING (tenant_id = (SELECT payesh_direct.current_tenant_id()));
