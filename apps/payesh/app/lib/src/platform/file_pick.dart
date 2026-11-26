// Row 194: «انتخاب فایل» opens the SYSTEM file dialog — Windows: the stock «Open» dialog
// (comdlg32 through FFI; the 32-bit edition through its shell), Android: the system picker
// (Storage Access Framework, MainActivity `ir.payesh.school/files`). No plugin.
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_secure/payesh_secure.dart' show windowsOpenFileDialog;

/// A file the user chose: its name and contents.
final class PickedFile {
  const PickedFile(this.name, this.bytes, {this.path});
  final String name;
  final Uint8List bytes;

  /// Windows only (the path the dialog returned).
  final String? path;
}

/// Thrown when this device has no usable picker or the file could not be read.
final class FilePickFailure implements Exception {
  const FilePickFailure(this.messageFa);
  final String messageFa;
  @override
  String toString() => messageFa;
}

const MethodChannel _files = MethodChannel('ir.payesh.school/files');

/// Excel / CSV files the import wizard reads.
const List<(String, String)> sheetFilters = [
  ('فایل اکسل یا CSV', '*.xlsx;*.csv'),
  ('همهٔ فایل‌ها', '*.*'),
];

// coverage:ignore-start
// Platform code — Windows (FFI dialog) and Android (system picker) are checked on the PC and
// the phone; widget tests replace [ImportController.pickFile].

/// Shows the system dialog; null = the user closed it without choosing.
Future<PickedFile?> pickSystemFile({
  String title = 'انتخاب فایل اطلاعات مدرسه',
  List<(String, String)> filters = sheetFilters,
}) async {
  if (!isWeb32 && kIsWeb) {
    throw const FilePickFailure('انتخاب فایل در این نسخه پشتیبانی نمی‌شود');
  }
  if (Platform.isAndroid) {
    try {
      final r = await _files.invokeMapMethod<String, Object?>('pick');
      if (r == null) return null;
      final bytes = r['bytes'];
      if (bytes is! Uint8List) return null;
      return PickedFile('${r['name'] ?? 'file'}', bytes);
    } on PlatformException catch (e) {
      throw FilePickFailure(switch (e.code) {
        'no_picker' => 'روی این گوشی برنامهٔ انتخاب فایل نیست',
        'busy' => 'پنجرهٔ انتخاب فایل همین حالا باز است',
        _ =>
          e.message == 'too_big'
              ? 'فایل بیش از ۲۵ مگابایت است'
              : 'فایل خوانده نشد: ${e.message ?? e.code}',
      });
    } on MissingPluginException {
      throw const FilePickFailure('انتخاب فایل در این نسخه پشتیبانی نمی‌شود');
    }
  }
  if (Platform.isWindows) {
    final path = await windowsOpenFileDialog(title: title, filters: filters);
    if (path == null) return null;
    try {
      final bytes = await File(path).readAsBytes();
      return PickedFile(path.split(RegExp(r'[\\/]')).last, bytes, path: path);
    } on FileSystemException catch (e) {
      throw FilePickFailure(
        'فایل خوانده نشد: ${e.osError?.message ?? e.message}',
      );
    }
  }
  throw const FilePickFailure('انتخاب فایل در این دستگاه پشتیبانی نمی‌شود');
}

// coverage:ignore-end
