-- phase: expand
-- ═══════════════════════════════════════════════════════════════════════════
-- Row 197 (Q12 / F27, F29): parent messages and counseling appointments
-- («پیام به مدرسه/دبیر/مشاور»، «نوبت مشاوره»).
--
-- server/policy.js gained the collection `parent_msgs` (server/parent-msgs.js).
-- The direct path keeps the list of syncable collections equal to
-- policy.collectionAllowed() (direct-sync-108 SY-05), so the allow-list
-- function is re-created with the one new name. No table, policy or capability
-- changes: its rows are ordinary records (manager of the tenant, or a
-- capability row like any other collection).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION payesh_direct.collection_known(p_collection text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_collection = ANY (ARRAY[
    'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule',
    'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves',
    'parent_links', 'internships', 'staff_attendance', 'staff_posts', 'counselor_refs',
    'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'app_settings',
    'import_issues', 'conflicts', 'visitors', 'contributions', 'trustees', 'parent_msgs'])
$$;
