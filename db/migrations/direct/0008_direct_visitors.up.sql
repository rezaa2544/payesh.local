-- phase: expand
-- ═══════════════════════════════════════════════════════════════════════════
-- Row 197 (Q06 / F38, F44): the school gate's visitor log («دفتر مراجعین»).
--
-- server/policy.js gained the collection `visitors` (written by the manager and
-- by a guard whose «درِ مدرسه» area is open). The direct path keeps the list of
-- syncable collections equal to policy.collectionAllowed() (direct-sync-108
-- SY-05), so the allow-list function is re-created with the one new name. No
-- table, policy or capability changes: rows of `visitors` are ordinary records
-- (manager of the tenant, or a capability row like any other collection).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION payesh_direct.collection_known(p_collection text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_collection = ANY (ARRAY[
    'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule',
    'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves',
    'parent_links', 'internships', 'staff_attendance', 'staff_posts', 'counselor_refs',
    'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'app_settings',
    'import_issues', 'conflicts', 'visitors'])
$$;
