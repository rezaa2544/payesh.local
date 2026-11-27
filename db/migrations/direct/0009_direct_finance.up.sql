-- phase: expand
-- ═══════════════════════════════════════════════════════════════════════════
-- Row 197 (Q07 / F32, F33): voluntary contributions («کمک داوطلبانه») and the
-- board of trustees («هیئت امنا»).
--
-- server/policy.js gained the collections `contributions` and `trustees`
-- (manager only). The direct path keeps the list of syncable collections equal
-- to policy.collectionAllowed() (direct-sync-108 SY-05), so the allow-list
-- function is re-created with the two new names. No table, policy or
-- capability changes: their rows are ordinary records of the tenant manager.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION payesh_direct.collection_known(p_collection text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_collection = ANY (ARRAY[
    'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule',
    'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves',
    'parent_links', 'internships', 'staff_attendance', 'staff_posts', 'counselor_refs',
    'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'app_settings',
    'import_issues', 'conflicts', 'visitors', 'contributions', 'trustees'])
$$;
