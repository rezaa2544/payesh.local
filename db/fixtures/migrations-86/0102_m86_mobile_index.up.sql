-- phase: expand
-- transaction: false
-- Index for the new column, built without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS m86_students_mobile_idx ON m86_students (tenant_id, mobile);
