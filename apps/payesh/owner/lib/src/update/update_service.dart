// به‌روزرسانی پنل مالک در برنامه: بررسی، دریافت فقط تغییرات (آینهٔ آروان ⇐ GitHub)، اعمال و
// باز شدن دوباره (ویندوز)، یا APK درون برنامه (اندروید). کنترل مشترک: payesh_update.

import 'dart:async';
import 'dart:io';

import 'package:payesh_secure/payesh_secure.dart';

import '../local/s3_client.dart';
import 'owner_update.dart';

/// آینهٔ صندوقچهٔ آروان برای فایل‌های فشردهٔ به‌روزرسانی.
final class S3UpdateMirror implements UpdateMirror {
  S3UpdateMirror(this.s3, this.transport);
  final S3Settings s3;
  final S3Transport Function() transport;

  @override
  Future<List<int>?> get(String blob) async {
    final t = transport();
    try {
      return await s3GetBytes(s3, t, '$mirrorPrefix$blob');
    } finally {
      t.close();
    }
  }

  @override
  Future<void> put(String blob, List<int> gz) async {
    final t = transport();
    try {
      await s3PutBytes(s3, t, '$mirrorPrefix$blob', gz);
    } finally {
      t.close();
    }
  }
}

final class OwnerUpdater extends AppUpdater {
  OwnerUpdater({
    required this.secure,
    super.http,
    S3Transport Function()? mirrorTransport,
    super.installDir,
    super.stagingRoot,
    super.manifestUrl,
    super.blobBase,
    super.windows,
    super.launcher,
    super.apkInstaller,
    super.openUrl,
    super.retry,
    super.exitApp,
    super.currentBuild,
  }) : mirrorTransport =
           mirrorTransport ??
           (() => IoS3Transport(
             maxBytes: 256 * 1024 * 1024,
             timeout: const Duration(minutes: 2),
           )),
       super(channel: ownerChannel, mirror: null);

  final SecureStore secure;
  final S3Transport Function() mirrorTransport;

  @override
  Future<UpdateMirror?> Function()? get mirror => _s3Mirror;

  Future<UpdateMirror?> _s3Mirror() async {
    try {
      final s = await S3Settings.load(secure);
      if (s == null || s.bucket.isEmpty) return null;
      return S3UpdateMirror(s, mirrorTransport);
    } on Object {
      return null;
    }
  }
}

/// پوشهٔ موقت پیش‌فرض (برای سازگاری با کد قبلی).
Directory defaultOwnerStaging() => AppUpdater.defaultStaging('PayeshOwner');
