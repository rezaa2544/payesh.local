-- Row 80 down: remove the telemetry ingest of the direct path.
DROP FUNCTION IF EXISTS payesh_direct.telemetry_ingest(jsonb, boolean);
DROP TABLE IF EXISTS payesh_direct.telemetry_usage;
DROP TABLE IF EXISTS payesh_direct.telemetry_event;
