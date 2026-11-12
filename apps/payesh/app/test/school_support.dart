// Shared harness of the row-128 widget tests (waves W6..W12): a signed-in session without any
// network, the REAL app shell, the REAL pages/controllers and the REAL SchoolRecords books on
// an in-memory SQLite + durable outbox.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/school/school_source.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

const secret32 = 'QRSTUVWXYZ234567ABCDEFGHIJKLMNOP';
final today = DateTime.utc(2026, 11, 12, 8);

final class FakeAccess implements SchoolAccessApi {
  FakeAccess(this.refreshes);
  final List<Object> refreshes;

  static SchoolSession session(String role, {int uid = 10}) => SchoolSession(
    school: 'alborz-12',
    tenantId: 't-1',
    token: 'tok-$uid',
    expiresAt: DateTime.utc(2030),
    role: role,
    uid: uid,
  );

  @override
  Future<SchoolRoute> resolve(String schoolCode) =>
      Future.error(StateError('unexpected resolve'));

  @override
  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  }) => Future.error(StateError('unexpected activate'));

  @override
  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  }) {
    if (refreshes.isEmpty) {
      return Future.error(const SchoolAccessFailure(SchoolAccessError.offline));
    }
    final v = refreshes.removeAt(0);
    return v is SchoolSession ? Future.value(v) : Future.error(v);
  }
}

/// In-memory school database with the real books.
final class MemorySchool implements SchoolSource {
  MemorySchool({OutboxConfig config = const OutboxConfig()})
    : engine = SqliteEngine.inMemory() {
    outbox = SqliteOutbox(engine.database, config: config);
  }
  final SqliteEngine engine;
  late final SqliteOutbox outbox;
  final ValueNotifier<int> bump = ValueNotifier(0);
  int nudges = 0;

  @override
  Future<SchoolRecords?> recordsFor({
    required String role,
    required int uid,
  }) async => SchoolRecords(
    engine: engine,
    outbox: outbox,
    role: role,
    uid: uid,
    now: () => today,
  );

  @override
  void queued() => nudges++;

  @override
  Listenable get changed => bump;

  /// W7: the school server's credential endpoints (null = not on a school server).
  @override
  AccountsApi? accounts;

  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      engine.put(c, id, {...d, 'id': id}, version: v);
}

Future<FakeSecureStore> savedSchool({
  required String role,
  int uid = 10,
}) async {
  final store = FakeSecureStore();
  await SchoolAccountStore(store).save(
    SavedSchool(
      school: 'alborz-12',
      cellUrl: Uri.parse('https://cell-1.example.ir'),
      deviceSecret: secret32,
      role: role,
      uid: uid,
    ),
  );
  return store;
}

/// Signs in as [role] (uid 10), seeds the database and shows the signed-in home.
Future<(SessionController, MemorySchool)> bootSchool(
  WidgetTester tester, {
  required String role,
  required Future<void> Function(MemorySchool s) seed,
  String school = 'users,accounts,classes,schedule,followup,reports,server',
  MemorySchool? source,
  bool wire = true,
}) async {
  final src = source ?? MemorySchool();
  await tester.runAsync(() => seed(src));
  final c = SessionController(
    api: FakeAccess([FakeAccess.session(role)]),
    accounts: SchoolAccountStore(await savedSchool(role: role)),
    flags: ClientFlags.parse(school: school),
    now: () => today,
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(session: c, school: wire ? src : null, today: () => today),
  );
  await c.start();
  await tester.pumpAndSettle();
  return (c, src);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}

/// Brings [key] into view, scrolling the page's list when the item is not built yet (lazy lists).
Future<void> reveal(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  if (f.evaluate().isEmpty) {
    // the page's own list (text fields have Scrollables of their own)
    final list = find
        .descendant(
          of: find.byType(ListView).last,
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(f, 200, scrollable: list);
  }
  await tester.ensureVisible(f);
}

Future<void> tapKey(WidgetTester tester, String key) async {
  await reveal(tester, key);
  await tester.tap(find.byKey(Key(key)));
  await settle(tester);
}

Future<void> typeKey(WidgetTester tester, String key, String text) async {
  await reveal(tester, key);
  await tester.enterText(find.byKey(Key(key)), text);
  await tester.pump();
}

Future<void> submitKey(WidgetTester tester, String key, String text) async {
  await typeKey(tester, key, text);
  await tester.testTextInput.receiveAction(TextInputAction.done);
  await settle(tester);
}

String textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

String badgeOf(WidgetTester tester, String key) => tester
    .widget<Text>(
      find.descendant(of: find.byKey(Key(key)), matching: find.byType(Text)),
    )
    .data!;

/// W7: the school server's credential endpoints, scripted. [online] false = unreachable.
final class FakeAccounts implements AccountsApi {
  FakeAccounts(this.creds);
  final Map<int, AccountCredential> creds;
  bool online = true;
  String ownPassword = 'old-pass';
  final calls = <String>[];

  void _up() {
    if (!online) throw const AccountFailure(AccountError.offline);
  }

  @override
  Future<List<AccountCredential>> credentials() async {
    calls.add('creds');
    _up();
    return creds.values.toList();
  }

  @override
  Future<String?> setCredentials(
    int id, {
    String? phone,
    String? password,
  }) async {
    calls.add('set:$id:${phone ?? '-'}:${password ?? '-'}');
    _up();
    if (password != null) AccountRules.checkPassword(password);
    final c = creds[id];
    if (c == null) throw const AccountFailure(AccountError.notFound);
    creds[id] = AccountCredential(
      id: id,
      name: c.name,
      role: c.role,
      username: phone ?? c.username,
      password: password ?? c.password,
    );
    return password;
  }

  @override
  Future<String> autoPassword(int id) async {
    calls.add('auto:$id');
    _up();
    final c = creds[id];
    if (c == null) throw const AccountFailure(AccountError.notFound);
    if (c.username.isEmpty) throw const AccountFailure(AccountError.noLogin);
    const nid = '0012345678';
    creds[id] = AccountCredential(
      id: id,
      name: c.name,
      role: c.role,
      username: c.username,
      password: nid,
    );
    return nid;
  }

  @override
  Future<void> changeOwnPassword({
    required String current,
    required String next,
  }) async {
    calls.add('own:$current:$next');
    _up();
    AccountRules.checkPassword(next);
    if (current != ownPassword) {
      throw const AccountFailure(AccountError.wrongCurrent);
    }
    ownPassword = next;
  }
}
