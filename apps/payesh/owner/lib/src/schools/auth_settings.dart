// ردیف ۱۶۰ — روش‌های ورود کاربران و پنل پیامکِ کل سامانه (تنظیم مالک).
//
// در فهرست مهرشدهٔ مدارس، کلید جدای `plain.auth` (جدا از `settings` تا ذخیرهٔ پلن‌ها آن را پاک
// نکند). سرورهای مدرسه همان را از صندوقچه می‌خوانند (server/sms.js `settingsOf`)؛ این کلاس
// همان قاعده را دارد و بردار مشترک docs/cloud/contracts/auth-vectors.json هر دو را می‌سنجد.
//
//   primary: 'password' | 'mobile'   — صفحهٔ اول ورود کدام روش باشد (دیگری زیرش)
//   sms: { enabled, url, method, headers, body, message, code_length, ok_match }
//
// جای‌نگهدارها: {mobile} {mobile98} {code} {message} {minutes} {school}
import 'dart:async';
import 'dart:convert';

import 'package:payesh_core/io.dart';

/// متن پیش‌فرض پیامک (همان DEFAULT_MESSAGE سرور).
const String defaultSmsMessage =
    'پایش — کد ورود شما: {code}\nاین کد {minutes} دقیقه اعتبار دارد؛ آن را به کسی ندهید.';

