// Row 197 (Q12 / F27، F29) — the parent ↔ school thread, the counselor's appointments and
// the counselor's own desk (every student's record, session and guidance notes).
//
// The twin of server/parent-msgs.js: the same constants, the same row checks (`msgIssue`,
// `noteIssue`) and the same «who may answer» rule (`isRecipient`). The server stays the last
// word (server/policy.js `canWriteRow` / `recipientMsgWrite`); these checks only keep a
// device from queueing a write the server would refuse.
import 'package:payesh_data/payesh_data.dart';

import 'classes.dart' show rosterStudent;
import 'records.dart';

/// server/parent-msgs.js `MSG_TO`.
const List<String> msgTo = ['school', 'teacher', 'counselor'];
const Map<String, String> msgToFa = {
  'school': 'مدرسه (مدیر/معاون)',
  'teacher': 'دبیر',
  'counselor': 'مشاور',
};

/// server/parent-msgs.js `MSG_KINDS`.
const List<String> msgKinds = ['message', 'appointment'];
const Map<String, String> msgKindFa = {
  'message': 'پیام',
  'appointment': 'درخواست وقت ملاقات',
};

/// server/parent-msgs.js `MSG_STATUSES`.
const List<String> msgStatuses = ['open', 'answered', 'scheduled', 'closed'];
const Map<String, String> msgStatusFa = {
  'open': 'در انتظار پاسخ',
  'answered': 'پاسخ داده شد',
  'scheduled': 'وقت ملاقات تعیین شد',
  'closed': 'بسته شد',
};

/// server/parent-msgs.js `NOTE_KINDS` / `GUIDANCE_TRACKS` / `LIMITS`.
const List<String> noteKinds = ['session', 'guidance'];
const Map<String, String> noteKindFa = {
  'session': 'جلسهٔ مشاوره',
  'guidance': 'هدایت تحصیلی',
};
const List<String> guidanceTracks = [
  'ریاضی و فیزیک',
  'علوم تجربی',
  'علوم انسانی',
  'علوم و معارف اسلامی',
  'فنی‌وحرفه‌ای',
  'کاردانش',
];
const int msgTextMax = 1000;
const int msgReplyMax = 1000;
const int noteTextMax = 2000;

/// What each refusal code means on screen (server codes, the same words as the web client).
const Map<String, String> msgIssueFa = {
  'student_required': 'دانش‌آموز را انتخاب کنید',
  'bad_to': 'گیرنده را درست انتخاب کنید (وقت ملاقات با مدرسه یا مشاور است)',
  'bad_kind': 'نوع را درست انتخاب کنید',
  'teacher_required': 'دبیر را انتخاب کنید',
  'text_required': 'متن را بنویسید',
  'text_too_long': 'متن طولانی است',
  'bad_date': 'تاریخ را درست انتخاب کنید',
  'bad_time': 'ساعت را مثل ۱۰:۳۰ بنویسید',
  'bad_status': 'این وضعیت مجاز نیست',
  'appt_required': 'برای تعیین وقت، روز ملاقات را انتخاب کنید',
  'msg_answered': 'این پیام پاسخ گرفته و دیگر ویرایش نمی‌شود',
  'msg_fixed': 'متن، دانش‌آموز و گیرندهٔ پیام عوض نمی‌شود',
  'bad_track': 'رشتهٔ پیشنهادی را از فهرست انتخاب کنید',
  'out_of_scope': 'این مورد در محدودهٔ شما نیست',
  'not_allowed': 'این کار برای نقش شما مجاز نیست',
};

String _s(Object? v) => SchoolRecords.str(v);
bool _empty(Object? v) => _s(v).isEmpty;
bool _posInt(Object? v) {
  final n = SchoolRecords.asInt(v);
  return n != null && n > 0;
}

final RegExp _isoDay = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final RegExp _hhmm = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');
bool _isDate(Object? v) {
  final t = v is String ? v : '';
  if (!_isoDay.hasMatch(t)) return false;
  final d = DateTime.tryParse('${t}T00:00:00Z');
  return d != null && d.toIso8601String().substring(0, 10) == t;
}

bool _isTime(Object? v) => v is String && _hhmm.hasMatch(v);

