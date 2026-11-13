// مشخصات انتشار یک برنامهٔ نصبی (Dart خالص — ابزارهای خط فرمان هم از آن استفاده می‌کنند).

/// مشخصات انتشار یک برنامهٔ نصبی.
final class UpdateChannel {
  const UpdateChannel({
    required this.id,
    required this.schema,
    required this.manifest,
    required this.blobs,
    required this.apk,
    required this.exeName,
    required this.stagingFolder,
    required this.versionBase,
    required this.build,
  });

  /// `owner` یا `app`.
  final String id;
  final String schema;
  final String manifest;
  final String blobs;
  final String apk;
  final String exeName;

  /// پوشه در `%LOCALAPPDATA%` برای فایل‌های موقت به‌روزرسانی.
  final String stagingFolder;

  /// دو بخش اول نسخه (pubspec)؛ بخش سوم شمارهٔ ساخت CI است.
  final String versionBase;

  /// شمارهٔ ساخت همین برنامه (CI: `--dart-define=...=<run_number>`).
  final int build;

  Uri get manifestUrl => Uri.parse(manifest);
  Uri get blobBase => Uri.parse(blobs);
  Uri get apkUrl => Uri.parse(apk);

  /// نسخهٔ نمایشی یک ساخت: `<versionBase>.<build>`.
  String versionOf(int b) => '$versionBase.$b';
  String get version => versionOf(build);
}
