// اندروید (ردیف ۱۴۸): بستهٔ کامل (APK) درون برنامه دانلود می‌شود — با پیشرفت روی چراغ نوار
// بالا، تلاش دوباره و بررسی SHA-256 و اندازه با همان مانیفست — و نصب‌کنندهٔ سیستم مستقیم
// باز می‌شود (نه مرورگر). پس از نصب، گیرندهٔ MY_PACKAGE_REPLACED برنامه را دوباره باز می‌کند
// (تا جایی که اندروید اجازه دهد؛ وگرنه دکمهٔ «باز کردن» نصب‌کنندهٔ سیستم).

import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';

import 'delta.dart';

/// دانلود APK در [dir] با بررسی هش. اگر همان فایل قبلاً کامل دانلود شده، دوباره دانلود نمی‌شود.
Future<File> downloadApk({
  required ApkInfo apk,
  required Uri url,
  required UpdateHttp http,
  required Directory dir,
  required int build,
  UpdateRetry retry = const UpdateRetry(),
  void Function(int done, int total)? onProgress,
}) async {
  final sep = Platform.pathSeparator;
  final out = File('${dir.path}${sep}payesh-update-$build.apk');
  try {
    dir.createSync(recursive: true);
    // بسته‌های ساخت‌های قدیمی‌تر
    for (final e in dir.listSync().whereType<File>()) {
      final n = e.uri.pathSegments.last;
      if (n.startsWith('payesh-update-') && e.path != out.path) {
        try {
          e.deleteSync();
        } on Object {
          // بعداً
        }
      }
    }
  } on FileSystemException catch (e) {
    throw UpdateException('io', '$e');
  }
  onProgress?.call(0, apk.size);
  if (out.existsSync() && out.lengthSync() == apk.size) {
    final h = (await sha256.bind(out.openRead()).first).toString();
    if (h == apk.sha256) {
      onProgress?.call(apk.size, apk.size);
      return out;
    }
  }
  final bytes = await retry.run((_) async {
    final b = await http.get(
      url,
      maxBytes: apk.size + 1024,
      onBytes: (n) => onProgress?.call(n > apk.size ? apk.size : n, apk.size),
    );
    if (b == null) throw const UpdateException('network', 'apk 404');
    if (b.length != apk.size || sha256.convert(b).toString() != apk.sha256) {
      throw const UpdateException('bad_hash', 'apk');
    }
    return b;
  });
  try {
    final part = File('${out.path}.part');
    part.writeAsBytesSync(bytes, flush: true);
    if (out.existsSync()) out.deleteSync();
    part.renameSync(out.path);
  } on FileSystemException catch (e) {
    throw UpdateException('io', '$e');
  }
  onProgress?.call(apk.size, apk.size);
  return out;
}

/// نصب APK با نصب‌کنندهٔ سیستم.
abstract interface class ApkInstaller {
  /// پوشهٔ خصوصی برای نگه داشتن APK دانلودشده.
  Future<Directory> cacheDir();

  /// `started` ⇒ نصب‌کنندهٔ سیستم باز شد (برنامه پس از نصب بسته و دوباره باز می‌شود)؛
  /// `needs_permission` ⇒ صفحهٔ اجازهٔ «نصب برنامه‌های ناشناس» باز شد.
  Future<String> install(File apk);
}

/// پیاده‌سازی با کانال بومی `ir.payesh/update` (MainActivity.kt هر برنامه).
final class ChannelApkInstaller implements ApkInstaller {
  const ChannelApkInstaller([
    this.channel = const MethodChannel('ir.payesh/update'),
  ]);
  final MethodChannel channel;

  @override
  Future<Directory> cacheDir() async {
    final p = await channel.invokeMethod<String>('cacheDir');
    if (p == null || p.isEmpty) {
      throw const UpdateException('io', 'no cache dir');
    }
    return Directory(p);
  }

  @override
  Future<String> install(File apk) async {
    try {
      final r = await channel.invokeMethod<String>('installApk', {
        'path': apk.path,
      });
      return r ?? 'error';
    } on PlatformException catch (e) {
      throw UpdateException('install', '${e.code}: ${e.message ?? ''}');
    } on MissingPluginException {
      throw const UpdateException('install', 'no native installer');
    }
  }
}