/// server/parent-msgs.js `msgIssue` — '' when the row is well formed.
String msgIssue(Map<String, Object?> row) {
  if (!_posInt(row['student_id'])) return 'student_required';
  final to = _s(row['to']);
  if (!msgTo.contains(to)) return 'bad_to';
  final kind = _s(row['kind']).isEmpty ? 'message' : _s(row['kind']);
  if (!msgKinds.contains(kind)) return 'bad_kind';
  if (to == 'teacher'
      ? !_posInt(row['teacher_id'])
      : !_empty(row['teacher_id'])) {
    return 'teacher_required';
  }
  if (kind == 'appointment' && to == 'teacher') return 'bad_to';
  final t = _s(row['text']);
  if (t.isEmpty) return 'text_required';
  if (t.length > msgTextMax) return 'text_too_long';
  if (_s(row['reply']).length > msgReplyMax) return 'text_too_long';
  if (!_empty(row['want_date']) && !_isDate(row['want_date'])) {
    return 'bad_date';
  }
  if (!_empty(row['appt_date']) && !_isDate(row['appt_date'])) {
    return 'bad_date';
  }
  if (!_empty(row['appt_time']) && !_isTime(row['appt_time'])) {
    return 'bad_time';
  }
  if (!_empty(row['appt_time']) && _empty(row['appt_date'])) return 'bad_date';
  final st = _s(row['status']).isEmpty ? 'open' : _s(row['status']);
  if (!msgStatuses.contains(st)) return 'bad_status';
  if (st == 'scheduled' &&
      (kind != 'appointment' || _empty(row['appt_date']))) {
    return 'appt_required';
  }
  return '';
}

/// server/parent-msgs.js `noteIssue` — '' when the row is well formed.
String noteIssue(Map<String, Object?> row) {
  if (!_posInt(row['student_id'])) return 'student_required';
  final k = _s(row['kind']).isEmpty ? 'session' : _s(row['kind']);
  if (!noteKinds.contains(k)) return 'bad_kind';
  if (!_empty(row['date']) && !_isDate(row['date'])) return 'bad_date';
  final t = _s(row['text'] ?? row['note']);
  if (t.isEmpty && k == 'session') return 'text_required';
  if (t.length > noteTextMax) return 'text_too_long';
  if (k == 'guidance' && !guidanceTracks.contains(_s(row['track']))) {
    return 'bad_track';
  }
  return '';
}

/// server/parent-msgs.js `isRecipient` (the manager answers every thread).
bool msgRecipient(String role, int uid, Map<String, Object?> row) {
  if (role == 'manager') return true;
  if (role == 'teacher') {
    return _s(row['to']) == 'teacher' &&
        SchoolRecords.asInt(row['teacher_id']) == uid;
  }
  if (role == 'counselor') return _s(row['to']) == 'counselor';
  return false;
}

RecordFailure _fail(String code, [Object? detail]) =>
    RecordFailure(code, msgIssueFa[code] ?? 'درخواست کامل نیست', detail);

/// One `parent_msgs` row with the names the lists show.
final class ParentMsg {
  const ParentMsg({
    required this.row,
    required this.studentName,
    required this.toLabel,
  });
  final EngineRow row;
  final String studentName;

  /// «مدرسه (مدیر/معاون)» / «دبیرِ ریاضی» / «مشاور».
  final String toLabel;

  int get id => row.id;
  int? get studentId => SchoolRecords.asInt(row.data['student_id']);
  String get to => _s(row.data['to']);
  String get kind =>
      _s(row.data['kind']).isEmpty ? 'message' : _s(row.data['kind']);
  String get text => _s(row.data['text']);
  String get reply => _s(row.data['reply']);
  String get wantDate => _s(row.data['want_date']);
  String get apptDate => _s(row.data['appt_date']);
  String get apptTime => _s(row.data['appt_time']);
  String get createdAt => _s(row.data['created_at']);
  String get status =>
      _s(row.data['status']).isEmpty ? 'open' : _s(row.data['status']);
  bool get open => status == 'open';
  bool get isAppointment => kind == 'appointment';

  /// The counselor booked it (no parent wrote it).
  bool get booked =>
      row.data['parent_id'] == null && _s(row.data['replied_by']).isNotEmpty;
}

