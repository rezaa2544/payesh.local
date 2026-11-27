// Row 197 (Q07 / F32, F33) — «کمک‌های مردمی» and «هیئت امنا».
//
// A public school (every type except غیرانتفاعی) has no mandatory tuition (the 1405 directive);
// what families and donors give is a VOLUNTARY contribution — never a condition of enrolment and
// never a fixed amount. Only a غیرانتفاعی school with the «شهریه» capability records tuition.
// Every public school has a board of trustees («هیئت امنا»): its members and its meetings with
// their resolutions. Both collections are the manager's alone (server/policy.js), and the shape
// rules are the same as server/school-finance.js.
import 'package:payesh_data/payesh_data.dart';

import 'records.dart';

/// School types whose tuition is allowed (server/school-finance.js `TUITION_TYPES`).
const Set<String> tuitionTypes = {'non_profit'};

/// Posts of a board member (server `TRUSTEE_POSTS`).
const List<String> trusteePosts = [
  'رئیس',
  'نایب‌رئیس',
  'دبیر',
  'خزانه‌دار',
  'عضو',
];

/// Largest amount of one row, in rials (server `MAX_AMOUNT`).
const int maxContributionRials = 10000000000000;

final RegExp _isoDay = RegExp(r'^\d{4}-\d{2}-\d{2}$');

bool _capOn(Object? caps, String k) =>
    caps is Map && (caps[k] == 1 || caps[k] == true);

/// A public school (board of trustees, no tuition)?
bool isPublicSchool(Map<String, Object?>? school) {
  final t = SchoolRecords.str(school?['school_type']);
  return !tuitionTypes.contains(t.isEmpty ? 'governmental' : t);
}

/// Tuition is on: a غیرانتفاعی school with the «شهریه» capability (server `tuitionOn`).
bool tuitionOn(Map<String, Object?>? school) =>
    !isPublicSchool(school) && _capOn(school?['capabilities'], 'has_tuition');

/// Same rules as server/school-finance.js `contributionIssue` (null = fine). [school] null =
/// the school row is not known yet (shape only).
String? contributionIssue(
  Map<String, Object?> row, {
  Map<String, Object?>? school,
  bool schoolKnown = true,
}) {
  final kind = SchoolRecords.str(row['kind']).isEmpty
      ? 'voluntary'
      : SchoolRecords.str(row['kind']);
  if (kind != 'voluntary' && kind != 'tuition') return 'bad_kind';
  if (kind == 'tuition' && schoolKnown && !tuitionOn(school)) {
    return 'tuition_public';
  }
  final payer = SchoolRecords.str(row['payer']);
  if (payer.isEmpty || payer.length > 120) return 'payer';
  final a = row['amount'];
  final amount = a is int
      ? a
      : (a is double && a == a.truncateToDouble() ? a.toInt() : null);
  if (amount == null || amount <= 0 || amount > maxContributionRials) {
    return 'amount';
  }
  if (!_isoDay.hasMatch(SchoolRecords.str(row['date']))) return 'bad_date';
  if (SchoolRecords.str(row['purpose']).length > 200 ||
      SchoolRecords.str(row['receipt_no']).length > 40 ||
      SchoolRecords.str(row['note']).length > 500) {
    return 'too_long';
  }
  final sid = row['student_id'];
  if (sid != null && sid != '' && SchoolRecords.asInt(sid) == null) {
    return 'bad_student';
  }
  if (kind == 'voluntary' &&
      (row['required'] == true || row['mandatory'] == true)) {
    return 'voluntary_required';
  }
  return null;
}

/// Same rules as server/school-finance.js `trusteeIssue` (null = fine).
String? trusteeIssue(Map<String, Object?> row) {
  final kind = SchoolRecords.str(row['kind']);
  if (kind == 'member') {
    final name = SchoolRecords.str(row['name']);
    if (name.isEmpty || name.length > 120) return 'member_name';
    if (!trusteePosts.contains(SchoolRecords.str(row['post']))) {
      return 'member_post';
    }
    if (SchoolRecords.str(row['phone']).replaceAll(RegExp(r'\D'), '').length >
        20) {
      return 'too_long';
    }
    return null;
  }
  if (kind != 'meeting') return 'bad_kind';
  if (!_isoDay.hasMatch(SchoolRecords.str(row['date']))) return 'bad_date';
  final title = SchoolRecords.str(row['title']);
  if (title.isEmpty || title.length > 200) return 'meeting_title';
  if (SchoolRecords.str(row['decisions']).length > 4000) return 'too_long';
  return null;
}

const Map<String, String> financeIssueFa = {
  'bad_kind': 'نوع ردیف درست نیست',
  'tuition_public': 'مدرسهٔ دولتی شهریهٔ اجباری ندارد (بخشنامهٔ ۱۴۰۵) — این مبلغ را «کمک داوطلبانه» ثبت کنید',
  'payer': 'نام پرداخت‌کننده را بنویسید (حداکثر ۱۲۰ حرف)',
  'amount': 'مبلغ را به ریال و بزرگ‌تر از صفر بنویسید',
  'bad_date': 'تاریخ درست نیست',
  'too_long': 'یکی از متن‌ها بیش از حد بلند است',
  'bad_student': 'دانش‌آموز درست انتخاب نشده',
  'voluntary_required': 'کمک داوطلبانه نمی‌تواند اجباری یا شرط ثبت‌نام باشد',
  'member_name': 'نام عضو هیئت امنا را بنویسید',
  'member_post': 'سمت عضو را از فهرست انتخاب کنید',
  'meeting_title': 'موضوع جلسه را بنویسید',
  'feature_off': 'هیئت امنا ویژهٔ مدارس دولتی است',
};

/// One row of `contributions`.
final class ContributionRow {
  const ContributionRow({required this.row, required this.queued});
  final EngineRow row;
  final bool queued;

