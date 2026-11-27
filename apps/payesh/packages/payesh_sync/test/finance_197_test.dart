// Row 197 (Q07 / F32, F33) — «کمک‌های مردمی» and «هیئت امنا». Unit level: local SQLite + durable
// outbox, no network. The same shape codes as server/school-finance.js (tests/school-type-197.js
// T04/T05 use the very same rows).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final _now = DateTime.utc(2026, 11, 27, 7, 30);

Future<(SqliteEngine, SchoolRecords)> seeded({
  String type = 'exemplary',
  Map<String, Object?> caps = const {'has_tuition': 1},
  String role = 'manager',
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: const OutboxConfig());
  await e.put('schools', 1, {
    'id': 1,
    'name': 'مدرسه',
    'school_type': type,
    'capabilities': caps,
  }, version: 1);
  await e.put('users', 2, {
    'id': 2,
    'name': 'مدیر',
    'role': 'manager',
  }, version: 1);
  final db = SchoolRecords(
    engine: e,
    outbox: ob,
    role: role,
    uid: 2,
    random: Random(7),
    now: () => _now,
  );
  return (e, db);
}

Matcher _code(String c) =>
    throwsA(isA<RecordFailure>().having((f) => f.code, 'code', c));

Map<String, Object?> _gift([Map<String, Object?> x = const {}]) => {
  'kind': 'voluntary',
  'payer': 'ولی سارا',
  'amount': 5000000,
  'date': '2026-11-27',
  'purpose': 'خرید پروژکتور',
  'receipt_no': 'R-12',
  ...x,
};

