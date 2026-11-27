// Row 128, wave W12 — the system page (status, connection diagnosis, mirror + backups,
// restore, devices, school settings, audit), the cloud page and data health. Widget tests
// drive the REAL app shell, pages and controllers; the school server is scripted here
// (FakeAdmin) and exercised for real in packages/payesh_sync/test/school_admin_it_test.dart
// W12-IT-*. Data health runs the real DataHealth on the in-memory SQLite + outbox.
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/system/school_profile_screen.dart';
import 'package:payesh_app/src/system/system_screen.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart' show schoolProfileErrorsFa;

import 'nav_support.dart';
import 'school_support.dart';

/// The school server's management endpoints, scripted. [online] false = unreachable.
final class FakeAdmin implements ServerAdminApi {
  bool online = true;
  bool forbidden = false;
  final calls = <String>[];
  String school = 'هنرستان نمونه';
  CloudConfig cloudCfg = CloudConfig.fromJson(const {
    'config': {
      'endpoint': 'https://s3.ir-central1.arvanstorage.ir',
      'bucket': 'payesh-1',
      'has_access_key': true,
      'has_secret': true,
      'configured': true,
      'built_in': true,
    },
  });
  final devs = <DeviceInfo>[
    const DeviceInfo(
      id: 'abc1',
      userName: '—',
      userId: 10,
      role: 'manager',
      name: 'لپ‌تاپ دفتر',
      platform: 'windows',
      revoked: false,
    ),
    const DeviceInfo(
      id: 'abc2',
      userName: 'دبیر',
      role: 'teacher',
      name: 'گوشی',
      platform: 'android',
      revoked: true,
    ),
  ];
  Map<String, Object?>? restored;
  CloudForm? saved;

  Future<void> _gate(String name) async {
    calls.add(name);
    if (!online) throw const AdminFailure(AdminError.offline);
    if (forbidden) throw const AdminFailure(AdminError.notManager);
  }

  @override
  Uri get server => Uri.parse('http://192.168.1.5:8080');

  @override
  Future<ServerHealth> health() async {
    await _gate('health');
    return ServerHealth(
      version: '0.9.2',
      school: school,
      uptimeSeconds: 60,
      cloudReady: true,
    );
  }

  @override
  Future<String> backupNow() async {
    await _gate('backup');
    return 'payesh-2026-11-12-0800.sqlite';
  }

  @override
  Future<List<String>> backups() async {
    await _gate('backups');
    return ['payesh-2026-11-12-0800.sqlite', 'payesh-2026-11-12-0700.sqlite'];
  }

  MirrorState _mirror(bool ok) => MirrorState.fromJson({
    'mirror': {
      'ok': ok,
      'at': '2026-11-12T08:00:00Z',
      'total': 120,
      'diffs': ok
          ? const <Map<String, Object?>>[]
          : <Map<String, Object?>>[
              {'collection': 'users', 'db': 10, 'mirror': 9},
            ],
    },
    'daily': [
      {'file': 'payesh-2026-11-12.json', 'total': 120, 'size': 4096},
    ],
  });

  @override
  Future<MirrorState> mirror() async {
    await _gate('mirror');
    return _mirror(false);
  }

  @override
  Future<MirrorState> mirrorRefresh() async {
    await _gate('mirror-refresh');
    return _mirror(true);
  }

  @override
  Future<RestoreReport> restore(Map<String, Object?> data) async {
    await _gate('restore');
    restored = data;
    return const RestoreReport(7, 'safety-1.sqlite');
  }

  @override
  Future<List<DeviceInfo>> devices() async {
    await _gate('devices');
    return List.of(devs);
  }

  @override
  Future<void> revokeDevice(String id) async {
    await _gate('revoke $id');
    final i = devs.indexWhere((d) => d.id == id);
    final d = devs[i];
    devs[i] = DeviceInfo(
      id: d.id,
      userName: d.userName,
      userId: d.userId,
      role: d.role,
      name: d.name,
      platform: d.platform,
      revoked: true,
    );
  }

  @override
  Future<List<AuditEntry>> audit({int limit = 60}) async {
    await _gate('audit');
    return const [
      AuditEntry('2026-11-12T07:00:00Z', '10', 'device_revoke', 'devices'),
    ];
  }

  @override
  Future<void> saveSettings({required String name}) async {
    await _gate('settings');
    school = name;
  }

