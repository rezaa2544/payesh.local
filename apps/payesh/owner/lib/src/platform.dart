import 'dart:io';

import 'package:flutter/services.dart';
import 'package:payesh_secure/payesh_secure.dart';

/// Where the app remembers the server origin and the theme choice. Never the token.
abstract interface class SettingsStore {
  Future<String?> read(String name);
  Future<void> write(String name, String? value);
}

/// In-memory store (widget tests, previews).
final class MemorySettingsStore implements SettingsStore {
  MemorySettingsStore([Map<String, String>? initial]) : values = {...?initial};
  final Map<String, String> values;
  @override
  Future<String?> read(String name) async => values[name];
  @override
  Future<void> write(String name, String? value) async {
    if (value == null) {
      values.remove(name);
    } else {
      values[name] = value;
    }
  }
}

/// One small UTF-8 file per setting in a private directory.
final class FileSettingsStore implements SettingsStore {
  FileSettingsStore(this._dir);
  final Future<String> Function() _dir;

  Future<File> _file(String name) async {
    final d = Directory(await _dir());
    if (!d.existsSync()) d.createSync(recursive: true);
    return File('${d.path}${Platform.pathSeparator}$name.txt');
  }

  @override
  Future<String?> read(String name) async {
    try {
      final f = await _file(name);
      if (!f.existsSync()) return null;
      final s = f.readAsStringSync().trim();
      return s.isEmpty ? null : s;
    } on FileSystemException {
      return null;
    }
  }

  @override
  Future<void> write(String name, String? value) async {
    final f = await _file(name);
    if (value == null) {
      if (f.existsSync()) f.deleteSync();
      return;
    }
    f.writeAsStringSync(value, flush: true);
  }
}

const MethodChannel _channel = MethodChannel('ir.payesh.owner/app');

/// Android: the app's no-backup files dir; Windows: `%LOCALAPPDATA%\PayeshOwner` (the same
/// folder whose `origin.txt` the retired WebView2 shell used, so the saved server carries
/// over); elsewhere (developer machines): `$XDG_DATA_HOME/payesh-owner`.
SettingsStore platformSettingsStore() => FileSettingsStore(() async {
  if (Platform.isAndroid) {
    final d = await _channel.invokeMethod<String>('dataDir');
    if (d == null || d.isEmpty) throw const FileSystemException('no data dir');
    return d;
  }
  final env = Platform.environment;
  if (Platform.isWindows) {
    final base =
        env['LOCALAPPDATA'] ?? env['APPDATA'] ?? Directory.systemTemp.path;
    return '$base\\PayeshOwner';
  }
  final home = env['HOME'] ?? Directory.systemTemp.path;
  return '${env['XDG_DATA_HOME'] ?? '$home/.local/share'}/payesh-owner';
});

/// باز کردن نشانی https بیرونی (اندروید: مرورگر/دانلودگر سیستم برای APK تازه).
Future<void> platformOpenUrl(Uri url) async {
  if (url.scheme != 'https') return;
  try {
    if (Platform.isAndroid) {
      await _channel.invokeMethod<void>('openUrl', {'url': url.toString()});
    } else if (Platform.isWindows) {
      await Process.start('explorer.exe', [url.toString()]);
    }
  } on Object {
    // بی‌اثر: چراغ همچنان «آماده» می‌ماند
  }
}

String _windowsBase() {
  final env = Platform.environment;
  return env['LOCALAPPDATA'] ?? env['APPDATA'] ?? Directory.systemTemp.path;
}

/// انبار امن اندروید: AES-256-GCM با کلید درون Android Keystore (KeystoreSecureStore.kt).
final class ChannelSecureStore implements SecureStore {
  ChannelSecureStore([MethodChannel? channel]) : _ch = channel ?? _channel;
  final MethodChannel _ch;

  Future<T?> _call<T>(String method, Map<String, Object?> args) async {
    try {
      return await _ch.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      throw SecureStoreException('${e.code}: ${e.message ?? ''}');
    } on MissingPluginException {
      throw const SecureStoreException('secure store channel not available');
    }
  }

  @override
  Future<String?> read(String key) =>
      _call<String>('secureRead', {'key': checkSecureKey(key)});

  @override
  Future<void> write(String key, String value) =>
      _call<void>('secureWrite', {'key': checkSecureKey(key), 'value': value});

  @override
  Future<void> delete(String key) =>
      _call<void>('secureDelete', {'key': checkSecureKey(key)});
}

/// فقط دستگاه توسعه (لینوکس/مک): فایل خصوصی ساده — نصب‌کننده‌ها هرگز از آن استفاده نمی‌کنند.
final class DevFileSecureStore implements SecureStore {
  DevFileSecureStore(String dir) : _files = FileSettingsStore(() async => dir);
  final FileSettingsStore _files;
  @override
  Future<String?> read(String key) => _files.read(checkSecureKey(key));
  @override
  Future<void> write(String key, String value) =>
      _files.write(checkSecureKey(key), value);
  @override
  Future<void> delete(String key) => _files.write(checkSecureKey(key), null);
}

/// ویندوز: DPAPI (کاربر جاری) در `%LOCALAPPDATA%\PayeshOwner\secure`؛ اندروید: Keystore.
SecureStore platformSecureStore() {
  if (Platform.isWindows) {
    return DpapiSecureStore('${_windowsBase()}\\PayeshOwner\\secure');
  }
  if (Platform.isAndroid) return ChannelSecureStore();
  final env = Platform.environment;
  final home = env['HOME'] ?? Directory.systemTemp.path;
  return DevFileSecureStore(
    '${env['XDG_DATA_HOME'] ?? '$home/.local/share'}/payesh-owner/secure',
  );
}
