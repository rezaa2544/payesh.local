import 'package:flutter/material.dart';
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'secure/local_storage.dart';

/// Root widget of the native Payesh client (ADR-43). Persian, right-to-left, Material 3, built on
/// the payesh_ui design system (row 73): tokens, light/dark themes, bundled Vazirmatn, Jalali.
class PayeshApp extends StatelessWidget {
  const PayeshApp({super.key, this.storage, this.today});

  /// Encrypted local database being opened (row 72); null in widget previews.
  final Future<LocalStorage>? storage;

  static const Locale fa = PayeshUi.locale;

  @override
  Widget build(BuildContext context) => PayeshMaterialApp(
    home: HomeScreen(storage: storage, today: today),
  );

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
        child: Column(
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
        ),
      ),
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
