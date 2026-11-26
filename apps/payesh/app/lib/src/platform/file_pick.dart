// Row 194: «انتخاب فایل» opens the SYSTEM file dialog — Windows: the stock «Open» dialog
// (comdlg32 through FFI; the 32-bit edition through its shell), Android: the system picker
// (Storage Access Framework, MainActivity `ir.payesh.school/files`). No plugin.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_secure/payesh_secure.dart' show windowsOpenFileDialog;
import 'package:payesh_sync/payesh_sync.dart' show leaveAttachmentUri;

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

/// ردیف ۱۹۷: سقف بایت عکس گواهی مرخصی (همان MAX_LEAVE_IMAGE در MainActivity).
const int leaveImageMaxBytes = 44000;

const List<(String, String)> imageFilters = [
  ('عکس (JPG / PNG)', '*.jpg;*.jpeg;*.png'),
  ('همهٔ فایل‌ها', '*.*'),
];

/// ردیف ۱۹۷: کوچک‌کردن عکس روی ویندوز با dart:ui (فقط PNG در دسترس است) — null وقتی جا نشد.
Future<List<int>?> shrinkToPng(Uint8List bytes) async {
  for (final side in const [1024, 800, 640, 480, 360]) {
    final codec = await ui.instantiateImageCodec(bytes, targetWidth: side);
    final frame = await codec.getNextFrame();
    final data = await frame.image.toByteData(format: ui.ImageByteFormat.png);
    frame.image.dispose();
    if (data != null && data.lengthInBytes <= leaveImageMaxBytes) {
      return data.buffer.asUint8List();
    }
  }
  return null;
}

// coverage:ignore-start
/// ردیف ۱۹۷: عکس گواهی مرخصی → data URI کوچک (یا null وقتی کاربر چیزی انتخاب نکرد).
/// اندروید: انتخابگر سیستم + فشرده‌سازی JPEG در MainActivity؛ ویندوز: پنجرهٔ «Open».
Future<String?> pickLeaveImage() async {
  Uint8List? bytes;
  if (!kIsWeb && Platform.isAndroid) {
    try {
      final r = await _files.invokeMapMethod<String, Object?>('pickImage');
      if (r == null) return null;
      final b = r['bytes'];
      if (b is! Uint8List) return null;
      bytes = b;
    } on PlatformException catch (e) {
      throw FilePickFailure(switch (e.code) {
        'no_picker' => 'روی این گوشی برنامهٔ انتخاب عکس نیست',
        'busy' => 'پنجرهٔ انتخاب همین حالا باز است',
        _ =>
          e.message == 'too_big'
              ? 'عکس بیش از حد بزرگ است'
              : e.message == 'not_image'
              ? 'فایل انتخاب‌شده عکس نیست'
              : 'عکس خوانده نشد: ${e.message ?? e.code}',
      });
    } on MissingPluginException {
      throw const FilePickFailure('انتخاب عکس در این نسخه پشتیبانی نمی‌شود');
    }
  } else {
    final f = await pickSystemFile(
      title: 'انتخاب عکس گواهی',
      filters: imageFilters,
    );
    if (f == null) return null;
    bytes = f.bytes;
    if (bytes.length > leaveImageMaxBytes ||
        leaveAttachmentUri(bytes) == null) {
      List<int>? png;
      try {
        png = await shrinkToPng(bytes);
      } on Exception {
        throw const FilePickFailure('فایل انتخاب‌شده عکس نیست');
      }
      if (png == null) {
        throw const FilePickFailure(
          'عکس بزرگ است — عکسی کوچک‌تر (زیر ۴۴ کیلوبایت) انتخاب کنید یا از گوشی بفرستید',
        );
      }
      bytes = Uint8List.fromList(png);
    }
  }
  final uri = leaveAttachmentUri(bytes);
  if (uri == null) {
    throw const FilePickFailure('پیوست باید عکس (JPG/PNG) و کم‌حجم باشد');
  }
  return uri;
}

// coverage:ignore-end
