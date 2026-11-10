import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/secure/local_storage.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(PayeshApp(storage: openPlatformStorage()));
}
