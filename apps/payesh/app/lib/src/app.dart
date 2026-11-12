import 'package:flutter/material.dart';
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'attendance/attendance_controller.dart';
import 'attendance/attendance_screen.dart';
import 'flags.dart';
import 'login/login_screens.dart';
import 'login/session_controller.dart';
import 'secure/local_storage.dart';

/// Root widget of the native Payesh client (ADR-43). Persian, right-to-left, Material 3, built on
/// the payesh_ui design system (row 73): tokens, light/dark themes, bundled Vazirmatn, Jalali.
class PayeshApp extends StatelessWidget {
  const PayeshApp({
    super.key,
    this.storage,
    this.today,
    this.session,
    this.attendance,
    this.onRetrySync,
  });

  /// Encrypted local database being opened (row 72); null in widget previews.
  final Future<LocalStorage>? storage;

  /// Login wave (row 74): school select → activation → signed in, or the old client. Null in
  /// widget previews (the home screen is shown directly).
  final SessionController? session;

  /// Wave 2 data (local database + outbox + Gateway); null = attendance stays on the web client.
  final AttendanceSource? attendance;

  /// Badge tap on native pages: run a sync cycle now.
  final VoidCallback? onRetrySync;

  static const Locale fa = PayeshUi.locale;

  Widget _pages(BuildContext context, SessionController s, SignedIn state) {
    final src = attendance;
    final role = state.currentRole;
    final uid = state.currentUid;
    return AttendanceEntry(
      enabled: src != null && s.flags.uses(NativeWave.attendance),
      role: role,
      uid: uid,
      open: () {
        if (src == null || role == null || uid == null) return;
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => AttendanceRoute(
              source: src,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
              now: today,
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = session;
    return PayeshMaterialApp(
      home: s == null
          ? HomeScreen(storage: storage, today: today)
          : SessionGate(
              controller: s,
              home: HomeBody(storage: storage, today: today),
              pages: (context, state) => _pages(context, s, state),
            ),
    );
  }

  /// Injected clock for tests; defaults to the device date (displayed as Jalali).
  final DateTime Function()? today;
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, this.storage, this.today});

  final Future<LocalStorage>? storage;
  final DateTime Function()? today;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('پایش')),
      body: Center(
        child: HomeBody(storage: storage, today: today),
      ),
    );
  }
}

/// Home content (shared by the preview screen and the signed-in shell of row 74).
class HomeBody extends StatelessWidget {
  const HomeBody({super.key, this.storage, this.today});

  final Future<LocalStorage>? storage;
  final DateTime Function()? today;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('نسخهٔ بومی پایش', key: Key('home-title')),
        const SizedBox(height: 8),
        JalaliDateText(
          (today ?? DateTime.now)().toIso8601String().substring(0, 10),
          key: const Key('home-today'),
        ),
        const SizedBox(height: 8),
        const Text(PayeshApi.syncContract, key: Key('home-contract')),
        if (storage != null) ...[
          const SizedBox(height: 8),
          StorageStatus(storage: storage!),
        ],
      ],
    );
  }
}

/// Shows whether the encrypted local database opened (owner device check, row 72).
class StorageStatus extends StatelessWidget {
  const StorageStatus({super.key, required this.storage});

  final Future<LocalStorage> storage;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<LocalStorage>(
      future: storage,
      builder: (context, snap) {
        if (snap.hasError) {
          return const Text(
            'خطای ذخیره‌سازی امن — داده‌ای باز نشد',
            key: Key('storage-error'),
          );
        }
        if (!snap.hasData) {
          return const Text('در حال باز کردن پایگاه محلی…');
        }
        final s = snap.data!;
        return Text(
          s.quarantined == null
              ? 'پایگاه محلی رمزنگاری‌شده فعال است'
              : 'پایگاه محلی قبلی قابل رمزگشایی نبود؛ پایگاه تازه ساخته شد',
          key: const Key('storage-ok'),
        );
      },
    );
  }
}
