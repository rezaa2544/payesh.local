// ردیف ۱۷۹: «چه چیزهایی تازه است؟» — منطق نسخهٔ دیده‌شده، فیلتر پنل و پنجره.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_update/payesh_update.dart';

const _notes = [
  ReleaseNote('0.9.35', [NoteItem('همه: پنجرهٔ تازه‌ها')]),
  ReleaseNote('0.9.34', [
    NoteItem('همه: اعلان فوری'),
    NoteItem('فقط مالک: کارت پردازش', {NoteAudience.owner}),
  ]),
  ReleaseNote('0.9.33', [
    NoteItem('فقط مالک: کنترل پردازش', {NoteAudience.owner}),
  ]),
  ReleaseNote('0.9.10', [NoteItem('قدیمی')]),
];

final class _Mem {
  final Map<String, String> m = {};
  int writes = 0;
  late final store = WhatsNewStore(
    read: (k) async => m[k],
    write: (k, v) async {
      writes++;
      m[k] = v;
    },
  );
}

Widget _app(Widget child) => MaterialApp(
  theme: PayeshUi.light(),
  home: Directionality(textDirection: TextDirection.rtl, child: child),
);

void main() {
  test('WN-01 version compare', () {
    expect(compareVersions('0.9.35', '0.9.34'), greaterThan(0));
    expect(compareVersions('0.10.0', '0.9.99'), greaterThan(0));
    expect(compareVersions('1.0.0', '1.0'), 0);
  });

  test('WN-02 audience filter drops empty releases', () {
    final school = releaseNotesFor(NoteAudience.school, all: _notes);
    expect(school.map((r) => r.version), ['0.9.35', '0.9.34', '0.9.10']);
    expect(school[1].items.single.text, 'همه: اعلان فوری');
    final owner = releaseNotesFor(NoteAudience.owner, all: _notes);
    expect(owner.map((r) => r.version), [
      '0.9.35',
      '0.9.34',
      '0.9.33',
      '0.9.10',
    ]);
    expect(owner[1].items, hasLength(2));
  });

  test('WN-03 pending: missed releases, first run, up to date', () {
    List<String> p(String? seen, [NoteAudience a = NoteAudience.owner]) =>
        pendingReleaseNotes(
          a,
          seen,
          all: _notes,
        ).map((r) => r.version).toList();
    expect(p('0.9.32'), ['0.9.35', '0.9.34', '0.9.33']);
    expect(p('0.9.32', NoteAudience.school), ['0.9.35', '0.9.34']);
    expect(p(null), ['0.9.35']);
    expect(p('0.9.35'), isEmpty);
    expect(p('0.0.1'), hasLength(4)); // capped at 5, all here
  });

  test('WN-04 generated data: newest first, every release has text', () {
    expect(kReleaseNotes, isNotEmpty);
    for (var i = 1; i < kReleaseNotes.length; i++) {
      expect(
        compareVersions(kReleaseNotes[i - 1].version, kReleaseNotes[i].version),
        greaterThan(0),
      );
    }
    for (final r in kReleaseNotes) {
      expect(r.items, isNotEmpty);
      for (final n in r.items) {
        expect(n.text.trim(), isNotEmpty);
        expect(n.audience, isNotEmpty);
      }
    }
    expect(bundledRelease, kReleaseNotes.first.version);
  });

  testWidgets('WN-05 gate shows once after update, then never again', (
    t,
  ) async {
    final mem = _Mem()..m[WhatsNewStore.key] = '0.9.33';
    Widget gate() => _app(
      WhatsNewGate(
        store: mem.store,
        audience: NoteAudience.school,
        appVersion: '0.2.205',
        notes: _notes,
        delay: const Duration(milliseconds: 10),
        child: const Scaffold(body: Text('خانه')),
      ),
    );
    await t.pumpWidget(gate());
    await t.pump(const Duration(milliseconds: 20));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('whats-new-dialog')), findsOneWidget);
    expect(find.text('چه چیزهایی تازه است؟'), findsOneWidget);
    expect(find.textContaining('0.2.205'), findsOneWidget);
    expect(find.text('همه: پنجرهٔ تازه‌ها'), findsOneWidget);
    expect(find.text('همه: اعلان فوری'), findsOneWidget);
    expect(find.text('فقط مالک: کارت پردازش'), findsNothing);
    expect(mem.m[WhatsNewStore.key], '0.9.35');
    await t.tap(find.byKey(const Key('whats-new-ok')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('whats-new-dialog')), findsNothing);

    // second launch: nothing
    await t.pumpWidget(const SizedBox());
    await t.pumpWidget(gate());
    await t.pump(const Duration(milliseconds: 20));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('whats-new-dialog')), findsNothing);
    expect(mem.writes, 1);
  });

  testWidgets('WN-06 «همهٔ تغییرات نسخه‌ها» opens the history page', (t) async {
    final mem = _Mem();
    await t.pumpWidget(
      _app(
        WhatsNewGate(
          store: mem.store,
          audience: NoteAudience.owner,
          notes: _notes,
          delay: const Duration(milliseconds: 10),
          child: const Scaffold(body: Text('خانه')),
        ),
      ),
    );
    await t.pump(const Duration(milliseconds: 20));
    await t.pumpAndSettle();
    // first run with the feature: only the newest release
    expect(find.text('همه: پنجرهٔ تازه‌ها'), findsOneWidget);
    expect(find.text('همه: اعلان فوری'), findsNothing);
    await t.tap(find.byKey(const Key('whats-new-all')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('release-history')), findsOneWidget);
    expect(find.text('فقط مالک: کنترل پردازش'), findsOneWidget);
    expect(find.text('نسخهٔ 0.9.10'), findsOneWidget);
  });

  testWidgets('WN-07 no store ⇒ no dialog (tests, local builds)', (t) async {
    await t.pumpWidget(
      _app(
        const WhatsNewGate(
          store: null,
          audience: NoteAudience.school,
          delay: Duration(milliseconds: 10),
          child: Scaffold(body: Text('خانه')),
        ),
      ),
    );
    await t.pump(const Duration(milliseconds: 50));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('whats-new-dialog')), findsNothing);
  });
}