  /// Row 150: «مشخصات مدرسه» on the school server.
  Map<String, Object?> profile = {
    'name': 'هنرستان نمونه',
    'code': '1234',
    'province': 'خراسان رضوی',
    'county': 'نیشابور',
    'district': '',
    'level': '',
    'gender': '',
    'school_type': 'governmental',
    'capacity': 300,
    'work_days': [0, 1, 2, 3, 4],
    'excuse_window_minutes': 15,
    'complete': false,
  };
  Map<String, Object?>? savedProfile;

  @override
  Future<Map<String, Object?>> schoolProfile() async {
    await _gate('profile');
    return profile;
  }

  @override
  Future<Map<String, Object?>> saveSchoolProfile(Map<String, Object?> p) async {
    await _gate('profile-save');
    savedProfile = p;
    return profile = {...profile, ...p, 'complete': true};
  }

  @override
  Future<CloudConfig> cloud() async {
    await _gate('cloud');
    return cloudCfg;
  }

  @override
  Future<bool> cloudSave(CloudForm form) async {
    await _gate('cloud-save');
    saved = form;
    cloudCfg = CloudConfig.fromJson({
      'config': {
        'endpoint': form.endpoint,
        'bucket': form.bucket,
        'accessKey': '${form.accessKey.substring(0, 4)}…',
        'has_access_key': true,
        'has_secret': true,
        'configured': true,
        'built_in': false,
      },
    });
    return true;
  }

  @override
  Future<CloudOutcome> cloudTest() async {
    await _gate('cloud-test');
    return CloudOutcome.test(const {
      'ok': true,
      'ms': 40,
      'steps': [
        {'name': 'دیدن صندوقچه', 'ok': true, 'note': 'خالی'},
        {'name': 'نوشتن', 'ok': true, 'ms': 12},
      ],
    });
  }

  @override
  Future<CloudOutcome> cloudCors() async {
    await _gate('cloud-cors');
    return CloudOutcome.cors(const {
      'ok': true,
      'origins': ['*'],
    });
  }

  @override
  Future<String> cloudReset() async {
    await _gate('cloud-reset');
    cloudCfg = CloudConfig.fromJson(const {
      'config': {
        'endpoint': 'https://s3.ir-central1.arvanstorage.ir',
        'bucket': 'payesh-1',
        'configured': true,
        'has_access_key': true,
        'built_in': true,
      },
    });
    return 'payesh-1';
  }

  @override
  Future<CloudOutcome> phoneCheck() async {
    await _gate('phone-check');
    return CloudOutcome.phone(const {
      'ok': false,
      'steps': [
        {'step': 'bucket', 'ok': true},
        {'step': 'set_cors', 'ok': false, 'status': 403, 'error': 'denied'},
      ],
    });
  }

  // Row 172: web `PAGES.network` (the «شبکه» page).
  String publicUrl = '';
  bool reachable = false;
  bool tsInstalled = true;
  bool tsLoggedIn = true;
  int pending = 0;
  TunnelOutcome enableResult = const TunnelOutcome(
    ok: true,
    url: 'https://payesh.school.ts.net',
  );

  PublicAccess get _public => PublicAccess(
    publicUrl: publicUrl,
    installed: tsInstalled,
    loggedIn: tsLoggedIn,
  );

  @override
  Future<NetworkState> network({bool force = false}) async {
    await _gate(force ? 'network-force' : 'network');
    return NetworkState(
      publicUrl: publicUrl,
      lanUrls: const ['http://192.168.1.5:8080'],
      probe: TunnelProbe(
        configured: publicUrl.isNotEmpty,
        reachable: publicUrl.isNotEmpty && reachable,
        latencyMs: reachable ? 120 : null,
        sameServer: reachable ? true : null,
        error: reachable ? '' : 'timeout',
      ),
      public: _public,
    );
  }

  @override
  Future<void> saveNetwork(String url) async {
    await _gate('network-save');
    if (url.isNotEmpty && !url.startsWith('https://')) {
      throw const AdminFailure(
        AdminError.unknown,
        'آدرس باید با https:// شروع شود',
      );
    }
    publicUrl = url;
  }

  @override
  Future<PublicAccess> tunnel() async {
    await _gate('tunnel');
    return _public;
  }

  @override
  Future<TunnelOutcome> tunnelAction(String action) async {
    await _gate('tunnel-$action');
    if (action == 'enable' && enableResult.ok) {
      publicUrl = enableResult.url;
      reachable = true;
    }
    if (action == 'off') {
      publicUrl = '';
      reachable = false;
    }
    return action == 'enable' ? enableResult : const TunnelOutcome(ok: true);
  }