/// A teacher of a child, as the parent sees them: never the name, only «دبیرِ <درس>».
final class ChildTeacher {
  const ChildTeacher(this.teacherId, this.label);
  final int teacherId;
  final String label;
}

/// `parent_msgs` on the device: the parent sends; the recipient answers; the counselor books.
final class ParentMessages {
  ParentMessages(this.db);
  final SchoolRecords db;

  static const String collection = 'parent_msgs';

  bool get isParent => db.role == 'parent';

  /// The recipients' inbox (web `PAGES.pmsgs`).
  bool get canAnswer =>
      db.role == 'manager' || db.role == 'teacher' || db.role == 'counselor';

  /// The counselor books an appointment for the parents of any student.
  bool get canBook => db.role == 'counselor';

  Future<Set<int>> _children() async => {
    for (final l in await db.allOrEmpty('parent_links'))
      if (SchoolRecords.asInt(l.data['parent_id']) == db.uid)
        ?SchoolRecords.asInt(l.data['student_id']),
  };

  /// Threads this user sees — a parent: every thread of their children (both parents);
  /// a teacher: the ones written to them; the counselor: «به مشاور»; the manager: all.
  /// Open first, then the newest.
  Future<List<ParentMsg>> list({int? studentId}) async {
    final rows = await db.allOrEmpty(collection);
    final kids = isParent ? await _children() : const <int>{};
    final users = {for (final u in await db.allOrEmpty('users')) u.id: u};
    final subjects = {
      for (final s in await db.allOrEmpty('subjects')) s.id: _s(s.data['name']),
    };
    final sched = await db.allOrEmpty('schedule');
    String toLabel(Map<String, Object?> d) {
      final to = _s(d['to']);
      if (to != 'teacher') return msgToFa[to] ?? to;
      final tid = SchoolRecords.asInt(d['teacher_id']);
      final subj = <String>{
        for (final s in sched)
          if (SchoolRecords.asInt(s.data['teacher_id']) == tid)
            subjects[SchoolRecords.asInt(s.data['subject_id'])] ?? '',
      }..remove('');
      return subj.isEmpty
          ? 'دبیر'
          : 'دبیرِ ${(subj.toList()..sort()).join('، ')}';
    }

    final out = <ParentMsg>[];
    for (final r in rows) {
      final sid = SchoolRecords.asInt(r.data['student_id']);
      if (studentId != null && sid != studentId) continue;
      final visible = isParent
          ? kids.contains(sid)
          : msgRecipient(db.role, db.uid, r.data);
      if (!visible) continue;
      out.add(
        ParentMsg(
          row: r,
          studentName: _s(users[sid]?.data['name']),
          toLabel: toLabel(r.data),
        ),
      );
    }
    out.sort((a, b) {
      if (a.open != b.open) return a.open ? -1 : 1;
      final c = b.createdAt.compareTo(a.createdAt);
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return out;
  }

  /// The teachers of a child's class (from the weekly schedule), labelled by subject.
  Future<List<ChildTeacher>> teachersOf(int studentId) async {
    final st = await db.engine.get('users', studentId);
    final cid = SchoolRecords.asInt(st?.data['class_id']);
    if (cid == null) return const [];
    final subjects = {
      for (final s in await db.allOrEmpty('subjects')) s.id: _s(s.data['name']),
    };
    final by = <int, Set<String>>{};
    for (final s in await db.allOrEmpty('schedule')) {
      if (SchoolRecords.asInt(s.data['class_id']) != cid) continue;
      final tid = SchoolRecords.asInt(s.data['teacher_id']);
      if (tid == null) continue;
      (by[tid] ??= <String>{}).add(
        subjects[SchoolRecords.asInt(s.data['subject_id'])] ?? '',
      );
    }
    final out = [
      for (final e in by.entries)
        ChildTeacher(
          e.key,
          (e.value..remove('')).isEmpty
              ? 'دبیر'
              : 'دبیرِ ${(e.value.toList()..sort()).join('، ')}',
        ),
    ]..sort((a, b) => a.label.compareTo(b.label));
    return out;
  }

  String _nowIso() => db.now().toUtc().toIso8601String();

  /// A parent writes to the school, a teacher of the child, or the counselor — a message or
  /// a request for an appointment (not with a teacher).
  Future<RecordWrite> send({
    required int studentId,
    required String to,
    int? teacherId,
    String kind = 'message',
    required String text,
    String wantDate = '',
  }) async {
    if (!isParent) throw _fail('not_allowed', db.role);
    if (!(await _children()).contains(studentId)) {
      throw _fail('out_of_scope', studentId);
    }
    final row = <String, Object?>{
      'student_id': studentId,
      'parent_id': db.uid,
      'to': to,
      'teacher_id': to == 'teacher' ? teacherId : null,
      'kind': kind,
      'text': text.trim(),
      if (wantDate.trim().isNotEmpty) 'want_date': wantDate.trim(),
      'status': 'open',
      'created_at': _nowIso(),
      'school_id': 1,
    };
    final issue = msgIssue(row);
    if (issue.isNotEmpty) throw _fail(issue);
    if (to == 'teacher' &&
        !(await teachersOf(studentId)).any((t) => t.teacherId == teacherId)) {
      throw _fail('teacher_required', teacherId);
    }
    final id = await db.newId(collection);
    final k = await db.put(collection, id, row);
    return RecordWrite(
      kind == 'appointment'
          ? 'درخواست وقت ملاقات فرستاده شد'
          : 'پیام فرستاده شد',
      id: id,
      keys: [k],
    );
  }

  /// The recipient answers: a reply, and/or a status (answered, scheduled with a day and an
  /// hour — the counselor or the manager — or closed). Text, child and recipient never change.
  Future<RecordWrite> answer(
    int id, {
    String reply = '',
    required String status,
    String apptDate = '',
    String apptTime = '',
  }) async {
    if (!canAnswer) throw _fail('not_allowed', db.role);
    final prev = await db.existing(collection, id, 'پیام');
    if (!msgRecipient(db.role, db.uid, prev.data)) {
      throw _fail('out_of_scope', id);
    }
    if (status == 'open' && _s(prev.data['status']) != 'open') {
      throw _fail('bad_status', status);
    }
    if (status == 'scheduled' &&
        db.role != 'counselor' &&
        db.role != 'manager') {
      throw _fail('bad_status', status);
    }
    final row = <String, Object?>{
      ...prev.data,
      'reply': reply.trim().isEmpty ? prev.data['reply'] : reply.trim(),
      'status': status,
      'appt_date': status == 'scheduled'
          ? apptDate.trim()
          : prev.data['appt_date'],
      'appt_time': status == 'scheduled'
          ? (apptTime.trim().isEmpty ? null : apptTime.trim())
          : prev.data['appt_time'],
      'replied_by': db.uid,
      'answered_at': _nowIso(),
    };
    final issue = msgIssue(row);
    if (issue.isNotEmpty) throw _fail(issue);
    final k = await db.put(collection, id, row, prev: prev);
    return RecordWrite(
      status == 'scheduled'
          ? 'وقت ملاقات ثبت شد'
          : status == 'closed'
          ? 'پیام بسته شد'
          : 'پاسخ ثبت شد',
      id: id,
      keys: [k],
    );
  }

  /// The counselor books an appointment for the parents of a student (already «scheduled»).
  Future<RecordWrite> book({
    required int studentId,
    required String apptDate,
    String apptTime = '',
    required String text,
  }) async {
    if (!canBook) throw _fail('not_allowed', db.role);
    final st = await db.engine.get('users', studentId);
    if (st == null || _s(st.data['role']) != 'student') {
      throw _fail('out_of_scope', studentId);
    }
    final row = <String, Object?>{
      'student_id': studentId,
      'parent_id': null,
      'to': 'counselor',
      'teacher_id': null,
      'kind': 'appointment',
      'text': text.trim(),
      'status': 'scheduled',
      'appt_date': apptDate.trim(),
      if (apptTime.trim().isNotEmpty) 'appt_time': apptTime.trim(),
      'replied_by': db.uid,
      'created_at': _nowIso(),
      'school_id': 1,
    };
    final issue = msgIssue(row);
    if (issue.isNotEmpty) throw _fail(issue);
    final id = await db.newId(collection);
    final k = await db.put(collection, id, row);
    return RecordWrite('وقت ملاقات برای اولیا ثبت شد', id: id, keys: [k]);
  }
}

/// One `counselor_notes` row.
final class CounselNote {
  const CounselNote(this.row);
  final EngineRow row;
  int get id => row.id;
  int? get studentId => SchoolRecords.asInt(row.data['student_id']);
  String get kind =>
      _s(row.data['kind']).isEmpty ? 'session' : _s(row.data['kind']);
  String get date => _s(row.data['date']);
  String get text => _s(row.data['text'] ?? row.data['note']);
  String get track => _s(row.data['track']);
}

/// One student in the counselor's list.
final class CounselStudent {
  const CounselStudent(this.row, this.className);
  final EngineRow row;
  final String className;
  int get id => row.id;
  String get name => _s(row.data['name']);
  String get cohort => [
    _s(row.data['grade']),
    _s(row.data['branch']),
  ].where((s) => s.isNotEmpty).join(' · ');
}

/// Row 197 (F29): the counselor's desk — every active student (search by name), and the
/// counselor's own notes (only the counselor reads them; server/policy.js `counselor_notes`).
final class CounselorDesk {
  CounselorDesk(this.db);
  final SchoolRecords db;

  static const String notes = 'counselor_notes';

  bool get isCounselor => db.role == 'counselor';

  Future<List<CounselStudent>> students({String query = ''}) async {
    if (!isCounselor && db.role != 'manager') {
      throw _fail('not_allowed', db.role);
    }
    final q = query.trim();
    final classes = {
      for (final c in await db.allOrEmpty('classes')) c.id: _s(c.data['name']),
    };
    final out = [
      for (final u in await db.allOrEmpty('users'))
        if (rosterStudent(u.data) &&
            (q.isEmpty || _s(u.data['name']).contains(q)))
          CounselStudent(
            u,
            classes[SchoolRecords.asInt(u.data['class_id'])] ?? '',
          ),
    ]..sort((a, b) => a.name.compareTo(b.name));
    return out;
  }

  /// The counselor's notes about one student, newest first.
  Future<List<CounselNote>> notesOf(int studentId) async {
    final out = [
      for (final r in await db.allOrEmpty(notes))
        if (SchoolRecords.asInt(r.data['student_id']) == studentId)
          CounselNote(r),
    ];
    out.sort((a, b) {
      final c = b.date.compareTo(a.date);
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return out;
  }

  /// A session note, or an educational-guidance note with the suggested track.
  Future<RecordWrite> addNote({
    required int studentId,
    required String kind,
    String text = '',
    String track = '',
    String date = '',
  }) async {
    if (!isCounselor) throw _fail('not_allowed', db.role);
    final row = <String, Object?>{
      'student_id': studentId,
      'kind': kind,
      'text': text.trim(),
      if (kind == 'guidance') 'track': track.trim(),
      'date': date.trim().isEmpty ? db.today() : date.trim(),
      'author_id': db.uid,
      'school_id': 1,
    };
    final issue = noteIssue(row);
    if (issue.isNotEmpty) throw _fail(issue);
    final id = await db.newId(notes);
    final k = await db.put(notes, id, row);
    return RecordWrite(
      kind == 'guidance' ? 'هدایت تحصیلی ثبت شد' : 'جلسهٔ مشاوره ثبت شد',
      id: id,
      keys: [k],
    );
  }
}

/// Row 197 (F27): what the child page adds beyond the record — the contributions recorded
/// for the child (read only) and whether the child is marked absent today.
final class ChildExtras {
  ChildExtras(this.db);
  final SchoolRecords db;

  Future<List<EngineRow>> contributions(int studentId) async => [
    for (final r in await db.allOrEmpty('contributions'))
      if (SchoolRecords.asInt(r.data['student_id']) == studentId) r,
  ]..sort((a, b) => _s(b.data['date']).compareTo(_s(a.data['date'])));

  /// `absent` / `late` / `early_exit` today, or '' (present or not taken).
  Future<String> todayStatus(int studentId) async {
    final t = db.today();
    for (final a in await db.allOrEmpty('attendance')) {
      if (SchoolRecords.asInt(a.data['student_id']) == studentId &&
          _s(a.data['date']) == t) {
        final s = _s(a.data['status']);
        if (s == 'absent' || s == 'late' || s == 'early_exit') return s;
      }
    }
    return '';
  }
}
