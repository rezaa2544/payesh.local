// Row 128 — the shared write path of the school-management waves (SchoolRecords), unit level:
// local SQLite + durable outbox, no network.
import 'dart:io';
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final String repoRoot =
    Platform.environment['PAYESH_REPO_ROOT'] ??
    Directory('../../../..').absolute.path;

SchoolRecords db(
  SqliteEngine e,
  SqliteOutbox ob, {
  String role = 'manager',
  int uid = 1,
}) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  random: Random(128),
);

/// server/policy.js COLLECTIONS → {name: (writers, readers|null)}.
Map<String, (Set<String>, Set<String>?)> policyJs() {
  final src = File('$repoRoot/server/policy.js').readAsStringSync();
  final block = src.substring(
    src.indexOf('const COLLECTIONS = {'),
    src.indexOf('};', src.indexOf('const COLLECTIONS = {')),
  );
  Set<String> roles(String list) => {
    for (final m in RegExp(r"'([a-z_]+)'").allMatches(list)) m.group(1)!,
  };
  return {
    for (final m in RegExp(
      r"^\s*([a-z_]+):\s*\{\s*write:\s*\[([^\]]*)\],\s*read:\s*(?:'all'|\[([^\]]*)\])",
      multiLine: true,
    ).allMatches(block))
      m.group(1)!: (
        roles(m.group(2)!),
        m.group(3) == null ? null : roles(m.group(3)!),
      ),
  };
}

void main() {
  test('R-01 role rules equal server/policy.js COLLECTIONS exactly', () {
    final js = policyJs();
    expect(js.length, greaterThan(20));
    expect(SchoolRecords.rules.keys.toSet(), js.keys.toSet());
    for (final MapEntry(:key, :value) in js.entries) {
      final r = SchoolRecords.rules[key]!;
      expect(r.writers, value.$1, reason: '$key writers');
      expect(r.readers, value.$2, reason: '$key readers');
    }
  });

  test('R-02 id ranges are disjoint, inside [1e15, 3e15) and below every older wave', () {
    final bases = SchoolRecords.idSlots.map(SchoolRecords.idBaseOf).toList();
    for (var i = 0; i < bases.length; i++) {
      expect(bases[i], greaterThanOrEqualTo(SchoolRecords.idFloor));
      expect(
        bases[i] + SchoolRecords.idSlotSpan,
        lessThanOrEqualTo(3000000000000000),
      );
      if (i > 0) expect(bases[i], bases[i - 1] + SchoolRecords.idSlotSpan);
    }
    expect(FamilyBook.idBase, greaterThanOrEqualTo(3000000000000000));
    expect(() => SchoolRecords.idBaseOf('grades'), throwsArgumentError);
  });

  test(
    'R-03 put queues the op BEFORE the local row; base = version + queued ops',
    () async {
      final e = SqliteEngine.inMemory();
      final ob = SqliteOutbox(e.database);
      final d = db(e, ob);
      final id = await d.newId('classes');
      expect(
        id ~/ SchoolRecords.idSlotSpan,
        SchoolRecords.idBaseOf('classes') ~/ SchoolRecords.idSlotSpan,
      );
      await d.put('classes', id, {'name': 'دهم'});
      var ops = ob.list();
      expect(ops.single.baseVersion, 0);
      expect(ops.single.payload!['name'], 'دهم');
      final prev = (await d.get('classes', id))!;
      await d.put('classes', id, {'name': 'دهم ب'}, prev: prev);
      ops = ob.list();
      expect(
        ops.last.baseVersion,
        1,
        reason: 'one op of the same row still queued',
      );
      await d.del('classes', (await d.get('classes', id))!);
      expect(ob.list().last.type, 'del');
      expect(ob.list().last.baseVersion, 2);
      expect(await d.get('classes', id), isNull);
    },
  );

  test(
    'R-04 role gates refuse before anything is written (negative)',
    () async {
      final e = SqliteEngine.inMemory();
      final ob = SqliteOutbox(e.database);
      for (final (role, col) in [
        ('teacher', 'classes'),
        ('parent', 'users'),
        ('student', 'schedule'),
        ('manager', 'conflicts'),
        ('hacker', 'announcements'),
      ]) {
        await expectLater(
          db(e, ob, role: role).put(col, 1, {'x': 1}),
          throwsA(
            isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
          ),
        );
      }
      expect(db(e, ob, role: 'teacher').canRead('app_settings'), isFalse);
      expect(db(e, ob, role: 'hacker').canRead('announcements'), isFalse);
      await expectLater(
        db(e, ob, role: 'teacher').all('import_issues'),
        throwsA(
          isA<RecordFailure>().having((f) => f.code, 'code', 'not_reader'),
        ),
      );
      expect(ob.list(), isEmpty);
      expect(await e.count('classes'), 0);
    },
  );

  test('R-05 an op over 64 KiB and a full queue are refused, nothing written (negative)', () async {
    final e = SqliteEngine.inMemory();
    final ob = SqliteOutbox(
      e.database,
      config: const OutboxConfig(capacity: 1),
    );
    final d = db(e, ob);
    await expectLater(
      d.put('lookups', 7, {'name': 'x' * (70 * 1024)}),
      throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'too_large')),
    );
    await d.put('lookups', 8, {'name': 'پایه'});
    await expectLater(
      d.put('lookups', 9, {'name': 'رشته'}),
      throwsA(
        isA<SyncFailure>().having(
          (s) => s.code,
          'code',
          PayeshErrorCode.queueFull,
        ),
      ),
    );
    expect(() => d.requireRoom(1), throwsA(isA<SyncFailure>()));
    expect(ob.list(), hasLength(1));
    expect(await e.get('lookups', 9), isNull);
  });

  test('R-06 digits and mobiles like the web client', () {
    expect(SchoolRecords.digitsOnly('۰۹۱۲ ۳۴۵-۶۷۸۹'), '09123456789');
    expect(SchoolRecords.digitsOnly('٠١٢'), '012');
    expect(SchoolRecords.mobile11('9123456789'), '09123456789');
    expect(SchoolRecords.mobile11('+98 912 345 6789'), '09123456789');
    expect(SchoolRecords.mobile11('00989123456789'), '09123456789');
    expect(SchoolRecords.mobile11('12345'), '12345');
  });

  test(
    'R-07 credentials and the row version are never sent back (negative)',
    () async {
      final e = SqliteEngine.inMemory();
      final ob = SqliteOutbox(e.database);
      // a manager device pulls users WITH the sealed password fields (server/sync.js, row 57)
      await e.put('users', 21, {
        'id': 21,
        'name': 'بهار',
        'password_hash': 'pbkdf2\$old',
        'phone_hash': 'x',
        'password_enc': 'sealed',
        '_version': 4,
      }, version: 4);
      final d = db(e, ob);
      final prev = (await d.get('users', 21))!;
      await d.put('users', 21, {
        ...prev.data,
        'name': 'بهار ب',
        'password': 'p',
      }, prev: prev);
      final sent = ob.list().single.payload!;
      expect(sent.keys.where(SchoolRecords.neverSent.contains), isEmpty);
      expect(sent['name'], 'بهار ب');
      expect(ob.list().single.baseVersion, 4);
    },
  );
}
