// Row 128 / W12 — "سلامت داده" (web client/diag.js: PAGES.health, `diag-rerun`, `diag-open`,
// `diag-fix`, `diag-merge-open`, `diag-merge-do`).
//
// Same checks, same rules as the web: every check knows what is wrong and how it is fixed;
// an automatic fix exists only where no data can be lost (safe) — duplicate extra rows,
// orphan links, a class that no longer exists; deleting a person is never automatic, only a
// manual merge. Everything runs on the device's own copy and every repair is an ordinary
// queued write (outbox first), so it works offline and reaches the server on the next sync.
// Web difference: the web took a server backup before a fix; the native app's fixes are
// queued ops the server applies with its own versioning, and the server keeps tombstones.
import 'followup.dart';
import 'records.dart';
import 'timetable.dart';

enum HealthSeverity {
  critical('بحرانی', 3),
  warning('هشدار', 2),
  info('اطلاع', 1);

  const HealthSeverity(this.fa, this.rank);
  final String fa;
  final int rank;
}

/// One finding line: a single row, or a group of rows that look like one person/class.
final class HealthItem {
  const HealthItem({
    this.id,
    this.name = '',
    this.note = '',
    this.key,
    this.members = const [],
  });
  final int? id;
  final String name;
  final String note;

  /// Group key (national id / login / normalised name) — merge input for user groups.
  final String? key;
  final List<HealthMember> members;
  bool get isGroup => members.isNotEmpty;
}

final class HealthMember {
  const HealthMember(this.id, this.name, [this.contact = '']);
  final int id;
  final String name;
  final String contact;
}

final class HealthResult {
  const HealthResult.ok()
    : ok = true,
      count = 0,
      message = '',
      items = const [];
  const HealthResult.bad(this.count, this.message, [this.items = const []])
    : ok = false;
  final bool ok;
  final int count;
  final String message;
  final List<HealthItem> items;
}

final class HealthCheck {
  const HealthCheck({
    required this.id,
    required this.title,
    required this.description,
    required this.severity,
    this.guide = '',
    this.safe = false,
    this.fixable = false,
    this.mergeable = false,
  });
  final String id;
  final String title;
  final String description;
  final HealthSeverity severity;
  final String guide;

  /// The automatic fix loses no data (web `safe`); only then is it offered.
  final bool safe;
  final bool fixable;

  /// Groups of users that can be merged by hand.
  final bool mergeable;
  bool get autoFix => safe && fixable;
}

final class HealthRow {
  const HealthRow(this.check, this.result);
  final HealthCheck check;
  final HealthResult result;
}

final class HealthRun {
  const HealthRun(this.at, this.rows);
  final DateTime at;
  final List<HealthRow> rows;
  List<HealthRow> get bad => [
    for (final r in rows)
      if (!r.result.ok) r,
  ];
  List<HealthRow> get good => [
    for (final r in rows)
      if (r.result.ok) r,
  ];
  int get critical =>
      bad.where((r) => r.check.severity == HealthSeverity.critical).length;
  int get warning =>
      bad.where((r) => r.check.severity == HealthSeverity.warning).length;
}

final class MergeResult {
  const MergeResult(this.moved, this.dropped, this.keys);
  final int moved;
  final int dropped;
  final List<String> keys;
  String get messageFa =>
      'ادغام شد · $moved رکورد منتقل و $dropped حساب تکراری حذف شد';
}

/// A plain (id, data) pair so checks can be computed on lists of any engine row type.
final class HealthRowData {
  const HealthRowData(this.id, this.data);
  final int id;
  final Map<String, Object?> data;
}

/// The data-health checks of one school database (manager only, like the web page).
final class DataHealth {
  DataHealth(this.db);
  final SchoolRecords db;

  static String _s(Object? v) => SchoolRecords.str(v);
  static int? _int(Object? v) => SchoolRecords.asInt(v);
  static String digits(Object? v) => SchoolRecords.digitsOnly(_s(v));

