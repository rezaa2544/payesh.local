import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_data/sqlite.dart' show prepareWebSqlite;
import 'package:payesh_secure/payesh_secure.dart'
    show installLegacyWindowsTrust;
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_update/payesh_update.dart';

import 'src/app.dart';
import 'src/attendance/attendance_wiring.dart';
import 'src/flags.dart';
import 'src/login/device_identity.dart';
import 'src/login/local_server.dart';
import 'src/login/session_controller.dart';
import 'src/login/vpn_probe.dart';
import 'src/login/wiring.dart';
import 'src/secure/local_storage.dart';
import 'src/update/app_update.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  // Row 169 (D-50): the 32-bit Windows edition (this code compiled to JavaScript inside the
  // CEF x86 shell) gets dart:io and SQLite from the shell first. Native builds skip this.
  if (isWeb32) {
    await prepareWebHost();
    await prepareWebSqlite();
  }
  // Row 168: Windows 7/8/8.1 — Mozilla roots next to the old system root store (no-op elsewhere).
  installLegacyWindowsTrust();
  final flags = ClientFlags.fromEnvironment();
  final lanClient = lanEnabled
      ? LanAccessClient(platform: Platform.operatingSystem)
      : null;
  final prefs = platformSecureStore();
  final session = SessionController(
    api: schoolAccessFromEnvironment(),
    accounts: SchoolAccountStore(prefs),
    flags: flags,
    // Row 127: the school's own server on the local network (Sync v1), next to the Gateway.
    lan: lanClient,
    // Row 163: no server address on the login screen — the remembered server, this computer
    // (started if installed here), then the address-only list in the owner's database.
    directory: lanClient == null ? null : SchoolDirectoryClient(),
    startLocalServer: lanClient == null ? null : LocalSchoolServer().start,
    // Row 145: registration request + subscription via the school server; trial once per device.
    schools: lanClient == null ? null : LanSchoolsClient(lanClient),
    // Row 152: support messages to the owner via the school server (never the bucket key).
    support: lanClient == null ? null : LanSupportClient(lanClient),
    deviceId: platformDeviceId,
    openUrl: openExternalUrl,
    deviceName: 'پایش ${Platform.operatingSystem}',
    // Row 186: no server answered → say so when a VPN is the reason (Android) and search again
    // by itself (5 s, 10 s, 20 s, then every 30 s) until the school server answers.
    vpnActive: Platform.isAndroid ? vpnInterfaceUp : null,
    retryDelays: const [
      Duration(seconds: 5),
      Duration(seconds: 10),
      Duration(seconds: 20),
      Duration(seconds: 30),
    ],
  );
  unawaited(session.start());
  final storage = openPlatformStorage();
  // Wave 2 (row 74): attendance on the device, synced through the pinned Gateway — or (row 127)
  // through the school's own LAN server with the same outbox and AutoSync.
  final gw = gatewayConfigFromEnvironment();
  final attendance =
      (gw == null && !lanEnabled) || !flags.ships(NativeWave.attendance)
      ? null
      : (GatewayAttendanceSource(
          storage: storage.then((s) => s.engine),
          session: session,
          client: gw == null ? null : createPinnedHttpClient(gw),
        )..attach());
  // Row 177: in the background (minimised / another app on top) nothing is fetched at all.
  if (attendance != null) {
    AppLifecycleListener(
      onHide: () => attendance.setForeground(false),
      onShow: () => attendance.setForeground(true),
    );
  }
  // Row 148: in-app update on CI-built releases (build number set); --update-from/--update-now
  // run the very same path from a local folder (support + the CI end-to-end test).
  final ua = UpdateArgs.parse(args);
  Future<void> openUri(Uri u) async {
    await openExternalUrl(u.toString());
  }

  final updater = appBuild > 0 || ua.from != null
      ? AppUpdater(
          channel: appChannel,
          manifestUrl: ua.manifest('app-update.json'),
          blobBase: ua.blobs('app-files'),
          // Row 165 (owner decision): in-app install like the owner app — the APK is downloaded
          // here (progress, retries, SHA-256 + size from the manifest) and handed to the system
          // installer; no browser.
          apkInstaller: Platform.isAndroid ? const ChannelApkInstaller() : null,
          openUrl: openUri,
        )
      : null;
  // Row 179: روشن / تاریک / سیستم — read before the first frame (no flash of the wrong mode).
  final themeMode = PayeshThemeMode(
    save: (v) => prefs.write(PayeshThemeMode.storeKey, v),
  );
  await themeMode.load(prefs.read);
  runApp(
    PayeshApp(
      storage: storage,
      session: session,
      attendance: attendance,
      // Wave 3: grades share the attendance data path (same database, outbox and Gateway).
      grades: flags.ships(NativeWave.grades) ? attendance : null,
      // Wave 4: notices on the same data path (every role reads, the manager writes).
      notices: flags.ships(NativeWave.notices) ? attendance : null,
      // Wave 5: parents pages on the same data path (children, child page, leave requests).
      family: flags.ships(NativeWave.parents) ? attendance : null,
      // Row 128: school-management pages on the same data path (each gated by its wave).
      school: flags.school.isEmpty ? null : attendance,
      onRetrySync: attendance?.retry,
      updater: updater,
      openUrl: openUri,
      // Row 179: «چه چیزهایی تازه است؟» once after every update.
      whatsNew: WhatsNewStore(read: prefs.read, write: prefs.write),
      themeMode: themeMode,
    ),
  );
  if (updater != null && ua.now) {
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => unawaited(runUpdateNow(updater)),
    );
  }
}
