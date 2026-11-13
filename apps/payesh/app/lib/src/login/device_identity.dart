import 'dart:io';

import 'package:flutter/services.dart';

import '../secure/android_keystore_store.dart';

/// Row 145 — شناسهٔ سیستمی دستگاه برای «آزمایشی فقط یک بار برای هر دستگاه».
///
/// شناسه‌ای که با حذف و نصب دوبارهٔ برنامه عوض نمی‌شود:
///   • Android: `Settings.Secure.ANDROID_ID` (کانال بومی MainActivity.kt)؛
///   • Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`؛
///   • Linux: `/etc/machine-id`.
/// خودِ شناسه هرگز فرستاده نمی‌شود؛ فقط درهم‌سازی آن (deviceHashOf در payesh_sync).
Future<String?> platformDeviceId({
  MethodChannel channel = const MethodChannel(AndroidKeystoreStore.channelName),
  Future<ProcessResult> Function(String, List<String>)? run,
}) async {
  try {
    if (Platform.isAndroid) {
      return await channel.invokeMethod<String>('deviceId');
    }
    if (Platform.isWindows) {
      final r = await (run ?? Process.run)('reg', [
        'query',
        r'HKLM\SOFTWARE\Microsoft\Cryptography',
        '/v',
        'MachineGuid',
        '/reg:64',
      ]);
      return parseMachineGuid('${r.stdout}');
    }
    if (Platform.isLinux) {
      for (final p in ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        final f = File(p);
        if (await f.exists()) {
          final t = (await f.readAsString()).trim();
          if (t.isNotEmpty) return t;
        }
      }
    }
  } on Object {
    return null;
  }
  return null;
}

/// خروجی `reg query … /v MachineGuid` → GUID (یا null).
String? parseMachineGuid(String out) {
  final m = RegExp(r'MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})')
      .firstMatch(out);
  return m?.group(1)?.toLowerCase();
}

/// باز کردن پیوند درگاه پرداخت در مرورگر سیستم.
Future<bool> openExternalUrl(
  String url, {
  MethodChannel channel = const MethodChannel(AndroidKeystoreStore.channelName),
}) async {
  final u = Uri.tryParse(url);
  if (u == null || (u.scheme != 'https' && u.scheme != 'http')) return false;
  try {
    if (Platform.isAndroid) {
      return await channel.invokeMethod<bool>('openUrl', {'url': url}) ?? false;
    }
    if (Platform.isWindows) {
      await Process.start('rundll32', ['url.dll,FileProtocolHandler', url]);
      return true;
    }
    if (Platform.isLinux) {
      await Process.start('xdg-open', [url]);
      return true;
    }
    if (Platform.isMacOS) {
      await Process.start('open', [url]);
      return true;
    }
  } on Object {
    return false;
  }
  return false;
}