  /// Web `diagNormName`: Arabic ي/ك → Persian, ZWNJ and punctuation → space, lower case.
  static String normName(Object? v) =>
      _s(v)
          .replaceAll(RegExp('[ىي]'), 'ی')
          .replaceAll('ك', 'ک')
          .replaceAll('\u200c', ' ')
          .replaceAll(RegExp(r'[.,،؛:_\-]'), ' ')
          .replaceAll(RegExp(r'\s+'), ' ')
          .trim()
          .toLowerCase();

  /// Web `diagLoginKey`: mobile (≥ 10 digits), else a 10-digit national id.
  static String loginKey(Map<String, Object?> u) {
    final p = digits(u['phone']);
    if (p.length >= 10) return p;
    final n = digits(u['national_id']);
    return n.length == 10 ? n : '';
  }

  static String nameOf(Map<String, Object?> u) {
    final n = _s(u['name']).isNotEmpty ? _s(u['name']) : _s(u['full_name']);
    return n.isEmpty ? '؟' : n;
  }

  static String _personKey(Map<String, Object?> u) =>
      normName(_s(u['name']).isEmpty ? u['full_name'] : u['name']);

  /// Web `DIAG_CHECKS`, same ids and order.
  static const List<HealthCheck> checks = [
    HealthCheck(
      id: 'dup-nid',
      severity: HealthSeverity.critical,
      title: 'کد ملی تکراری',
      description:
          'یک کد ملی برای دو نفر یا بیشتر — ورود و کارنامه قاطی می‌شود',
      guide: 'در هر گروه یکی را نگه دارید و بقیه را با «ادغام» در آن یکی جمع کنید، یا کد ملی اشتباه را ویرایش کنید.',
      mergeable: true,
    ),
    HealthCheck(
      id: 'dup-login',
      severity: HealthSeverity.critical,
      title: 'نام کاربری (ورود) تکراری',
      description: 'دو کاربر با یک شماره/کد ملی وارد می‌شوند — یکی از آن‌ها نمی‌تواند وارد شود',
      guide: 'برای نفر دوم یک شمارهٔ همراه درست ثبت کنید یا اگر همان شخص است، حساب‌ها را ادغام کنید.',
      mergeable: true,
    ),
    HealthCheck(
      id: 'dup-person',
      severity: HealthSeverity.critical,
      title: 'کاربر تکراری (یک نفر، دو حساب)',
      description: 'هم‌نام + هم‌شماره یا هم‌کدملی یا هم‌تاریخ تولد — احتمالاً یک نفر دو بار ثبت شده',
      guide: 'با «ادغام» حساب دوم را در اولی جمع کنید: نمرات، حضور، مرخصی و پیوند ولی منتقل می‌شوند و حساب تکراری حذف می‌شود.',
      mergeable: true,
    ),
    HealthCheck(
      id: 'invalid-nid',
      severity: HealthSeverity.warning,
      title: 'کد ملی ناقص',
      description: 'کد ملی‌ای که ده رقم نیست (احتمالاً اشتباه تایپ شده)',
      guide: 'از «کاربران ← ویرایش» کد ملی ده‌رقمی درست را وارد کنید. با کد ملی ناقص، ورود با کد ملی کار نمی‌کند.',
    ),
    HealthCheck(
      id: 'orphan-link',
      severity: HealthSeverity.critical,
      title: 'پیوند ولیِ بی‌صاحب',
      description: 'پیوندی که پدر/مادر یا دانش‌آموزش پاک شده است',
      safe: true,
      fixable: true,
    ),
    HealthCheck(
      id: 'orphan-class-ref',
      severity: HealthSeverity.critical,
      title: 'دانش‌آموز در کلاسِ پاک‌شده',
      description:
          'کلاسی که حذف شده ولی دانش‌آموزش هنوز به همان کلاس اشاره می‌کند',
      safe: true,
      fixable: true,
    ),
    HealthCheck(
      id: 'no-class',
      severity: HealthSeverity.info,
      title: 'دانش‌آموز بدون کلاس',
      description: 'دانش‌آموزی که کلاسی ندارد یا کلاسش پایه/رشته ندارد',
      guide: 'در صفحهٔ «پیگیری» برای هر نفر کلاس درست را انتخاب کنید.',
    ),
    HealthCheck(
      id: 'class-no-grade',
      severity: HealthSeverity.warning,
      title: 'کلاس بدون پایه',
      description: 'کلاسی که پایه‌اش خالی یا تعریف‌نشده است (بیشتر از ورود دسته‌ای قدیمی)',
      guide: 'در صفحهٔ «کلاس‌ها» هر کلاسی را که پایه ندارد ویرایش یا حذف کنید؛ کلاس‌ها فقط دستی تعریف می‌شوند.',
    ),
    HealthCheck(
      id: 'dup-class',
      severity: HealthSeverity.warning,
      title: 'کلاس تکراری',
      description: 'دو کلاس با همان پایه و رشته',
      guide: 'از «کلاس‌ها ← ادغام» دانش‌آموزان و برنامهٔ یکی را در دیگری جمع کنید.',
    ),
    HealthCheck(
      id: 'dup-lookup',
      severity: HealthSeverity.warning,
      title: 'پایه/رشتهٔ تکراری در تعریف‌ها',
      description: 'یک پایه یا رشته دو بار در فهرست تعریف شده است',
      safe: true,
      fixable: true,
    ),
    HealthCheck(
      id: 'dup-attendance',
      severity: HealthSeverity.warning,
      title: 'حضور تکراری در یک روز',
      description: 'برای یک دانش‌آموز در یک تاریخ دو ثبت حضور',
      safe: true,
      fixable: true,
    ),
    HealthCheck(
      id: 'dup-grade',
      severity: HealthSeverity.warning,
      title: 'نمرهٔ تکراری',
      description: 'برای یک دانش‌آموز، یک درس و یک نوبت دو نمرهٔ هم‌نوع',
      guide: 'در «نمره‌ها» نمرهٔ اضافی را حذف یا اصلاح کنید.',
    ),
    HealthCheck(
      id: 'sched-conflict',
      severity: HealthSeverity.warning,
      title: 'تداخل برنامهٔ هفتگی',
      description: 'یک دبیر یا یک کلاس در یک زنگ دو درس دارد',
      guide: 'در «برنامه» پیشنهاد جای آزاد را بزنید و زنگ را جابه‌جا کنید.',
    ),
    HealthCheck(
      id: 'stuck-queue',
      severity: HealthSeverity.warning,
      title: 'تغییراتِ در انتظارِ ارسال',
      description: 'تغییراتی که هنوز به سرور نرسیده‌اند',
      guide: 'اگر این عدد زیاد ماند، اتصال این دستگاه را بررسی کنید. برنامه خودش هر چند ثانیه دوباره تلاش می‌کند.',
    ),
  ];

