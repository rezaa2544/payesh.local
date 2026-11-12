import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';

import 'src/app.dart';
import 'src/platform.dart';

/// Native owner panel (row 126): Flutter UI, no WebView, no Node.js.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    OwnerApp(store: platformSettingsStore(), httpFactory: IoOwnerHttp.new),
  );
}
