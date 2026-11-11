-- Row 82 down: the record / sync policies exactly as rows 106 and 108 created them.
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

DROP POLICY IF EXISTS sync_op_own ON payesh_direct.sync_op;
CREATE POLICY sync_op_own ON payesh_direct.sync_op FOR ALL TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id())
  WITH CHECK (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id());

DROP POLICY IF EXISTS sync_batch_own ON payesh_direct.sync_batch;
CREATE POLICY sync_batch_own ON payesh_direct.sync_batch FOR ALL TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id())
  WITH CHECK (tenant_id = payesh_direct.current_tenant_id() AND user_id = payesh_direct.current_user_id());

DROP POLICY IF EXISTS tenant_plan_read ON payesh_direct.tenant_plan;
CREATE POLICY tenant_plan_read ON payesh_direct.tenant_plan FOR SELECT TO payesh_direct_client
  USING (tenant_id = payesh_direct.current_tenant_id());