  static HealthCheck checkOf(String id) => checks.firstWhere(
    (c) => c.id == id,
    orElse: () => throw const RecordFailure('unknown', 'این آزمون وجود ندارد'),
  );

  void _requireManager() {
    if (db.role != 'manager') {
      throw const RecordFailure('not_allowed', 'این صفحه فقط برای مدیر است');
    }
  }

  /// Web `diagRun`: every check (a failing check never breaks the page), failures first by
  /// severity, the rest in declaration order.
  Future<HealthRun> run() async {
    _requireManager();
    final rows = <HealthRow>[];
    for (final c in checks) {
      HealthResult r;
      try {
        r = await check(c.id);
      } on Object catch (e) {
        r = HealthResult.bad(1, 'این آزمون اجرا نشد: $e');
      }
      rows.add(HealthRow(c, r));
    }
    final order = {for (var i = 0; i < rows.length; i++) rows[i]: i};
    rows.sort((a, b) {
      if (a.result.ok != b.result.ok) return a.result.ok ? 1 : -1;
      final s = b.check.severity.rank - a.check.severity.rank;
      return s != 0 ? s : order[a]!.compareTo(order[b]!);
    });
    return HealthRun(db.now(), rows);
  }

  Future<List<HealthRowData>> _rows(String c) async => [
    for (final r in await db.allOrEmpty(c)) HealthRowData(r.id, r.data),
  ];

