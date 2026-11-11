-- phase: expand
-- transaction: false
-- Row 108: index of the change-feed (sync_pull walks record by tenant and seq).
-- Built CONCURRENTLY so a live direct-path database keeps accepting writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS record_feed_idx ON payesh_direct.record (tenant_id, seq);
