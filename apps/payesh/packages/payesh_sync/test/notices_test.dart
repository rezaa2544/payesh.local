// Row 74, wave 4 — native notices, unit level (local database + durable outbox, no network).
// Parity target: client/pages.js `PAGES.announcements` + `actAnnAdd`, client/app.js `ann` form
// handler + `ann-delete`; server/policy.js `announcements: { write: ['manager'], read: 'all' }`;
// server/tenancy.js `MAX_OP_BYTES`.
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// 22:00 UTC on 11 Nov = 01:30 on 12 Nov in Tehran: the stored day must be the UTC day.
final clock = DateTime.utc(2026, 11, 11, 22);

/// Random whose values are scripted (to force an id collision), then a seeded generator.
final class ScriptedRandom implements Random {
  ScriptedRandom(this.script);
  final List<int> script;
  final Random _rest = Random(7);
  @override
  int nextInt(int max) =>
      script.isNotEmpty ? script.removeAt(0) : _rest.nextInt(max);
  @override
  bool nextBool() => _rest.nextBool();
  @override
  double nextDouble() => _rest.nextDouble();
}

Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(int id, Map<String, Object?> d, [int v = 1]) =>
      e.put('announcements', id, {...d, 'id': id}, version: v);
  await put(1, {
    'title': 'اردوی پاییزه',
    'body': 'ثبت‌نام تا پنجشنبه',
    'severity': 'info',
    'date': '2026-11-01',
    'author_id': 1,
    'school_id': 1,
  });
  await put(2, {
    'title': 'تعطیلی',
    'body': 'مدرسه شنبه تعطیل است',
    'severity': 'important',
    'date': '2026-11-09',
    'author_id': 1,
  }, 3);
  await put(3, {
    'title': 'جلسهٔ اولیا',
    'body': 'سه‌شنبه ساعت ۱۰',
    'date': '2026-11-09',
    'severity': 'urgent', // unknown value written by some other client
  });
  await put(4, {
    'title': 'حذف‌شده',
    'body': '—',
    'date': '2026-11-10',
    'deleted': true,
  });
  return (e, ob);
}

NoticeBoard board(
  SqliteEngine e,
  SqliteOutbox ob, {
  String role = 'manager',
  int uid = 1,
  Random? random,
}) => NoticeBoard(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  now: () => clock,
  random: random ?? Random(42),
);

Matcher refused(NoticeError k) =>
    throwsA(isA<NoticeFailure>().having((f) => f.kind, 'kind', k));

