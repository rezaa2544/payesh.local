import 'errors_table.dart';
import 'rules.dart';

export 'errors_table.dart';

/// Persian text for a failed call — same rule as `errText` in the retired web panel:
/// server `error` code first, then the client-side kind (`network`, `bad_response`),
/// else «خطا (status)»; a string `detail` from the server is appended.
String errorText({int status = 0, String? kind, Object? body}) {
  final code = body is Map<String, Object?> ? body['error'] : null;
  final base =
      (code is String ? ownerErrors[code] : null) ??
      (kind != null ? ownerErrors[kind] : null) ??
      ('خطا${status != 0 ? ' (${faNum(status)})' : ''}');
  final detail = body is Map<String, Object?> ? body['detail'] : null;
  return detail is String && detail.isNotEmpty ? '$base — $detail' : base;
}
