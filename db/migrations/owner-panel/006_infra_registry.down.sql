-- Rollback for owner-platform migration 006 (row 122): removes the infrastructure registry, its
-- health/metric history, alerts and change requests. Metadata only — no provider resource exists
-- because of these tables. Do not run against production without the Owner's approval and a backup.
BEGIN;
DROP FUNCTION IF EXISTS owner_platform.infra_approve_change(uuid);
DROP FUNCTION IF EXISTS owner_platform.infra_request_change(text, uuid, jsonb, text);
DROP FUNCTION IF EXISTS owner_platform.infra_record_metric(uuid, text, numeric, text, text, text);
DROP FUNCTION IF EXISTS owner_platform.infra_record_check(uuid, boolean, integer, integer, text);
DROP FUNCTION IF EXISTS owner_platform.infra_register_endpoint(uuid, text, text, integer);
DROP FUNCTION IF EXISTS owner_platform.infra_register_service(uuid, text, text, text);
DROP FUNCTION IF EXISTS owner_platform.infra_register_provider(text, text, text, text, text);
DROP TABLE IF EXISTS owner_platform.infra_change_request;
DROP TABLE IF EXISTS owner_platform.infra_alert;
DROP TABLE IF EXISTS owner_platform.infra_metric;
DROP TABLE IF EXISTS owner_platform.infra_health_check;
DROP TABLE IF EXISTS owner_platform.infra_endpoint;
DROP TABLE IF EXISTS owner_platform.infra_service;
DROP TABLE IF EXISTS owner_platform.infra_provider;
COMMIT;