void main() {
  test('W4-U01 severity values and labels are exactly the web select', () {
    expect(NoticeSeverity.values.map((s) => s.wire), [
      'normal',
      'info',
      'important',
    ]);
    expect(NoticeSeverity.values.map((s) => s.labelFa), [
      'عادی',
      'اطلاع‌رسانی',
      'مهم',
    ]);
    expect(NoticeSeverity.fromWire('urgent'), NoticeSeverity.normal);
    expect(NoticeSeverity.fromWire(null), NoticeSeverity.normal);
    expect(NoticeBoard.writers, {'manager'});
  });

  test(
    'W4-U02 every server role reads; an unknown role reads nothing (negative)',
    () async {
      final (e, ob) = await seeded();
      for (final r in [
        'manager',
        'teacher',
        'parent',
        'student',
        'counselor',
        'guard',
      ]) {
        expect(await board(e, ob, role: r).list(), hasLength(3), reason: r);
      }
      await expectLater(
        board(e, ob, role: 'janitor').list(),
        refused(NoticeError.notReader),
      );
    },
  );

  test(
    'W4-U03 newest first, same day → higher id first; deleted hidden',
    () async {
      final (e, ob) = await seeded();
      final l = await board(e, ob, role: 'teacher').list();
      expect(l.map((n) => n.id), [3, 2, 1]);
      expect(l[1].severity, NoticeSeverity.important);
      expect(l[1].version, 3);
      expect(l[0].severity, NoticeSeverity.normal, reason: 'unknown → normal');
      expect(l.every((n) => !n.queued), isTrue);
    },
  );

  test(
    'W4-U04 manager publish: web row, UTC day, trimmed, queued with base 0',
    () async {
      final (e, ob) = await seeded();
      final res = await board(e, ob).publish(
        title: '  امتحان ریاضی  ',
        body: '\nشنبه، ساعت ۸\n',
        severity: NoticeSeverity.important,
      );
      expect(res.action, NoticeAction.published);
      expect(res.messageFa, 'اطلاعیه منتشر شد');
      final op = ob.list().single;
      expect(op.collection, 'announcements');
      expect(op.type, 'put');
      expect(op.id, res.id);
      expect(op.baseVersion, 0);
      expect(op.payload, {
        'id': res.id,
        'title': 'امتحان ریاضی',
        'body': 'شنبه، ساعت ۸',
        'severity': 'important',
        'date': '2026-11-11',
        'author_id': 1,
      });
      final local = await e.get('announcements', res.id);
      expect(local!.data['title'], 'امتحان ریاضی');
      final l = await board(e, ob).list();
      expect(l.first.id, res.id, reason: 'newest first');
      expect(l.first.queued, isTrue);
    },
  );

  test('W4-U05 ids: inside [9e15, 2^53), distinct, a local collision is re-drawn', () async {
    final (e, ob) = await seeded();
    final b = board(e, ob);
    final ids = <int>{};
    for (var i = 0; i < 20; i++) {
      final r = await b.publish(title: 't$i', body: 'b');
      expect(r.id, greaterThanOrEqualTo(NoticeBoard.idBase));
      expect(r.id, lessThan(9007199254740992));
      ids.add(r.id);
    }
    expect(ids, hasLength(20));
    // force the first draw onto an existing id: (hi, lo) = (0, 5) → idBase + 5
    await e.put('announcements', NoticeBoard.idBase + 5, {
      'id': NoticeBoard.idBase + 5,
      'title': 'x',
      'body': 'y',
      'date': '2026-01-01',
    });
    final r = await board(
      e,
      ob,
      random: ScriptedRandom([0, 5]),
    ).publish(title: 'تازه', body: 'متن');
    expect(r.id, isNot(NoticeBoard.idBase + 5));
    expect(
      (await e.get('announcements', NoticeBoard.idBase + 5))!.data['title'],
      'x',
    );
  });

  test('W4-U06 non-managers cannot publish, edit or delete; nothing queued (negative)', () async {
    final (e, ob) = await seeded();
    for (final r in ['teacher', 'parent', 'student', 'counselor', 'guard']) {
      final b = board(e, ob, role: r, uid: 10);
      await expectLater(
        b.publish(title: 't', body: 'b'),
        refused(NoticeError.notAllowed),
      );
      await expectLater(
        b.edit(id: 1, title: 't', body: 'b', severity: NoticeSeverity.info),
        refused(NoticeError.notAllowed),
      );
      await expectLater(b.delete(1), refused(NoticeError.notAllowed));
    }
    expect(ob.list(), isEmpty);
    expect((await e.get('announcements', 1))!.data['title'], 'اردوی پاییزه');
  });

  test(
    'W4-U07 empty title or body is refused before any write (negative)',
    () async {
      final (e, ob) = await seeded();
      final b = board(e, ob);
      await expectLater(
        b.publish(title: '   ', body: 'متن'),
        refused(NoticeError.emptyTitle),
      );
      await expectLater(
        b.publish(title: 'عنوان', body: ' \n '),
        refused(NoticeError.emptyBody),
      );
      await expectLater(
        b.edit(id: 1, title: '', body: 'x', severity: NoticeSeverity.normal),
        refused(NoticeError.emptyTitle),
      );
      expect(ob.list(), isEmpty);
      expect(await e.count('announcements'), 4);
    },
  );

  test(
    'W4-U08 a notice above the Gateway op ceiling is refused (negative)',
    () async {
      final (e, ob) = await seeded();
      final big =
          'ا' *
          (NoticeBoard.maxOpBytes ~/ 2 + 10); // 2 bytes per letter in UTF-8
      await expectLater(
        board(e, ob).publish(title: 'بلند', body: big),
        refused(NoticeError.tooLarge),
      );
      await expectLater(
        board(
          e,
          ob,
        ).edit(id: 1, title: 'بلند', body: big, severity: NoticeSeverity.info),
        refused(NoticeError.tooLarge),
      );
      expect(ob.list(), isEmpty);
      // just under the ceiling is accepted
      final ok = 'a' * (NoticeBoard.maxOpBytes - 200);
      expect(
        (await board(e, ob).publish(title: 't', body: ok)).action,
        NoticeAction.published,
      );
    },
  );

  test('W4-U09 edit keeps date and other fields, author = editor, base = version + queued', () async {
    final (e, ob) = await seeded();
    final b = board(e, ob, uid: 7);
    final r = await b.edit(
      id: 2,
      title: 'تعطیلی رسمی',
      body: 'مدرسه شنبه تعطیل است',
      severity: NoticeSeverity.important,
    );
    expect(r.action, NoticeAction.edited);
    var op = ob.list().single;
    expect(op.baseVersion, 3);
    expect(op.payload, {
      'id': 2,
      'title': 'تعطیلی رسمی',
      'body': 'مدرسه شنبه تعطیل است',
      'severity': 'important',
      'date': '2026-11-09',
      'author_id': 7,
    });
    // a second edit before the first is sent builds on it (no self-conflict)
    await b.edit(
      id: 2,
      title: 'تعطیلی رسمی',
      body: 'شنبه و یکشنبه',
      severity: NoticeSeverity.important,
    );
    op = ob.list().last;
    expect(op.baseVersion, 4);
    // other stored fields survive (web Object.assign)
    await b.edit(
      id: 1,
      title: 'اردو',
      body: 'ثبت‌نام تا پنجشنبه',
      severity: NoticeSeverity.info,
    );
    expect(ob.list().last.payload!['school_id'], 1);
    expect(ob.list().last.payload!['date'], '2026-11-01');
  });

  test('W4-U10 an unchanged edit writes nothing', () async {
    final (e, ob) = await seeded();
    final r = await board(e, ob).edit(
      id: 1,
      title: ' اردوی پاییزه ',
      body: 'ثبت‌نام تا پنجشنبه',
      severity: NoticeSeverity.info,
    );
    expect(r.action, NoticeAction.unchanged);
    expect(r.key, isNull);
    expect(r.messageFa, 'تغییری نبود');
    expect(ob.list(), isEmpty);
    // a stored unknown severity saved as «normal» IS a change (the record becomes valid)
    final r2 = await board(e, ob).edit(
      id: 3,
      title: 'جلسهٔ اولیا',
      body: 'سه‌شنبه ساعت ۱۰',
      severity: NoticeSeverity.normal,
    );
    expect(r2.action, NoticeAction.edited);
    expect(ob.list().single.payload!['severity'], 'normal');
  });

  test(
    'W4-U11 edit or delete of a missing / deleted notice is refused (negative)',
    () async {
      final (e, ob) = await seeded();
      final b = board(e, ob);
      await expectLater(
        b.edit(id: 99, title: 't', body: 'b', severity: NoticeSeverity.normal),
        refused(NoticeError.unknownNotice),
      );
      await expectLater(
        b.edit(id: 4, title: 't', body: 'b', severity: NoticeSeverity.normal),
        refused(NoticeError.unknownNotice),
      );
      await expectLater(b.delete(99), refused(NoticeError.unknownNotice));
      expect(ob.list(), isEmpty);
    },
  );

  test(
    'W4-U12 delete: tombstone op with base version, local row gone',
    () async {
      final (e, ob) = await seeded();
      final r = await board(e, ob).delete(2);
      expect(r.action, NoticeAction.deleted);
      expect(r.messageFa, 'اطلاعیه حذف شد');
      final op = ob.list().single;
      expect(op.type, 'del');
      expect(op.id, 2);
      expect(op.baseVersion, 3);
      expect(op.payload, isNull);
      expect(await e.get('announcements', 2), isNull);
      expect((await board(e, ob).list()).map((n) => n.id), [3, 1]);
      // a notice published offline and deleted before sending: both ops stay in order
      final p = await board(e, ob).publish(title: 'موقت', body: 'x');
      await board(e, ob).delete(p.id);
      final ops = ob.list().where((o) => o.id == p.id).toList();
      expect(ops.map((o) => o.type), ['put', 'del']);
      expect(ops.last.baseVersion, 1);
    },
  );

  test('W4-U13 full queue: publish/edit/delete refused, nothing written (negative)', () async {
    final (e, ob) = await seeded(config: const OutboxConfig(capacity: 1));
    final b = board(e, ob);
    await b.publish(title: 'اول', body: 'x');
    for (final f in <Future<Object?> Function()>[
      () => b.publish(title: 'دوم', body: 'y'),
      () =>
          b.edit(id: 1, title: 'z', body: 'z', severity: NoticeSeverity.normal),
      () => b.delete(2),
    ]) {
      await expectLater(
        f(),
        throwsA(
          isA<SyncFailure>().having(
            (s) => s.code,
            'code',
            PayeshErrorCode.queueFull,
          ),
        ),
      );
    }
    expect(ob.list(), hasLength(1));
    expect(await e.count('announcements'), 5);
    expect((await e.get('announcements', 1))!.data['title'], 'اردوی پاییزه');
  });
}
