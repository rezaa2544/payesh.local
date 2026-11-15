// ردیف ۱۶۴ — «سرور مرکزی»: نشانی عمومی‌ای که همهٔ برنامه‌ها (مدیر، معلم، دانش‌آموز، اولیا) از هر
// اینترنتی از راه آن به همان یک دیتابیس پایش می‌رسند. دادهٔ هر مدرسه در بخش جدای خودش در همین
// دیتابیس است؛ هیچ مدرسه‌ای دیتابیس جدا ندارد.
//
// پنل مالک نشانی را در فهرست «فقط نشانی» همان دیتابیس می‌گذارد
// (`payesh/pub/school-servers.json`، فیلد بالایی `central`، خواندن عمومی، بدون هیچ رازی)؛
// برنامهٔ کاربران (payesh_sync/school_finder.dart) آن را پیش از هر نشانی دیگری امتحان می‌کند و
// سرورهای پایش هنگام تازه کردن ردیف خودشان (server/discovery.js) آن را دست نمی‌زنند.

import 'dart:convert';

import 'cloud_control.dart';
import 's3_client.dart';

/// کلید فهرست نشانی‌ها در دیتابیس (همان server/discovery.js · REL).
const String serversListKey = '${controlPrefix}pub/school-servers.json';
const String serversListKind = 'payesh-school-servers';

/// نشانی سرور مرکزی باید https و بدون مسیر/پرسش/کاربر باشد (برنامه‌ها رمز را فقط روی https
/// می‌فرستند). خروجی همان مبدأ (scheme://host[:port]) است؛ null یعنی نامعتبر.
Uri? normalizeCentral(String raw) {
  final t = raw.trim();
  if (t.isEmpty || t.length > 300) return null;
  final u = Uri.tryParse(t);
  if (u == null ||
      u.scheme != 'https' ||
      u.host.isEmpty ||
      u.userInfo.isNotEmpty ||
      u.hasQuery ||
      u.hasFragment ||
      (u.path.isNotEmpty && u.path != '/')) {
    return null;
  }
  return Uri(scheme: 'https', host: u.host.toLowerCase(), port: u.port);
}

/// یک ردیف فهرست (سرور پایشی که خودش را اعلام کرده).
typedef ListedServer = ({
  String instance,
  String? school,
  String? publicUrl,
  int lan,
  String at,
});

/// محتوای فهرست: سرور مرکزی (اگر تعریف شده) و سرورهای اعلام‌شده.
typedef ServersList = ({Uri? central, List<ListedServer> servers});

ServersList parseServersList(String? text) {
  if (text == null) return (central: null, servers: const []);
  final Object? j;
  try {
    j = jsonDecode(text);
  } on FormatException {
    return (central: null, servers: const []);
  }
  if (j is! Map || j['kind'] != serversListKind) {
    return (central: null, servers: const []);
  }
  final c = j['central'];
  final central = c is Map && c['url'] is String
      ? normalizeCentral(c['url'] as String)
      : null;
  final servers = <ListedServer>[
    for (final r in (j['servers'] is List ? j['servers'] as List : const []))
      if (r is Map && r['instance'] is String)
        (
          instance: r['instance'] as String,
          school: r['school'] is String ? r['school'] as String : null,
          publicUrl: r['public_url'] is String
              ? r['public_url'] as String
              : null,
          lan: r['lan'] is List ? (r['lan'] as List).length : 0,
          at: r['at'] is String ? r['at'] as String : '',
        ),
  ];
  return (central: central, servers: servers);
}

Future<ServersList> readServersList(
  S3Settings s,
  S3Transport t, {
  DateTime Function()? now,
}) async => parseServersList(await s3GetText(s, t, serversListKey, now: now));

/// سرور مرکزی را در فهرست می‌گذارد ([url] null ⇒ برمی‌دارد). ردیف سرورها دست نمی‌خورد.
Future<void> publishCentral(
  S3Settings s,
  S3Transport t,
  Uri? url, {
  DateTime Function()? now,
}) async {
  final at = (now ?? DateTime.now)().toUtc().toIso8601String();
  Map<String, Object?> doc;
  try {
    final text = await s3GetText(s, t, serversListKey, now: now);
    final j = text == null ? null : jsonDecode(text);
    doc = j is Map<String, Object?> && j['kind'] == serversListKind
        ? j
        : <String, Object?>{};
  } on FormatException {
    doc = <String, Object?>{};
  }
  doc
    ..['v'] = 1
    ..['kind'] = serversListKind
    ..['servers'] = doc['servers'] is List ? doc['servers'] : <Object?>[]
    ..['at'] = doc['at'] ?? at;
  if (url == null) {
    doc.remove('central');
  } else {
    doc['central'] = {'url': url.toString(), 'at': at};
  }
  await s3PutJson(
    s,
    t,
    serversListKey,
    jsonEncode(doc),
    now: now,
    headers: const {
      'x-amz-acl': 'public-read',
      'cache-control': 'no-cache, max-age=0',
    },
  );
}
