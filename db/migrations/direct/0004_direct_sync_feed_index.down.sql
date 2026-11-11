-- Row 108 rollback of the feed index (CONCURRENTLY: no write lock).
DROP INDEX CONCURRENTLY IF EXISTS payesh_direct.record_feed_idx;