  @override
  Future<int> outboxCheck({bool drain = false}) async {
    await _gate(drain ? 'outbox-drain' : 'outbox');
    if (drain) pending = 0;
    return pending;
  }
}

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان نمونه'});
  await s.put('users', 10, {
    'name': 'مدیر',
    'role': 'manager',
    'phone': '09120000128',
  });
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'دهم '});
  await s.put('classes', 5, {'name': 'دهم شبکه', 'grade': 'دهم'});
  await s.put('users', 20, {
    'name': 'علی رضایی',
    'role': 'student',
    'class_id': 5,
    'national_id': '0012345678',
    'phone': '09120000001',
  });
  await s.put('users', 21, {
    'name': 'علي رضايي',
    'role': 'student',
    'class_id': 5,
    'national_id': '0012345678',
    'birth_date': '1390/01/01',
  });
  await s.put('grades', 60, {'student_id': 21, 'subject_id': 1, 'score': 15});
  await s.put('users', 30, {'name': 'ولی', 'role': 'parent'});
  await s.put('parent_links', 41, {'parent_id': 30, 'student_id': 777});
}

Future<(MemorySchool, FakeAdmin)> open(
  WidgetTester tester,
  String page, {
  String role = 'manager',
  bool server = true,
  FakeAdmin? admin,
}) async {
  final src = MemorySchool();
  admin ??= FakeAdmin();
  if (page == 'system' || page == 'health' || page == 'network') {
    // Row 172: the web-layout system page is one long list of cards — a tall window keeps
    // every card built, as on the web page.
    tester.view.physicalSize = const Size(2400, 24000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
  }
  if (server) src.admin = admin;
  await bootSchool(
    tester,
    role: role,
    source: src,
    seed: (s) async {
      await seed(s);
      if (role != 'manager') {
        await s.put('users', 10, {'name': 'دبیر', 'role': role});
      }
    },
  );
  await openPage(tester, page);
  return (src, admin);
}

void main() {
  testWidgets(
    'W12-W01 system page: status, sync now, connection diagnosis; a teacher sees '
    'only that; NEG no server-management section for a teacher',
    (tester) async {
      final (src, _) = await open(tester, 'system', role: 'teacher');
      expect(textOf(tester, 'sys-user'), 'کاربر: دبیر · نقش: دبیر');
      expect(badgeOf(tester, 'sys-state'), 'متصل');
      await tapKey(tester, 'sys-sync');
      expect(src.nudges, 1);
      expect(await noticeOf(tester, 'sys-notice'), 'همگام‌سازی درخواست شد');
      await tapKey(tester, 'sys-diagnose');
      expect(
        textOf(tester, 'sys-diag-0'),
        startsWith('✅ نشانی سرور مدرسه شناخته شده است'),
      );
      expect(textOf(tester, 'sys-diag-1'), contains('سرور مدرسه جواب می‌دهد'));
      expect(
        textOf(tester, 'sys-diag-4'),
        '✅ همهٔ تغییرات این دستگاه رسیده است',
      );
      expect(find.byKey(const Key('sys-backup-now')), findsNothing);
      expect(navOf('health'), findsNothing);
    },
  );

  testWidgets(
    'W12-W02 manager: mirror refresh, backup now + list, restore a backup file '
    '(asks first); NEG a file that is not a Payesh backup, an empty path',
    (tester) async {
      final read = SystemController.readFile;
      addTearDown(() => SystemController.readFile = read);
      final files = <String, String>{
        '/b/ok.json': '{"format":"payesh-backup","collections":{"users":[]}}',
        '/b/bad.json': '{"format":"other"}',
      };
      SystemController.readFile = (p) async =>
          Uint8List.fromList(utf8.encode(files[p]!));
      final (src, admin) = await open(tester, 'system');
      await reveal(tester, 'sys-mirror-state');
      expect(badgeOf(tester, 'sys-mirror-state'), 'بررسی نشده');
      await tapKey(tester, 'sys-mirror-refresh');
      expect(
        await noticeOf(tester, 'sys-notice'),
        'آینه به‌روز شد · ۱۲۰ رکورد — با دیتابیس یکی است ✅',
      );
      expect(badgeOf(tester, 'sys-mirror-state'), 'آینه با دیتابیس یکی است');
      expect(textOf(tester, 'sys-mirror-daily'), 'روزهای پشتیبان: ۱ فایل');
      // Row 172: the web table — روز · رکورد · حجم
      expect(textOf(tester, 'sys-daily-2026-11-12'), '2026-11-12');
      expect(find.text('۴ کیلوبایت'), findsOneWidget);
      await tapKey(tester, 'sys-restore');
      expect(
        await noticeOf(tester, 'sys-error'),
        'اول فایل پشتیبان (.json) را انتخاب کنید',
      );
      await typeKey(tester, 'sys-restore-path', '/b/bad.json');
      await tapKey(tester, 'sys-restore');
      await tapKey(tester, 'sys-confirm-ok');
      expect(
        await noticeOf(tester, 'sys-error'),
        'این فایل، فایل پشتیبان پایش نیست',
      );
      expect(admin.restored, isNull);
      await typeKey(tester, 'sys-restore-path', '/b/ok.json');
      await tapKey(tester, 'sys-restore');
      await tapKey(tester, 'sys-confirm-cancel');
      expect(admin.restored, isNull);
      await tapKey(tester, 'sys-restore');
      await tapKey(tester, 'sys-confirm-ok');
      expect(
        await noticeOf(tester, 'sys-notice'),
        'بازیابی انجام شد · 7 رکورد · نسخهٔ ایمنی: safety-1.sqlite',
      );
      expect(admin.restored!['format'], 'payesh-backup');
      expect(src.nudges, 1, reason: 'a pull follows the restore');
      await tapKey(tester, 'sys-backup-now');
      expect(
        await noticeOf(tester, 'sys-notice'),
        'پشتیبان ساخته شد: payesh-2026-11-12-0800.sqlite',
      );
      await tapKey(tester, 'sys-backup-list');
      expect(find.text('payesh-2026-11-12-0700.sqlite'), findsOneWidget);
    },
  );

  testWidgets(
    'W12-W03 devices (revoke asks first, owner name from the local copy), school '
    'name saved, stats + audit; NEG without the school server nothing is half-done',
    (tester) async {
      final (_, admin) = await open(tester, 'system');
      await reveal(tester, 'sys-stats-text');
      expect(
        textOf(tester, 'sys-stats-text'),
        // row 204: the fixture reads as field-based — active students, venues, پایه و رشته
        'کاربران: ۴ (دانش‌آموز فعال: ۲) · محل برگزاری: ۰ · پایه و رشته: ۱ · حضور: ۰ · نمره: ۱',
      );
      await tapKey(tester, 'sys-devices');
      expect(find.text('مدیر · مدیر'), findsOneWidget);
      expect(find.byKey(const Key('sys-revoke-abc2')), findsNothing);
      await tapKey(tester, 'sys-revoke-abc1');
      await tapKey(tester, 'sys-confirm-cancel');
      expect(admin.calls, isNot(contains('revoke abc1')));
      await tapKey(tester, 'sys-revoke-abc1');
      await tapKey(tester, 'sys-confirm-ok');
      expect(admin.calls, contains('revoke abc1'));
      expect(await noticeOf(tester, 'sys-notice'), 'دستگاه باطل شد');
      expect(find.byKey(const Key('sys-revoke-abc1')), findsNothing);
      await typeKey(tester, 'sys-name', 'هنرستان تازه');
      await tapKey(tester, 'sys-settings-save');
      expect(await noticeOf(tester, 'sys-notice'), 'ذخیره شد');
      expect(admin.school, 'هنرستان تازه');
      await typeKey(tester, 'sys-name', '  ');
      await tapKey(tester, 'sys-settings-save');
      expect(await noticeOf(tester, 'sys-error'), 'نام مدرسه را بنویسید');
      await tapKey(tester, 'sys-audit');
      expect(textOf(tester, 'sys-audit-0'), contains('device_revoke'));
      admin.online = false;
      // back to the top of the page (the backup card was scrolled away)
      await tester.drag(find.byType(ListView).last, const Offset(0, 4000));
      await tester.pumpAndSettle();
      await tapKey(tester, 'sys-backup-now');
      expect(
        await noticeOf(tester, 'sys-error'),
        'این کار روی سرور مدرسه انجام می‌شود — اتصال را بررسی کنید و دوباره بزنید',
      );
      admin
        ..online = true
        ..forbidden = true;
      await tapKey(tester, 'sys-devices');
      expect(await noticeOf(tester, 'sys-error'), 'این کار فقط برای مدیر است');
      await tester.pumpWidget(const SizedBox());
      await open(tester, 'system', server: false);
      expect(find.byKey(const Key('sys-no-server')), findsOneWidget);
      await tapKey(tester, 'sys-diagnose');
      expect(
        textOf(tester, 'sys-diag-0'),
        startsWith('❌ نشانی سرور مدرسه روی این دستگاه نیست'),
      );
      await tapKey(tester, 'sys-mirror-refresh');
      expect(
        await noticeOf(tester, 'sys-error'),
        startsWith('این کار روی سرور مدرسه انجام می‌شود'),
      );
    },
  );

  testWidgets(
    'W12-W04 cloud: state, test and CORS steps, edit + save (key write-only, CORS '
    'set too), reset to default, phone check; NEG no school server',
    (tester) async {
      final (_, admin) = await open(tester, 'cloud');
      expect(badgeOf(tester, 'cld-state'), 'آماده');
      expect(find.byKey(const Key('cld-builtin')), findsOneWidget);
      expect(find.byKey(const Key('cld-reset')), findsNothing);
      await tapKey(tester, 'cld-test');
      expect(badgeOf(tester, 'cld-out-head'), 'حافظهٔ ابری سالم است');
      expect(textOf(tester, 'cld-out-step-1'), '✅ نوشتن · ۱۲ms');
      await tapKey(tester, 'cld-cors');
      expect(badgeOf(tester, 'cld-out-head'), 'CORS تنظیم شد');
      await tapKey(tester, 'cld-edit');
      await typeKey(tester, 'cld-endpoint', 'https://s3.example.ir');
      await typeKey(tester, 'cld-bucket', 'school-b');
      await typeKey(tester, 'cld-access', 'AKNEWKEY');
      await typeKey(tester, 'cld-secret', 'top-secret');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await tapKey(tester, 'cld-save');
      expect(
        await noticeOf(tester, 'cld-notice'),
        'ذخیره شد · CORS هم خودکار تنظیم شد',
      );
      expect(admin.saved!.secret, 'top-secret');
      expect(find.byKey(const Key('cld-form')), findsNothing);
      expect(find.textContaining('top-secret'), findsNothing);
      expect(
        textOf(tester, 'cld-manual'),
        startsWith('تنظیمات دستی روی این دستگاه فعال است'),
      );
      await tapKey(tester, 'cld-reset');
      expect(
        await noticeOf(tester, 'cld-notice'),
        'به پیش‌فرض برنامه برگشت (صندوقچه: payesh-1)',
      );
      await tapKey(tester, 'cld-phone');
      expect(
        await noticeOf(tester, 'cld-notice'),
        'هنوز کامل نشد — پایین را ببینید',
      );
      await reveal(tester, 'cld-phone-step-1');
      expect(badgeOf(tester, 'cld-phone-head'), 'هنوز نشده');
      expect(
        textOf(tester, 'cld-phone-step-1'),
        '❌ گذاشتن اجازهٔ خواندن — کد 403 — denied',
      );
      await tester.pumpWidget(const SizedBox());
      await open(tester, 'cloud', server: false);
      expect(
        textOf(tester, 'cld-none'),
        startsWith('این تنظیمات روی سرور مدرسه است'),
      );
      expect(find.byKey(const Key('cld-test')), findsNothing);
    },
  );

  testWidgets(
    'W12-W04b cloud set by the owner panel: says so, shows bucket, no manual/built-in text',
    (tester) async {
      final admin = FakeAdmin()
        ..cloudCfg = CloudConfig.fromJson(const {
          'config': {
            'endpoint': 'https://s3.ir-central1.arvanstorage.ir',
            'bucket': 'payesh-madrese',
            'has_access_key': true,
            'has_secret': true,
            'configured': true,
            'built_in': false,
            'source': 'owner',
          },
        });
      await open(tester, 'cloud', admin: admin);
      expect(badgeOf(tester, 'cld-state'), 'آماده');
      expect(textOf(tester, 'cld-owner'), contains('پنل مدیریت'));
      expect(textOf(tester, 'cld-owner'), contains('payesh-madrese'));
      expect(find.byKey(const Key('cld-manual')), findsNothing);
      expect(find.byKey(const Key('cld-builtin')), findsNothing);
    },
  );

  testWidgets(
    'W12-W04c network = web PAGES.network: address card, tunnel card, LAN card, outbox; '
    'save (NEG http), enable the tunnel, turn it off (asks), outbox check',
    (tester) async {
      final opened = <String>[];
      final was = NetworkScreen.open;
      NetworkScreen.open = (u) async {
        opened.add(u);
        return true;
      };
      addTearDown(() => NetworkScreen.open = was);
      final admin = FakeAdmin()..pending = 2;
      await open(tester, 'network', admin: admin);
      expect(find.text('شبکه و دسترسی'), findsWidgets);
      expect(badgeOf(tester, 'net-url-state'), 'تنظیم نشده');
      expect(find.byKey(const Key('net-qr-card')), findsNothing);
      expect(badgeOf(tester, 'net-public-state'), 'خاموش');
      expect(textOf(tester, 'net-lan-0'), 'http://192.168.1.5:8080');
      expect(find.byKey(const Key('net-lan-qr')), findsOneWidget);
      expect(badgeOf(tester, 'net-outbox-state'), 'در انتظار اعمال');
      // NEG: the server only takes https
      await tester.enterText(find.byKey(const Key('net-url')), 'http://x.ir');
      await tapKey(tester, 'net-url-save');
      expect(textOf(tester, 'net-error'), contains('https://'));
      expect(admin.publicUrl, '');
      await tester.enterText(
        find.byKey(const Key('net-url')),
        'https://payesh.school.ir',
      );
      await tapKey(tester, 'net-url-save');
      expect(textOf(tester, 'net-notice'), 'ذخیره شد');
      expect(admin.publicUrl, 'https://payesh.school.ir');
      expect(badgeOf(tester, 'net-url-state'), 'در دسترس نیست');
      expect(textOf(tester, 'net-url-fail'), contains('timeout'));
      expect(find.byKey(const Key('net-pub-qr')), findsOneWidget);
      await tapKey(tester, 'net-pub-open');
      expect(opened, ['https://payesh.school.ir']);
      expect(badgeOf(tester, 'net-public-state'), 'فعال — دستی');
      // turn it off: asks first; cancel keeps it
      await tapKey(tester, 'net-tunnel-off');
      await tapKey(tester, 'net-off-confirm-cancel');
      expect(admin.publicUrl, 'https://payesh.school.ir');
      await tapKey(tester, 'net-tunnel-off');
      await tapKey(tester, 'net-off-confirm-ok');
      expect(textOf(tester, 'net-notice'), 'دسترسی اینترنتی قطع شد');
      expect(badgeOf(tester, 'net-url-state'), 'تنظیم نشده');
      // enable the tunnel (Tailscale installed and signed in)
      await tapKey(tester, 'net-tunnel-enable');
      expect(
        textOf(tester, 'net-notice'),
        'آدرس عمومی فعال شد: https://payesh.school.ts.net',
      );
      expect(badgeOf(tester, 'net-url-state'), 'در دسترس از اینترنت');
      expect(textOf(tester, 'net-url-checked'), 'آخرین بررسی: ۱۲۰ میلی‌ثانیه');
      expect(badgeOf(tester, 'net-public-state'), 'فعال — Tailscale');
      expect(textOf(tester, 'net-public-url'), 'https://payesh.school.ts.net');
      await tapKey(tester, 'net-outbox-sync');
      expect(textOf(tester, 'net-notice'), 'همه‌چیز اعمال شده است');
      expect(badgeOf(tester, 'net-outbox-state'), 'خالی');
      expect(admin.calls, contains('outbox-drain'));
    },
  );

  testWidgets('W12-W04d network: Tailscale missing → install steps; enable fails with the server reason; '
      'NEG offline → calm empty card, no dead buttons', (tester) async {
    final admin = FakeAdmin()..tsInstalled = false;
    await open(tester, 'network', admin: admin);
    expect(badgeOf(tester, 'net-public-state'), 'ابزاری نصب نیست');
    expect(find.byKey(const Key('net-ts-step-1')), findsOneWidget);
    expect(find.byKey(const Key('net-tunnel-login')), findsOneWidget);
    expect(find.byKey(const Key('net-tunnel-enable')), findsNothing);
    admin
      ..tsInstalled = true
      ..tsLoggedIn = false;
    await tapKey(tester, 'net-refresh');
    expect(badgeOf(tester, 'net-public-state'), 'Tailscale نصب است، وارد نشده');
    admin.tsLoggedIn = true;
    await tapKey(tester, 'net-refresh');
    admin.enableResult = const TunnelOutcome(
      ok: false,
      error: 'tailscale_not_logged_in',
    );
    await tapKey(tester, 'net-tunnel-enable');
    expect(textOf(tester, 'net-error'), contains('اول وارد Tailscale شوید'));
    await tester.pumpWidget(const SizedBox());
    await open(tester, 'network', admin: FakeAdmin()..online = false);
    expect(find.byKey(const Key('cld-none')), findsOneWidget);
    expect(find.byKey(const Key('net-url-card')), findsNothing);
    expect(find.byKey(const Key('cld-retry')), findsOneWidget);
  });

  testWidgets(
    'W12-W05 data health: findings by severity, safe fix (asks first) queued, '
    'details, merge two accounts into one; rerun',
    (tester) async {
      final (src, _) = await open(tester, 'health');
      expect(textOf(tester, 'hlt-summary-text'), contains('بحرانی'));
      expect(badgeOf(tester, 'hlt-count-dup-nid'), '۱');
      expect(badgeOf(tester, 'hlt-count-orphan-link'), '۱');
      expect(find.byKey(const Key('hlt-fix-dup-nid')), findsNothing);
      await tapKey(tester, 'hlt-fix-orphan-link');
      await tapKey(tester, 'hlt-confirm-cancel');
      expect(src.outbox.list(), isEmpty);
      await tapKey(tester, 'hlt-fix-orphan-link');
      await tapKey(tester, 'hlt-confirm-ok');
      expect(textOf(tester, 'hlt-notice'), '1 پیوند بی‌صاحب پاک شد');
      expect(src.outbox.list().single.type, 'del');
      expect(find.byKey(const Key('hlt-count-orphan-link')), findsNothing);
      await tapKey(tester, 'hlt-open-dup-nid');
      expect(textOf(tester, 'hld-count'), '۱ مورد');
      await tapKey(tester, 'hld-merge-0');
      expect(textOf(tester, 'hlm-others'), 'بقیهٔ حساب‌ها: علي رضايي');
      await tapKey(tester, 'hlm-keep-21');
      expect(textOf(tester, 'hlm-others'), 'بقیهٔ حساب‌ها: علی رضایی');
      await tapKey(tester, 'hlm-keep-20');
      await tapKey(tester, 'hlm-do');
      expect(
        textOf(tester, 'hlt-notice'),
        'ادغام شد · 1 رکورد منتقل و 1 حساب تکراری حذف شد',
      );
      expect(await tester.runAsync(() => src.engine.get('users', 21)), isNull);
      expect(find.byKey(const Key('hlt-count-dup-nid')), findsNothing);
      await tapKey(tester, 'hlt-rerun');
      expect(textOf(tester, 'hlt-notice'), startsWith('بررسی دوباره تمام شد'));
      await tapKey(tester, 'hlt-open-dup-lookup');
      expect(find.byKey(const Key('hld-item-0')), findsOneWidget);
      await tapKey(tester, 'hld-back');
      expect(find.byKey(const Key('hlt-rerun')), findsOneWidget);
      expect(find.byKey(const Key('hld-back')), findsNothing);
    },
  );

  testWidgets(
    'W12-W06 system links open cloud; NEG an unknown wave hides all three',
    (tester) async {
      await open(tester, 'system');
      await tapKey(tester, 'sys-cloud');
      await settleAsync(tester);
      // Row 172: «تنظیم صندوقچه» switches the shell to the «حافظهٔ ابری» page (web `go('cloud')`)
      expect(find.text('حافظهٔ ابری'), findsWidgets);
      expect(badgeOf(tester, 'cld-state'), 'آماده');
      await openPage(tester, 'system');
      // Row 172: like the web page, «سلامت» is its own page in the menu (no link here)
      expect(find.byKey(const Key('sys-health')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await bootSchool(
        tester,
        role: 'manager',
        seed: seed,
        school: 'users,accounts,classes,schedule,followup,reports,no-such-wave',
      );
      for (final k in ['cloud', 'health']) {
        expect(navOf(k), findsNothing, reason: k);
      }
      // «سیستم» stays as the device page (lock / sign out) but has no school settings
      await openPage(tester, 'system');
      expect(find.byKey(const Key('sys-lock')), findsOneWidget);
      expect(find.byKey(const Key('sys-cloud')), findsNothing);
    },
  );
  testWidgets(
    'W12-W08 row 150: «مشخصات مدرسه» in the manager settings — owner part read-only, '
    'dependencies (type ⇒ caps, شب ⇒ evening, متوسطه دوم ⇒ branch, students ≤ capacity), '
    'saved to the school server; NEG invalid never sent, offline says so',
    (tester) async {
      final (_, admin) = await open(tester, 'system');
      await tapKey(tester, 'sys-profile');
      expect(find.byType(SchoolProfileView), findsOneWidget);
      expect(textOf(tester, 'sp-name'), 'هنرستان نمونه · کد ۱۲۳۴');
      expect(find.byKey(const Key('sp-incomplete')), findsOneWidget);
      // nothing chosen yet ⇒ local validation, nothing sent
      await tapKey(tester, 'sp-save');
      // row 166: every invalid field is outlined red (level AND gender), one summary line
      expect(textOf(tester, 'sp-error'), 'کادرهای قرمز را بررسی و اصلاح کنید');
      await tester.drag(
        find.byKey(const Key('sp-list')),
        const Offset(0, 6000),
      );
      await settle(tester);
      expect(find.text('مقطع را انتخاب کنید'), findsOneWidget);
      expect(find.text('جنسیت مدرسه را انتخاب کنید'), findsOneWidget);
      expect(find.byKey(const Key('sp-capacity')), findsNothing);
      expect(admin.calls, isNot(contains('profile-save')));

      Future<void> top() async {
        await tester.drag(
          find.byKey(const Key('sp-list')),
          const Offset(0, 6000),
        );
        await settle(tester);
      }

      Future<void> tk(String key) async {
        await top();
        await tapKey(tester, key);
      }

      Future<void> ty(String key, String text) async {
        await top();
        await typeKey(tester, key, text);
      }

      Future<void> pick(String key, String label) async {
        await tk(key);
        await tester.tap(find.text(label).last);
        await settle(tester);
      }

      await pick('sp-level', 'متوسطه دوم');
      await pick('sp-gender', 'دخترانه');
      await pick('sp-school_type', 'هنرستان فنی و حرفه‌ای');
      await top();
      await reveal(tester, 'sp-cap-has_workshop');
      final ws = tester.widget<CheckboxListTile>(
        find.byKey(const Key('sp-cap-has_workshop')),
      );
      expect(ws.value, isTrue, reason: 'vocational ⇒ workshop');
      await pick('sp-shift', 'هر دو شیفت (دونوبته)');
      await top();
      await reveal(tester, 'sp-cap-has_evening');
      final ev = tester.widget<CheckboxListTile>(
        find.byKey(const Key('sp-cap-has_evening')),
      );
      expect(ev.value, isTrue);
      expect(ev.onChanged, isNull, reason: 'locked on for شب / هر دو');
      // row 166: no capacity — any number of students
      await ty('sp-students', '۱۵۰۰۰۰');
      await ty('sp-phone', '0912');
      await tk('sp-save');
      expect(textOf(tester, 'sp-error'), 'کادرهای قرمز را بررسی و اصلاح کنید');
      await top();
      await reveal(tester, 'sp-phone');
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('sp-phone')))
            .decoration!
            .errorText,
        schoolProfileErrorsFa['phone'],
      );
      await top();
      await reveal(tester, 'sp-students');
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('sp-students')))
            .decoration!
            .errorText,
        isNull,
      );
      await reveal(tester, 'sp-branches-invalid');
      expect(find.byKey(const Key('sp-branches-invalid')), findsOneWidget);
      await pick('sp-shift', 'چرخشی (هفته‌ای صبح، هفته‌ای بعدازظهر)');
      expect(find.byKey(const Key('sp-rotating-note')), findsOneWidget);
      await tk('sp-branch-فنی و حرفه‌ای');
      await tk('sp-field-کامپیوتر');
      await tk('sp-day-5');
      await ty('sp-phone', '09121234567');
      await tk('sp-save');
      expect(textOf(tester, 'sp-notice'), 'مشخصات مدرسه ذخیره شد');
      expect(find.byKey(const Key('sp-branches-invalid')), findsNothing);
      final sp = admin.savedProfile!;
      expect(sp['level'], 'متوسطه دوم');
      expect(sp['gender'], 'دخترانه');
      expect(sp['school_type'], 'vocational');
      expect(sp.containsKey('capacity'), isFalse);
      expect(sp['student_count'], 150000);
      expect(sp['shift'], 'چرخشی');
      expect(sp['work_days'], [0, 1, 2, 3, 4, 5]);
      expect(sp['branches'], ['فنی و حرفه‌ای']);
      expect(sp['fields'], ['کامپیوتر']);
      expect(find.byKey(const Key('sp-incomplete')), findsNothing);
      // un-ticking a branch drops its fields
      await tk('sp-branch-فنی و حرفه‌ای');
      expect(find.byKey(const Key('sp-field-کامپیوتر')), findsNothing);
      admin.online = false;
      await tk('sp-branch-نظری');
      await tk('sp-save');
      expect(
        textOf(tester, 'sp-error'),
        startsWith('این کار روی سرور مدرسه انجام می‌شود'),
      );
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: SchoolProfileView(admin: null))),
      );
      await settle(tester);
      expect(textOf(tester, 'sp-error'), startsWith('این کار روی سرور مدرسه'));
      expect(find.byKey(const Key('sp-retry')), findsOneWidget);
    },
  );
}

/// Row 172: the web-layout page shows the notice at the top of its list — scroll back up.
Future<String> noticeOf(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  if (f.evaluate().isEmpty) {
    final list = find
        .descendant(
          of: find.byType(ListView).last,
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(f, -300, scrollable: list);
  }
  return textOf(tester, key);
}