  HealthMember _member(HealthRowData u) => HealthMember(
    u.id,
    nameOf(u.data),
    _s(u.data['phone']).isNotEmpty
        ? _s(u.data['phone'])
        : _s(u.data['national_id']),
  );

  List<HealthItem> _groups(
    Map<String, List<HealthRowData>> by, [
    bool Function(List<HealthRowData>)? keep,
  ]) => [
    for (final e in by.entries)
      if (e.key.isNotEmpty &&
          e.value.length > 1 &&
          (keep == null || keep(e.value)))
        HealthItem(key: e.key, members: [for (final u in e.value) _member(u)]),
  ];

  Map<String, List<HealthRowData>> _by(
    List<HealthRowData> rows,
    String Function(Map<String, Object?>) key,
  ) {
    final by = <String, List<HealthRowData>>{};
    for (final r in rows) {
      (by[key(r.data)] ??= []).add(r);
    }
    return by;
  }

  static bool _samePerson(List<HealthRowData> grp) {
    for (var i = 0; i < grp.length; i++) {
      for (var j = i + 1; j < grp.length; j++) {
        final a = grp[i].data, b = grp[j].data;
        final an = digits(a['national_id']), bn = digits(b['national_id']);
        final ap = digits(a['phone']), bp = digits(b['phone']);
        final fa = _s(a['father_nid']), ma = _s(a['mother_nid']);
        if ((an.isNotEmpty && an == bn) ||
            (ap.isNotEmpty && ap == bp) ||
            (_s(a['birth_date']).isNotEmpty &&
                a['birth_date'] == b['birth_date']) ||
            (fa.isNotEmpty &&
                fa == _s(b['father_nid']) &&
                ma.isNotEmpty &&
                ma == _s(b['mother_nid']))) {
          return true;
        }
      }
    }
    return false;
  }