void main() {
  test(
    'F-01 shape codes equal the server (contributionIssue / trusteeIssue)',
    () {
      const pub = {'school_type': 'exemplary'};
      final got = [
        for (final x in <Map<String, Object?>>[
          {'amount': 0},
          {'amount': 12.5},
          {'payer': ' '},
          {'date': '1405/09/01'},
          {'kind': 'fee'},
          {'required': true},
          {'kind': 'tuition'},
        ])
          contributionIssue(_gift(x), school: pub),
      ];
      expect(got, [
        'amount',
        'amount',
        'payer',
        'bad_date',
        'bad_kind',
        'voluntary_required',
        'tuition_public',
      ]);
      expect(contributionIssue(_gift(), school: pub), isNull);
      expect(
        contributionIssue(
          _gift({'kind': 'tuition'}),
          school: {
            'school_type': 'non_profit',
            'capabilities': {'has_tuition': 1},
          },
        ),
        isNull,
      );
      final t = [
        trusteeIssue({'kind': 'member', 'name': '', 'post': 'رئیس'}),
        trusteeIssue({'kind': 'member', 'name': 'x', 'post': 'سلطان'}),
        trusteeIssue({'kind': 'meeting', 'date': '2026-11-27', 'title': ''}),
        trusteeIssue({'kind': 'meeting', 'date': 'x', 'title': 'y'}),
        trusteeIssue({'kind': 'party'}),
      ];
      expect(t, [
        'member_name',
        'member_post',
        'meeting_title',
        'bad_date',
        'bad_kind',
      ]);
      for (final c in [...got, ...t, 'feature_off']) {
        expect(financeIssueFa.containsKey(c), isTrue, reason: '$c');
      }
    },
  );

  test(
    'F-02 public school: tuition off (stale has_tuition too), trustees on',
    () {
      for (final t in ['governmental', 'exemplary', 'shahed', 'boarding', '']) {
        final s = {
          'school_type': t,
          'capabilities': {'has_tuition': 1},
        };
        expect(isPublicSchool(s), isTrue, reason: t);
        expect(tuitionOn(s), isFalse, reason: t);
      }
      expect(
        tuitionOn({
          'school_type': 'non_profit',
          'capabilities': {'has_tuition': 1},
        }),
        isTrue,
      );
      expect(tuitionOn({'school_type': 'non_profit'}), isFalse);
    },
  );

  test(
    'F-03 manager records voluntary contributions; tuition refused',
    () async {
      final (e, db) = await seeded();
      final f = FinanceBook(db);
      await f.addContribution(
        payer: ' ولی سارا ',
        amount: 5000000,
        date: '2026-11-26',
        purpose: 'پروژکتور',
      );
      await f.addContribution(
        payer: 'خیّر محله',
        amount: 120000000,
        date: '2026-11-27',
      );
      final rows = await f.contributionList();
      expect([for (final r in rows) r.payer], ['خیّر محله', 'ولی سارا']);
      expect(rows.every((r) => !r.tuition && r.queued), isTrue);
      expect(rows.last.purpose, 'پروژکتور');
      expect(db.outbox.stats().pending, 2);
      await expectLater(
        f.addContribution(
          payer: 'x',
          amount: 1,
          date: '2026-11-27',
          tuition: true,
        ),
        _code('tuition_public'),
      );
      await expectLater(
        f.addContribution(payer: 'x', amount: 0, date: '2026-11-27'),
        _code('amount'),
      );
      expect(await f.contributionList(), hasLength(2));
      await f.remove(FinanceBook.contributions, rows.first.row);
      expect(await f.contributionList(), hasLength(1));
      expect(await e.get('contributions', rows.first.id), isNull);
    },
  );

  test(
    'F-04 غیرانتفاعی with «شهریه»: tuition accepted; trustees off',
    () async {
      final (_, db) = await seeded(
        type: 'non_profit',
        caps: const {'has_tuition': 1},
      );
      final f = FinanceBook(db);
      await f.addContribution(
        payer: 'ولی',
        amount: 300000000,
        date: '2026-11-27',
        tuition: true,
      );
      expect((await f.contributionList()).single.tuition, isTrue);
      await expectLater(
        f.addMember(name: 'x', post: 'رئیس'),
        _code('feature_off'),
      );
    },
  );

  test(
    'F-05 board of trustees: members by post, meetings newest first',
    () async {
      final (_, db) = await seeded();
      final f = FinanceBook(db);
      await f.addMember(
        name: 'خانم کریمی',
        post: 'دبیر',
        phone: '۰۹۱۲ ۰۰۰ ۰۰۰۰',
      );
      await f.addMember(name: 'آقای احمدی', post: 'رئیس');
      await f.addMeeting(
        date: '2026-10-01',
        title: 'جلسهٔ اول',
        decisions: 'تصویب بودجه',
      );
      await f.addMeeting(date: '2026-11-20', title: 'جلسهٔ دوم');
      final b = await f.board();
      expect([for (final m in b.members) m.post], ['رئیس', 'دبیر']);
      expect(b.members.last.phone, '09120000000');
      expect([for (final m in b.meetings) m.title], ['جلسهٔ دوم', 'جلسهٔ اول']);
      expect(b.meetings.last.decisions, 'تصویب بودجه');
      await expectLater(
        f.addMember(name: 'x', post: 'سلطان'),
        _code('member_post'),
      );
      await expectLater(
        f.addMeeting(date: '2026-11-20', title: ' '),
        _code('meeting_title'),
      );
    },
  );

  test('F-06 only the manager: a teacher cannot write either book', () async {
    final (_, db) = await seeded(role: 'teacher');
    expect(db.canRead('contributions'), isFalse);
    expect(db.canRead('trustees'), isFalse);
    await expectLater(
      FinanceBook(db)
          .addContribution(payer: 'x', amount: 1, date: '2026-11-27'),
      _code('not_allowed'),
    );
    await expectLater(
      FinanceBook(db).addMeeting(date: '2026-11-27', title: 'x'),
      _code('not_allowed'),
    );
    expect(SchoolRecords.idBaseOf('contributions'), 2300000000000000);
    expect(SchoolRecords.idBaseOf('trustees'), 2400000000000000);
  });
}
