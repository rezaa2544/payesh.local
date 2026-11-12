import 'dart:io';

import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'src/app.dart';
import 'src/attendance/attendance_wiring.dart';
import 'src/flags.dart';
import 'src/login/session_controller.dart';
import 'src/login/wiring.dart';
import 'src/secure/local_storage.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final flags = ClientFlags.fromEnvironment();
  final session = SessionController(
    api: schoolAccessFromEnvironment(),
    accounts: SchoolAccountStore(platformSecureStore()),
    flags: flags,
    // Row 127: the school's own server on the local network (Sync v1), next to the Gateway.
    lan: lanEnabled
        ? LanAccessClient(platform: Platform.operatingSystem)
        : null,
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
      onRetrySync: attendance?.retry,
    ),
  );
}