  /// One check (web `check()`).
  Future<HealthResult> check(String id) async {
    _requireManager();
    HealthResult res(List<HealthItem> items, String msg) => items.isEmpty
        ? const HealthResult.ok()
        : HealthResult.bad(items.length, msg, items);
    switch (id) {
      case 'dup-nid':
        final g = _groups(
          _by(await _rows('users'), (u) {
            final n = digits(u['national_id']);
            return n.length == 10 ? n : '';
          }),
        );
        return res(g, '${g.length} کد ملی بین چند کاربر مشترک است');
      case 'dup-login':
        final g = _groups(_by(await _rows('users'), loginKey));
        return res(
          g,
          '${g.length} نام کاربری تکراری — این افراد نمی‌توانند وارد شوند',
        );
      case 'dup-person':
        final g = _groups(_by(await _rows('users'), _personKey), _samePerson);
        return res(g, '${g.length} نفر با دو حساب (تکراری) ثبت شده‌اند');
      case 'invalid-nid':
        final bad = [
          for (final u in await _rows('users'))
            if (digits(u.data['national_id']).isNotEmpty &&
                digits(u.data['national_id']).length != 10)
              HealthItem(
                id: u.id,
                name: nameOf(u.data),
                note: _s(u.data['national_id']),
              ),
        ];
        return bad.isEmpty
            ? const HealthResult.ok()
            : HealthResult.bad(
                bad.length,
                '${bad.length} کاربر کد ملی نامعتبر دارند',
                bad.take(50).toList(),
              );
      case 'orphan-link':
        final users = {for (final u in await _rows('users')) u.id};
        final bad = [
          for (final l in await _rows('parent_links'))
            if (!users.contains(_int(l.data['parent_id'])) ||
                !users.contains(_int(l.data['student_id'])))
              HealthItem(id: l.id, name: 'پیوند ${l.id}'),
        ];
        return res(
          bad,
          '${bad.length} پیوند ولی به کاربرِ پاک‌شده اشاره می‌کند',
        );
      case 'orphan-class-ref':
        final classes = {for (final c in await _rows('classes')) c.id};
        final bad = [
          for (final u in await _rows('users'))
            if (_int(u.data['class_id']) != null &&
                !classes.contains(_int(u.data['class_id'])))
              HealthItem(id: u.id, name: nameOf(u.data)),
        ];
        return res(bad, '${bad.length} کاربر به کلاسِ پاک‌شده اشاره می‌کنند');
      case 'no-class':
        final users = await db.allOrEmpty('users');
        final classes = {
          for (final c in await db.allOrEmpty('classes')) c.id: c,
        };
        final lookups = await db.allOrEmpty('lookups');
        List<String> defs(String k) => [
          for (final l in lookups)
            if (l.data['kind'] == k && _s(l.data['name']).isNotEmpty)
              _s(l.data['name']),
        ];
        final grades = defs('grade'), branches = defs('branch');
        final bad = <HealthItem>[];
        for (final u in users) {
          final r = Followup.reasonOf(u.data, classes, grades, branches);
          if (r.isNotEmpty) {
            bad.add(HealthItem(id: u.id, name: nameOf(u.data), note: r));
          }
        }
        return res(bad, '${bad.length} دانش‌آموز کلاسِ درست ندارد');
      case 'class-no-grade':
        final grades = [
          for (final l in await _rows('lookups'))
            if (_s(l.data['kind']) == 'grade') _s(l.data['name']),
        ];
        final bad = [
          for (final c in await _rows('classes'))
            if (_s(c.data['grade']).trim().isEmpty ||
                (grades.isNotEmpty &&
                    !grades.contains(_s(c.data['grade']).trim())))
              HealthItem(
                id: c.id,
                name: _s(c.data['name']),
                note: _s(c.data['grade']),
              ),
        ];
        return res(bad, '${bad.length} کلاس پایهٔ درست ندارد');
      case 'dup-class':
        final by = _by(await _rows('classes'), (c) {
          final k = normName('${_s(c['grade'])} ${_s(c['branch'])}');
          return k.isNotEmpty ? k : normName(c['name']);
        });
        final g = [
          for (final e in by.entries)
            if (e.key.isNotEmpty && e.value.length > 1)
              HealthItem(
                key: e.key,
                name: e.value.map((c) => _s(c.data['name'])).join('، '),
              ),
        ];
        return res(g, '${g.length} کلاس هم‌نام/هم‌پایه وجود دارد');
      case 'dup-lookup':
        final by = _by(
          await _rows('lookups'),
          (l) => '${_s(l['kind'])}|${normName(l['name'])}',
        );
        final g = [
          for (final e in by.entries)
            if (e.value.length > 1)
              HealthItem(key: e.key, name: _s(e.value.first.data['name'])),
        ];
        return res(g, '${g.length} تعریف تکراری در پایه/رشته‌ها');
      case 'dup-attendance':
        final by = _by(
          await _rows('attendance'),
          (a) => '${_int(a['student_id'])}|${_s(a['date'])}',
        );
        final g = [
          for (final e in by.entries)
            if (e.value.length > 1) HealthItem(key: e.key, name: e.key),
        ];
        return res(g, '${g.length} ثبت حضور تکراری');
      case 'dup-grade':
        final users = {
          for (final u in await _rows('users')) u.id: nameOf(u.data),
        };
        final by = _by(
          await _rows('grades'),
          (g) =>
              '${_s(g['student_id'])}|${_s(g['subject_id'])}|${_s(g['term'])}|${_s(g['exam_type'])}',
        );
        final g = [
          for (final e in by.entries)
            if (e.value.length > 1)
              HealthItem(
                id: e.value.first.id,
                name: users[_int(e.value.first.data['student_id'])] ?? '؟',
                note: 'نمره ${_s(e.value.first.data['score'])}',
              ),
        ];
        return res(g, '${g.length} نمرهٔ تکراری');
      case 'sched-conflict':
        final cs = await Timetable(db).clashes();
        return res([
          for (final c in cs)
            HealthItem(
              name: c.who,
              note:
                  '${c.day >= 0 && c.day < schedDayFa.length ? schedDayFa[c.day] : c.day} · زنگ ${c.period}',
            ),
        ], '${cs.length} تداخل در برنامهٔ هفتگی');
      case 'stuck-queue':
        final n = db.outbox.list().length;
        return n > 20
            ? HealthResult.bad(n, '$n تغییر هنوز ارسال نشده است')
            : const HealthResult.ok();
    }
    throw const RecordFailure('unknown', 'این آزمون وجود ندارد');
  }

