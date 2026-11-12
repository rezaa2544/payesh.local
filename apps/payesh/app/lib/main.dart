import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'src/app.dart';
import 'src/flags.dart';
import 'src/login/session_controller.dart';
import 'src/login/wiring.dart';
import 'src/secure/local_storage.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final session = SessionController(
    api: schoolAccessFromEnvironment(),
    accounts: SchoolAccountStore(platformSecureStore()),
    flags: ClientFlags.fromEnvironment(),
  )..start();
  runApp(PayeshApp(storage: openPlatformStorage(), session: session));
}
