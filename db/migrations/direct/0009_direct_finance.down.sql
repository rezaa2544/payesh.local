-- Row 197 (Q07) down: the allow-list exactly as 0008 (Q06, visitors) left it.
CREATE OR REPLACE FUNCTION payesh_direct.collection_known(p_collection text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_collection = ANY (ARRAY[
    'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule',
    'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves',
    'parent_links', 'internships', 'staff_attendance', 'staff_posts', 'counselor_refs',
    'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'app_settings',
    'import_issues', 'conflicts', 'visitors'])
$$;