  /// Web `diagFix` for a safe check: the queued repair writes and the web's message.
  Future<RecordWrite> fix(String id) async {
    _requireManager();
    final c = checkOf(id);
    if (!c.autoFix) {
      throw const RecordFailure(
        'not_allowed',
        'این مورد خودکار اصلاح نمی‌شود (احتمال از بین رفتن داده)',
      );
    }
    final before = await check(id);
    if (before.ok) return const RecordWrite('چیزی برای اصلاح نمانده');
    final keys = <String>[];
    var n = 0;
    switch (id) {
      case 'orphan-link':
        final users = {for (final u in await db.allOrEmpty('users')) u.id};
        for (final l in await db.allOrEmpty('parent_links')) {
          if (!users.contains(_int(l.data['parent_id'])) ||
              !users.contains(_int(l.data['student_id']))) {
            keys.add(await db.del('parent_links', l));
            n++;
          }
        }
        return RecordWrite('$n پیوند بی‌صاحب پاک شد', keys: keys);
      case 'orphan-class-ref':
        final classes = {for (final c in await db.allOrEmpty('classes')) c.id};
        for (final u in await db.allOrEmpty('users')) {
          final cid = _int(u.data['class_id']);
          if (cid == null || classes.contains(cid)) continue;
          keys.add(
            await db.put('users', u.id, {
              ...u.data,
              'class_id': null,
              'followup_reason': 'کلاسش پاک شده بود — کلاس تازه انتخاب کنید',
              'followup_ack': false,
            }, prev: u),
          );
          n++;
        }
        return RecordWrite(
          '$n دانش‌آموز به «نیازمند پیگیری» منتقل شد',
          keys: keys,
        );
      case 'dup-lookup':
        for (final kind in const ['grade', 'branch']) {
          final by = <String, List<HealthRowData>>{};
          for (final l in await _rows('lookups')) {
            if (_s(l.data['kind']) != kind) continue;
            (by[normName(l.data['name'])] ??= []).add(l);
          }
          for (final grp in by.values) {
            if (grp.length < 2) continue;
            grp.sort((a, b) => a.id.compareTo(b.id));
            final keepName = grp.first.data['name'];
            for (final extra in grp.skip(1)) {
              for (final c in await db.allOrEmpty('classes')) {
                if (_s(c.data[kind]) != _s(extra.data['name'])) continue;
                keys.add(
                  await db.put('classes', c.id, {
                    ...c.data,
                    kind: keepName,
                  }, prev: c),
                );
              }
              final row = await db.get('lookups', extra.id);
              if (row != null) keys.add(await db.del('lookups', row));
              n++;
            }
          }
        }
        return RecordWrite(
          '$n تعریف تکراری پاک شد و کلاس‌ها به نام اصلی برگشتند',
          keys: keys,
        );
      case 'dup-attendance':
        final by = <String, List<HealthRowData>>{};
        for (final a in await _rows('attendance')) {
          (by['${_int(a.data['student_id'])}|${_s(a.data['date'])}'] ??= [])
              .add(a);
        }
        for (final grp in by.values) {
          grp.sort((a, b) => a.id.compareTo(b.id));
          for (final extra in grp.skip(1)) {
            final row = await db.get('attendance', extra.id);
            if (row == null) continue;
            keys.add(await db.del('attendance', row));
            n++;
          }
        }
        return RecordWrite(
          '$n ثبت حضور تکراری حذف شد (اولی نگه داشته شد)',
          keys: keys,
        );
    }
    throw const RecordFailure('unknown', 'این آزمون وجود ندارد');
  }

