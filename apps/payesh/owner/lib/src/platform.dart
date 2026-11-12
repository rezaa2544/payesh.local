import 'dart:io';

import 'package:flutter/services.dart';

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