  int get id => row.id;
  bool get tuition => SchoolRecords.str(row.data['kind']) == 'tuition';
  String get payer => SchoolRecords.str(row.data['payer']);
  int get amount => SchoolRecords.asInt(row.data['amount']) ?? 0;
  String get date => SchoolRecords.str(row.data['date']);
  String get purpose => SchoolRecords.str(row.data['purpose']);
  String get receiptNo => SchoolRecords.str(row.data['receipt_no']);
  String get note => SchoolRecords.str(row.data['note']);
  int? get studentId => SchoolRecords.asInt(row.data['student_id']);
}

/// One row of `trustees` (a member or a meeting).
final class TrusteeRow {
  const TrusteeRow({required this.row, required this.queued});
  final EngineRow row;
  final bool queued;

  int get id => row.id;
  bool get isMeeting => SchoolRecords.str(row.data['kind']) == 'meeting';
  String get name => SchoolRecords.str(row.data['name']);
  String get post => SchoolRecords.str(row.data['post']);
  String get phone => SchoolRecords.str(row.data['phone']);
  String get date => SchoolRecords.str(row.data['date']);
  String get title => SchoolRecords.str(row.data['title']);
  String get decisions => SchoolRecords.str(row.data['decisions']);
}

/// The manager's book of contributions and of the board of trustees.
final class FinanceBook {
  FinanceBook(this.db);
  final SchoolRecords db;

  static const String contributions = 'contributions';
  static const String trustees = 'trustees';

  /// The school row (`schools/1`), or null before the first sync.
  Future<Map<String, Object?>?> school() async {
    final rows = await db.allOrEmpty('schools');
    if (rows.isEmpty) return null;
    final one = rows.where((r) => r.id == 1).firstOrNull ?? rows.first;
    return one.data;
  }

  /// Every contribution, newest first.
  Future<List<ContributionRow>> contributionList() async {
    final q = db.queuedIds(contributions);
    final out =
        [
          for (final r in await db.allOrEmpty(contributions))
            ContributionRow(row: r, queued: q.contains(r.id)),
        ]..sort((a, b) {
          final d = b.date.compareTo(a.date);
          return d != 0 ? d : b.id.compareTo(a.id);
        });
    return out;
  }

  /// Members (by post order) and meetings (newest first).
  Future<({List<TrusteeRow> members, List<TrusteeRow> meetings})>
  board() async {
    final q = db.queuedIds(trustees);
    final all = [
      for (final r in await db.allOrEmpty(trustees))
        TrusteeRow(row: r, queued: q.contains(r.id)),
    ];
    final members = all.where((t) => !t.isMeeting).toList()
      ..sort((a, b) {
        final p = trusteePosts.indexOf(a.post) - trusteePosts.indexOf(b.post);
        return p != 0 ? p : a.name.compareTo(b.name);
      });
    final meetings = all.where((t) => t.isMeeting).toList()
      ..sort((a, b) => b.date.compareTo(a.date));
    return (members: members, meetings: meetings);
  }

  Future<RecordWrite> addContribution({
    required String payer,
    required int amount,
    required String date,
    bool tuition = false,
    String purpose = '',
    String receiptNo = '',
    String note = '',
    int? studentId,
  }) async {
    final data = <String, Object?>{
      'kind': tuition ? 'tuition' : 'voluntary',
      'payer': payer.trim(),
      'amount': amount,
      'date': date,
      if (purpose.trim().isNotEmpty) 'purpose': purpose.trim(),
      if (receiptNo.trim().isNotEmpty) 'receipt_no': receiptNo.trim(),
      if (note.trim().isNotEmpty) 'note': note.trim(),
      'student_id': ?studentId,
      'by_id': db.uid,
    };
    final issue = contributionIssue(data, school: await school());
    if (issue != null) {
      throw RecordFailure(issue, financeIssueFa[issue] ?? issue, contributions);
    }
    final id = await db.newId(contributions);
    final k = await db.put(contributions, id, data);
    return RecordWrite(
      tuition
          ? 'شهریهٔ ${data['payer']} ثبت شد'
          : 'کمک ${data['payer']} ثبت شد',
      id: id,
      keys: [k],
    );
  }

  Future<RecordWrite> addMember({
    required String name,
    required String post,
    String phone = '',
  }) => _addTrustee({
    'kind': 'member',
    'name': name.trim(),
    'post': post,
    if (phone.trim().isNotEmpty) 'phone': SchoolRecords.digitsOnly(phone),
  }, 'عضو ${name.trim()} افزوده شد');

  Future<RecordWrite> addMeeting({
    required String date,
    required String title,
    String decisions = '',
  }) => _addTrustee({
    'kind': 'meeting',
    'date': date,
    'title': title.trim(),
    if (decisions.trim().isNotEmpty) 'decisions': decisions.trim(),
  }, 'جلسهٔ «${title.trim()}» ثبت شد');

  Future<RecordWrite> _addTrustee(Map<String, Object?> data, String ok) async {
    final issue = trusteeIssue(data);
    if (issue != null) {
      throw RecordFailure(issue, financeIssueFa[issue] ?? issue, trustees);
    }
    if (!isPublicSchool(await school())) {
      throw RecordFailure(
        'feature_off',
        financeIssueFa['feature_off']!,
        trustees,
      );
    }
    final id = await db.newId(trustees);
    final k = await db.put(trustees, id, {...data, 'by_id': db.uid});
    return RecordWrite(ok, id: id, keys: [k]);
  }

  /// Removes one row of either book.
  Future<RecordWrite> remove(String collection, EngineRow row) async {
    final k = await db.del(collection, row);
    return RecordWrite('حذف شد', id: row.id, keys: [k]);
  }
}