  /// Web `diag-merge-open`: the users of one duplicate group (by national id, login or
  /// normalised name). Fewer than two = no longer a duplicate.
  Future<List<HealthMember>> mergeGroup(String key) async {
    _requireManager();
    return [
      for (final u in await _rows('users'))
        if (digits(u.data['national_id']) == key ||
            loginKey(u.data) == key ||
            _personKey(u.data) == key)
          _member(u),
    ];
  }

  static const List<String> mergeFields = [
    'first_name',
    'last_name',
    'national_id',
    'phone',
    'birth_date',
    'gender',
    'father_name',
    'father_nid',
    'father_phone',
    'mother_name',
    'mother_nid',
    'mother_phone',
    'landline',
    'residence',
    'address',
    'last_gpa',
    'covered',
    'talent',
    'class_id',
  ];

  static bool _blank(Object? v) => v == null || v == '';

  /// Web `diagMergeUsers`: the kept account takes the empty fields of the others; grades,
  /// attendance, parent links, discipline and leaves move to it; the duplicates are deleted
  /// (the only deletion). All writes are queued.
  Future<MergeResult> merge(int keepId, List<int> dropIds) async {
    _requireManager();
    final keep = await db.get('users', keepId);
    if (keep == null) {
      throw const RecordFailure('unknown', 'حساب اصلی پیدا نشد');
    }
    final drops = <HealthRowData>[];
    for (final id in dropIds.toSet()) {
      if (id == keepId) continue;
      final u = await db.get('users', id);
      if (u != null) drops.add(HealthRowData(u.id, u.data));
    }
    if (drops.isEmpty) {
      throw const RecordFailure('invalid', 'حسابی برای ادغام انتخاب نشد');
    }
    final fill = <String, Object?>{};
    for (final u in drops) {
      for (final f in mergeFields) {
        if (_blank(keep.data[f]) &&
            !_blank(u.data[f]) &&
            !fill.containsKey(f)) {
          fill[f] = u.data[f];
        }
      }
    }
    final keys = <String>[];
    var moved = 0;
    for (final u in drops) {
      for (final c in const ['grades', 'attendance', 'discipline', 'leaves']) {
        for (final r in await db.allOrEmpty(c)) {
          if (_int(r.data['student_id']) != u.id) continue;
          keys.add(
            await db.put(c, r.id, {...r.data, 'student_id': keepId}, prev: r),
          );
          moved++;
        }
      }
      for (final l in await db.allOrEmpty('parent_links')) {
        if (_int(l.data['student_id']) != u.id) continue;
        final dup = (await db.allOrEmpty('parent_links')).any(
          (x) =>
              _int(x.data['parent_id']) == _int(l.data['parent_id']) &&
              _int(x.data['student_id']) == keepId,
        );
        if (dup) {
          keys.add(await db.del('parent_links', l));
        } else {
          keys.add(
            await db.put('parent_links', l.id, {
              ...l.data,
              'student_id': keepId,
            }, prev: l),
          );
          moved++;
        }
      }
      // The duplicate goes before the kept row is rewritten, so a unique phone/national id
      // copied into the kept account never collides with it on the server.
      final row = await db.get('users', u.id);
      if (row != null) keys.add(await db.del('users', row));
    }
    final patch = {...keep.data, ...fill}..remove('followup_reason');
    final fresh = await db.get('users', keepId);
    keys.add(await db.put('users', keepId, patch, prev: fresh));
    return MergeResult(moved, drops.length, keys);
  }
}
