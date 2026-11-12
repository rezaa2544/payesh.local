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
  )..start();
  final storage = openPlatformStorage();
  // Wave 2 (row 74): attendance on the device, synced through the pinned Gateway only.
  final gw = gatewayConfigFromEnvironment();
  final attendance = gw == null || !flags.ships(NativeWave.attendance)
      ? null
      : (GatewayAttendanceSource(
          storage: storage.then((s) => s.engine),
          session: session,
          client: createPinnedHttpClient(gw),
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
      onRetrySync: attendance?.retry,
    ),
  );
}
