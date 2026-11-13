import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_update/payesh_update.dart';

import 'src/app.dart';
import 'src/attendance/attendance_wiring.dart';
import 'src/flags.dart';
import 'src/login/device_identity.dart';
import 'src/login/session_controller.dart';
import 'src/login/wiring.dart';
import 'src/secure/local_storage.dart';
import 'src/update/app_update.dart';

void main(List<String> args) {
  WidgetsFlutterBinding.ensureInitialized();
  final flags = ClientFlags.fromEnvironment();
  final lanClient = lanEnabled
      ? LanAccessClient(platform: Platform.operatingSystem)
      : null;
  final session = SessionController(
    api: schoolAccessFromEnvironment(),
    accounts: SchoolAccountStore(platformSecureStore()),
    flags: flags,
    // Row 127: the school's own server on the local network (Sync v1), next to the Gateway.
    lan: lanClient,
    // Row 145: registration request + subscription via the school server; trial once per device.
    schools: lanClient == null ? null : LanSchoolsClient(lanClient),
    // Row 152: support messages to the owner via the school server (never the bucket key).
    support: lanClient == null ? null : LanSupportClient(lanClient),
    deviceId: platformDeviceId,
    openUrl: openExternalUrl,
    deviceName: 'پایش ${Platform.operatingSystem}',
  )..start();
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
          openUrl: openUri,
        )
      : null;
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
    ),
  );
  if (updater != null && ua.now) {
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => unawaited(runUpdateNow(updater)),
    );
  }
}