final RegExp _headerName = RegExp(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$");
final RegExp _placeholder = RegExp(r'\{([a-z0-9_]+)\}');

/// پیوند پنل: فقط http(s) با میزبان؛ جای‌نگهدارها مجازند. نامعتبر ⇒ ''.
String safeSmsUrl(Object? u) {
  final s = '${u ?? ''}'.trim();
  if (s.isEmpty) return '';
  final x = Uri.tryParse(s.replaceAll(_placeholder, 'x'));
  if (x == null || (x.scheme != 'https' && x.scheme != 'http')) return '';
  if (x.host.isEmpty) return '';
  return s.length > 1000 ? s.substring(0, 1000) : s;
}

/// سرآیندهای «نام: مقدار» هر خط؛ نام نامعتبر کنار می‌رود؛ حداکثر ۱۰.
List<(String, String)> parseSmsHeaders(Object? text) {
  final out = <(String, String)>[];
  for (final line in '${text ?? ''}'.split(RegExp(r'\r?\n'))) {
    final i = line.indexOf(':');
    if (i <= 0) continue;
    final name = line.substring(0, i).trim();
    final value = line.substring(i + 1).trim();
    if (!_headerName.hasMatch(name) || value.contains(RegExp(r'[\r\n]'))) {
      continue;
    }
    out.add((name, value.length > 500 ? value.substring(0, 500) : value));
    if (out.length >= 10) break;
  }
  return out;
}

String _cut(String s, int n) => s.length > n ? s.substring(0, n) : s;

/// یک درخواست ساخته‌شده برای پنل (بدون ارسال).
final class SmsRequest {
  const SmsRequest(this.url, this.method, this.headers, this.body);
  final String url;
  final String method;
  final Map<String, String> headers;
  final String? body;
}

/// ارسال‌کننده (آزمون‌ها جعلی می‌دهند): وضعیت HTTP و متن پاسخ.
typedef SmsSender = Future<(int, String)> Function(SmsRequest r);

final class AuthSettings {
  const AuthSettings({
    this.primary = 'password',
    this.enabled = false,
    this.url = '',
    this.method = 'GET',
    this.headersText = '',
    this.body = '',
    this.message = defaultSmsMessage,
    this.codeLength = 6,
    this.okMatch = '',
  });

  factory AuthSettings.of(Map<String, Object?>? plain) {
    final ra = plain?['auth'];
    final a = ra is Map
        ? ra.cast<String, Object?>()
        : const <String, Object?>{};
    final rs = a['sms'];
    final s = rs is Map
        ? rs.cast<String, Object?>()
        : const <String, Object?>{};
    final method = '${s['method'] ?? 'GET'}'.toUpperCase() == 'POST'
        ? 'POST'
        : 'GET';
    final len = s['code_length'];
    final msg = _cut('${s['message'] ?? ''}'.trim(), 300);
    return AuthSettings(
      primary: a['primary'] == 'mobile' ? 'mobile' : 'password',
      enabled: s['enabled'] == true,
      url: safeSmsUrl(s['url']),
      method: method,
      headersText: s['headers'] is String ? s['headers']! as String : '',
      body: method == 'POST' ? _cut('${s['body'] ?? ''}', 2000) : '',
      message: msg.isEmpty ? defaultSmsMessage : msg,
      codeLength: len is int && len >= 4 && len <= 8 ? len : 6,
      okMatch: _cut('${s['ok_match'] ?? ''}', 100),
    );
  }

  final String primary;
  final bool enabled;
  final String url;
  final String method;
  final String headersText;
  final String body;
  final String message;
  final int codeLength;
  final String okMatch;

  List<(String, String)> get headers => parseSmsHeaders(headersText);

  /// پیامک واقعاً کار می‌کند (روشن + پیوند).
  bool get smsReady => enabled && url.isNotEmpty;

  /// آنچه سرورهای مدرسه به برنامه‌ها می‌گویند: تا پنل وصل نشده، صفحهٔ اول نام کاربری/رمز است.
  String get effectivePrimary =>
      primary == 'mobile' && smsReady ? 'mobile' : 'password';

  Map<String, Object?> toJson() => {
    'primary': primary,
    'sms': {
      'enabled': enabled,
      'url': url.trim(),
      'method': method,
      'headers': headersText.trim(),
      'body': method == 'POST' ? body : '',
      'message': message.trim(),
      'code_length': codeLength,
      'ok_match': okMatch,
    },
  };

  /// چرا این تنظیم ذخیره‌شدنی نیست (یا null).
  String? problem({required String rawUrl}) {
    if (rawUrl.trim().isNotEmpty && safeSmsUrl(rawUrl).isEmpty) {
      return 'پیوند پنل پیامک باید با http:// یا https:// شروع شود.';
    }
    if (enabled && url.isEmpty) {
      return 'برای روشن کردن پیامک، پیوند پنل را بنویسید.';
    }
    if (codeLength < 4 || codeLength > 8) {
      return 'طول کد پیامکی باید ۴ تا ۸ رقم باشد.';
    }
    if (method == 'GET' && !'$url$message'.contains('{code}')) {
      // پیوندهای «قالب تأیید» کد را خودشان در متن می‌گذارند؛ بی {code} چیزی نمی‌رسد
      if (!url.contains('{message}')) {
        return 'پیوند باید {code} یا {message} داشته باشد تا کد به کاربر برسد.';
      }
    }
    if (method == 'POST' &&
        !'$url$body$headersText'.contains('{code}') &&
        !'$url$body$headersText'.contains('{message}')) {
      return 'پیوند یا بدنهٔ درخواست باید {code} یا {message} داشته باشد.';
    }
    return null;
  }

  static String _fill(
    String tpl,
    Map<String, String> v,
    String Function(String) enc,
  ) => tpl.replaceAllMapped(
    _placeholder,
    (m) => v.containsKey(m[1]) ? enc(v[m[1]]!) : m[0]!,
  );

  static String _jsonEnc(String s) {
    final j = jsonEncode(s);
    return j.substring(1, j.length - 1);
  }

  /// همان buildRequest سرور (server/sms.js).
  SmsRequest buildRequest(Map<String, String> vals) {
    final all = Map<String, String>.of(vals);
    all['message'] = _fill(message, all, (x) => x);
    final u = _fill(url, all, Uri.encodeComponent);
    final h = <String, String>{
      for (final (k, v) in headers)
        k: _fill(v, all, (x) => x.replaceAll(RegExp(r'[\r\n]'), ' ')),
    };
    String? b;
    if (method == 'POST') {
      final t = body.trim();
      final isJson = t.startsWith('{') || t.startsWith('[');
      b = _fill(body, all, isJson ? _jsonEnc : Uri.encodeComponent);
      if (!h.keys.any((k) => k.toLowerCase() == 'content-type')) {
        h['content-type'] = isJson
            ? 'application/json'
            : 'application/x-www-form-urlencoded';
      }
    }
    return SmsRequest(u, method, h, b);
  }

  /// مقدارهای یک پیامک آزمایشی به [mobile] (۰۹…).
  Map<String, String> testValues(String mobile, {String code = ''}) {
    final c = code.isNotEmpty
        ? code
        : List.filled(codeLength, '1').join().replaceRange(0, 1, '9');
    return {
      'mobile': mobile,
      'mobile98': '98${mobile.substring(1)}',
      'code': c,
      'minutes': '2',
      'school': 'پایش',
    };
  }

  /// پیامک آزمایشی از همین رایانهٔ مالک؛ خطا ⇒ پیام فارسی.
  Future<String> sendTest(String mobileTyped, {SmsSender? sender}) async {
    final m = mobileTyped
        .replaceAllMapped(
          RegExp('[۰-۹]'),
          (x) => '${'۰۱۲۳۴۵۶۷۸۹'.indexOf(x[0]!)}',
        )
        .replaceAll(RegExp('[^0-9]'), '');
    if (!RegExp(r'^09\d{9}$').hasMatch(m)) {
      throw const FormatException('شمارهٔ همراه باید ۱۱ رقم و با ۰۹ باشد');
    }
    if (url.isEmpty) throw const FormatException('پیوند پنل پیامک خالی است');
    final r = buildRequest(testValues(m));
    final (status, text) = await (sender ?? defaultSmsSender)(r);
    final ok =
        status >= 200 &&
        status < 300 &&
        (okMatch.isEmpty || text.contains(okMatch));
    if (!ok) {
      throw FormatException(
        status == 0
            ? 'پنل پیامک پاسخ نداد'
            : 'پنل پیامک نپذیرفت (کد $status)${okMatch.isNotEmpty && status < 300 ? ' — «$okMatch» در پاسخ نبود' : ''}',
      );
    }
    return 'پیامک آزمایشی به $m فرستاده شد (کد $status)';
  }

  AuthSettings copyWith({
    String? primary,
    bool? enabled,
    String? url,
    String? method,
    String? headersText,
    String? body,
    String? message,
    int? codeLength,
    String? okMatch,
  }) => AuthSettings(
    primary: primary ?? this.primary,
    enabled: enabled ?? this.enabled,
    url: url ?? this.url,
    method: method ?? this.method,
    headersText: headersText ?? this.headersText,
    body: body ?? this.body,
    message: message ?? this.message,
    codeLength: codeLength ?? this.codeLength,
    okMatch: okMatch ?? this.okMatch,
  );
}

/// ارسال واقعی با dart:io (۱۵ ثانیه؛ بی‌دنبال کردن تغییر مسیر، مثل سرور).
Future<(int, String)> defaultSmsSender(SmsRequest r) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  try {
    final req = await client
        .openUrl(r.method, Uri.parse(r.url))
        .timeout(const Duration(seconds: 15));
    req.followRedirects = false;
    r.headers.forEach(req.headers.set);
    if (r.body != null) req.add(utf8.encode(r.body!));
    final res = await req.close().timeout(const Duration(seconds: 15));
    final text = await res
        .transform(utf8.decoder)
        .join()
        .timeout(const Duration(seconds: 15));
    return (
      res.statusCode,
      text.length > 4000 ? text.substring(0, 4000) : text,
    );
  } on Object {
    return (0, '');
  } finally {
    client.close(force: true);
  }
}
