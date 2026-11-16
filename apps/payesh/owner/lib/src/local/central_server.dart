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

  /// ردیف ۱۶۵ — همهٔ نشانی‌های عمومی همان سرور (Tailscale، تونل Cloudflare، دستی).
  List<String> publicUrls,
  String? version,
});

/// ردیف ۱۶۵ — «حالت اتصال» که مالک انتخاب می‌کند (همان server/tunnel.js · MODES).
const List<String> connectModes = [
  'auto',
  'cloudflare',
  'tailscale',
  'central',
  'lan',
];

/// محتوای فهرست: سرور مرکزی (اگر تعریف شده)، حالت اتصال و سرورهای اعلام‌شده.
typedef ServersList = ({
  Uri? central,
  List<ListedServer> servers,
  String connectMode,
});

const ServersList _emptyList = (
  central: null,
  servers: <ListedServer>[],
  connectMode: 'auto',
);

/// نوع نشانی عمومی برای نمایش (فقط از روی نام میزبان).
String publicUrlKind(String url) {
  final h = Uri.tryParse(url)?.host ?? '';
  if (h.endsWith('.trycloudflare.com')) return 'cloudflare';
  if (h.endsWith('.ts.net')) return 'tailscale';
  return 'custom';
}

ServersList parseServersList(String? text) {
  if (text == null) return _emptyList;
  final Object? j;
  try {
    j = jsonDecode(text);
  } on FormatException {
    return _emptyList;
  }
  if (j is! Map || j['kind'] != serversListKind) return _emptyList;
  final k = j['connect'];
  final mode = k is Map && connectModes.contains(k['mode'])
      ? k['mode'] as String
      : 'auto';
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
          publicUrls: _httpsList(r['public_urls'], r['public_url']),
          version: r['version'] is String ? r['version'] as String : null,
        ),
  ];
  return (central: central, servers: servers, connectMode: mode);
}

List<String> _httpsList(Object? list, Object? first) {
  final out = <String>[];
  for (final x in [...(list is List ? list : const []), first]) {
    if (x is! String) continue;
    final u = normalizeCentral(x);
    if (u != null && !out.contains(u.toString()) && out.length < 4) {
      out.add(u.toString());
    }
  }
  return out;
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
}) => _editServersList(s, t, now: now, (doc, at) {
  if (url == null) {
    doc.remove('central');
  } else {
    doc['central'] = {'url': url.toString(), 'at': at};
  }
});

/// ردیف ۱۶۵ — «حالت اتصال» را در فهرست می‌گذارد؛ هر سرور پایش ظرف یک دقیقه آن را می‌خواند و
/// تونل‌ها را مطابقش روشن/خاموش می‌کند (server/discovery.js → tunnel.setConnectMode).
Future<void> publishConnectMode(
  S3Settings s,
  S3Transport t,
  String mode, {
  DateTime Function()? now,
}) {
  if (!connectModes.contains(mode)) {
    throw ArgumentError.value(mode, 'mode');
  }
  return _editServersList(s, t, now: now, (doc, at) {
    doc['connect'] = {'mode': mode, 'at': at};
  });
}

Future<void> _editServersList(
  S3Settings s,
  S3Transport t,
  void Function(Map<String, Object?> doc, String at) edit, {
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
  edit(doc, at);
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
