/// Row 194: «سطح دسترسی» of the school's executive staff (عوامل اجرایی). The manager ticks
/// what each staff member may do; the list is kept on the user row as `access` (a list of the
/// keys below). Copy of server/policy.js `STAFF_ACCESS` — the server is the guard (it accepts
/// or refuses every write and decides what each device pulls); test/staff_access_test.dart
/// fails when the two drift.
library;

import 'records.dart';
import 'school_access.dart' show permRole;

/// One tickable access area.
final class StaffAccessArea {
  const StaffAccessArea({
    required this.key,
    required this.label,
    required this.hint,
    required this.pages,
    required this.write,
    required this.read,
  });

  /// Stored in the user's `access` list.
  final String key;
  final String label;
  final String hint;

  /// Native page ids (school_entry / app nav) this area opens.
  final List<String> pages;

  /// Collections the staff member may write (as the manager would).
  final Set<String> write;

  /// Collections the staff member sees for the whole school.
  final Set<String> read;
}

/// Roles whose access is set by ticks. «معاون» is not here: it has every access of the
/// manager (row 187); «مدیر» itself has everything.
const Set<String> grantableRoles = {'counselor', 'staff', 'office', 'guard'};

/// Same order and keys as server/policy.js `STAFF_ACCESS`.
const List<StaffAccessArea> staffAccessAreas = [
  StaffAccessArea(
    key: 'attendance',
    label: 'حضور و غیاب دانش‌آموزان',
    hint: 'ثبت و ویرایش حضور، غیبت و تأخیر همهٔ کلاس‌ها',
    pages: ['attendance', 'attendance-report'],
    write: {'attendance'},
    read: {'attendance', 'users', 'classes', 'schedule'},
  ),
  StaffAccessArea(
    key: 'leaves',
    label: 'مرخصی‌ها',
    hint: 'دیدن و تأیید یا رد درخواست مرخصی',
    pages: ['leaves'],
    write: {'leaves'},
    read: {'leaves', 'users', 'classes'},
  ),
  StaffAccessArea(
    key: 'notices',
    label: 'اطلاعیه‌ها',
    hint: 'نوشتن و حذف اطلاعیهٔ مدرسه',
    pages: ['notices'],
    write: {'announcements'},
    read: {'announcements'},
  ),
  StaffAccessArea(
    key: 'schedule',
    label: 'برنامهٔ هفتگی',
    hint: 'چیدن زنگ‌ها، دبیر جایگزین و ساعت زنگ‌ها',
    pages: ['schedule'],
    write: {'schedule', 'bell_schedules', 'substitutions'},
    read: {'schedule', 'substitutions', 'classes', 'users'},
  ),
  StaffAccessArea(
    key: 'classes',
    label: 'کلاس‌ها، پایه‌ها و دروس',
    hint: 'تعریف و ویرایش کلاس، پایه، رشته و درس',
    pages: ['classes'],
    write: {'classes', 'subjects', 'lookups'},
    read: {'classes', 'users'},
  ),
  StaffAccessArea(
    key: 'grades',
    label: 'نمرات',
    hint: 'ثبت و تأیید نمرهٔ دانش‌آموزان',
    pages: ['grades'],
    write: {'grades'},
    read: {'grades', 'users', 'classes'},
  ),
  StaffAccessArea(
    key: 'reports',
    label: 'گزارش‌ها (فقط دیدن)',
    hint: 'گزارش حضور و نمرهٔ همهٔ مدرسه — بدون تغییر',
    pages: ['reports', 'attendance-report'],
    write: {},
    read: {'attendance', 'grades', 'discipline', 'users', 'classes'},
  ),
  StaffAccessArea(
    key: 'counsel',
    label: 'ارجاع به مشاور',
    hint: 'فرستادن دانش‌آموز به صف مشاور و دیدن صف',
    pages: ['cqueue'],
    write: {'counselor_refs'},
    read: {'counselor_refs', 'users'},
  ),
];

/// The area of [key] (null for an unknown key).
StaffAccessArea? staffAccessArea(String key) {
  for (final a in staffAccessAreas) {
    if (a.key == key) return a;
  }
  return null;
}

/// The known access keys of a user row's `access` value (a list, or a comma list from an older
/// copy); unknown keys are dropped. Only [grantableRoles] carry access — for every other role
/// the result is empty (the role itself decides).
List<String> staffAccessOf(String role, Object? access) {
  if (!grantableRoles.contains(permRole(role))) return const [];
  final raw = access is List
      ? access.map(SchoolRecords.str)
      : SchoolRecords.str(access).split(',');
  final want = {for (final x in raw) x.trim()};
  return [
    for (final a in staffAccessAreas)
      if (want.contains(a.key)) a.key,
  ];
}

/// The native pages a staff member with [access] may open (beyond what the role has).
Set<String> staffAccessPages(Iterable<String> access) => {
  for (final k in access) ...?staffAccessArea(k)?.pages,
};

/// The collections [access] lets the staff member write.
Set<String> staffAccessWrites(Iterable<String> access) => {
  for (final k in access) ...?staffAccessArea(k)?.write,
};
