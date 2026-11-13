// سرور کمکی — قرارداد v1 (همان server/helper-jobs.js؛ بردار مشترک:
// docs/cloud/contracts/helper-jobs-vectors.json).
//
// صندوقچهٔ آروان «صندوق نامه» است:
//   payesh/helpers/<helper_id>.json   حضور    kind=payesh-helper
//   payesh/jobs/req/<job_id>.json     درخواست kind=payesh-job
//   payesh/jobs/lease/<job_id>.json   رزرو    kind=payesh-job-lease
//   payesh/jobs/res/<job_id>.json     نتیجه   kind=payesh-job-result
// پاکت = sealBox با نمک "payesh/helper-jobs" (HKDF-SHA256 از Secret صندوقچه + AES-256-GCM،
// AAD = "<kind>/v1/<rev>"). فقط دارندهٔ کلید همان صندوقچه کاری می‌گذارد یا نتیجه می‌نویسد.

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../local/cloud_control.dart';

const String helperSalt = 'payesh/helper-jobs';
const String helperRoot = 'payesh/';

abstract final class HelperKinds {
  static const String presence = 'payesh-helper';
  static const String request = 'payesh-job';
  static const String lease = 'payesh-job-lease';
  static const String result = 'payesh-job-result';
}

abstract final class HelperDirs {
  static const String helpers = 'helpers/';
  static const String req = 'jobs/req/';
  static const String lease = 'jobs/lease/';
  static const String res = 'jobs/res/';
}

/// نوع کارهایی که سرور کمکی انجام می‌دهد — همه «بدون محتوای مدرسه» (D-21).
const List<String> jobKinds = [
  'storage.usage',
  'object.verify',
  'endpoint.check',
  'bucket.gc',
];

const Duration presenceFresh = Duration(seconds: 90);
const Duration presenceEvery = Duration(seconds: 60);
const Duration claimWait = Duration(seconds: 20);
const Duration leaseFor = Duration(seconds: 60);
const Duration leaseRenewEvery = Duration(seconds: 20);
const Duration claimSettle = Duration(milliseconds: 1500);
const Duration jobDeadline = Duration(minutes: 10);
const Duration gcJobAge = Duration(hours: 1);
const Duration gcHelperAge = Duration(days: 7);
const Duration gcBlobAge = Duration(days: 60);

final RegExp helperIdRe = RegExp(r'^[0-9a-f]{16}$');
final RegExp jobIdRe = RegExp(r'^[0-9]{13}-[0-9a-f]{16}$');

String randomHex(int bytes, [Random? rnd]) {
  final r = rnd ?? Random.secure();
  return List.generate(
    bytes,
    (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

String newJobId(DateTime now, [Random? rnd]) =>
    '${now.millisecondsSinceEpoch.toString().padLeft(13, '0')}-${randomHex(8, rnd)}';

int jobIdMillis(String id) => int.parse(id.substring(0, 13));

String nameOfKey(String key) {
  final n = key.split('/').last;
  return n.endsWith('.json') ? n.substring(0, n.length - 5) : n;
}

/// پاکت یک شیء صف/حضور.
Future<String> sealHelper(
  String secret,
  String kind,
  int rev,
  Map<String, Object?> plain, {
  List<int>? nonce,
}) async => jsonEncode(
  await sealBox(
    secret: secret,
    salt: helperSalt,
    kind: kind,
    rev: rev,
    plaintext: jsonEncode(plain),
    nonce: nonce,
  ),
);

/// باز کردن پاکت؛ null اگر نامعتبر/کلید دیگر/دستکاری‌شده باشد.
Future<Map<String, Object?>?> openHelper(
  String secret,
  String kind,
  String text,
) async {
  try {
    final env = jsonDecode(text);
    if (env is! Map<String, Object?>) return null;
    final clear = await openBox(
      secret: secret,
      salt: helperSalt,
      kind: kind,
      env: env,
    );
    final p = jsonDecode(clear);
    if (p is! Map<String, Object?> || p['v'] != 1) return null;
    return p;
  } on Object {
    return null;
  }
}

/// حضور یک سرور کمکی.
final class HelperPresence {
  const HelperPresence({
    required this.helperId,
    required this.host,
    required this.version,
    required this.slots,
    required this.paused,
    required this.kinds,
    required this.at,
    required this.done,
    required this.failed,
  });

  final String helperId;
  final String host;
  final String version;
  final int slots;
  final bool paused;
  final List<String> kinds;
  final DateTime at;
  final int done;
  final int failed;

  bool onlineAt(DateTime now) =>
      !paused &&
      now.difference(at) <= presenceFresh &&
      at.difference(now) <= presenceFresh;

  Map<String, Object?> toPlain() => {
    'v': 1,
    'helper_id': helperId,
    'host': host,
    'app': 'owner-panel',
    'version': version,
    'slots': slots,
    'paused': paused,
    'kinds': kinds,
    'at': at.millisecondsSinceEpoch,
    'done': done,
    'failed': failed,
  };

  static HelperPresence? fromPlain(String id, Map<String, Object?> p) {
    final at = p['at'];
    if (p['helper_id'] != id || at is! int) return null;
    final kinds = p['kinds'];
    return HelperPresence(
      helperId: id,
      host: '${p['host'] ?? ''}'.characters80,
      version: '${p['version'] ?? ''}'.characters40,
      slots: p['slots'] is int ? p['slots']! as int : 1,
      paused: p['paused'] == true,
      kinds: kinds is List
          ? kinds.whereType<String>().where(jobKinds.contains).toList()
          : const [],
      at: DateTime.fromMillisecondsSinceEpoch(at, isUtc: true),
      done: p['done'] is int ? p['done']! as int : 0,
      failed: p['failed'] is int ? p['failed']! as int : 0,
    );
  }
}

extension on String {
  String get characters80 => length > 80 ? substring(0, 80) : this;
  String get characters40 => length > 40 ? substring(0, 40) : this;
}

/// خطای پارامتر یا نوع ناشناخته (دوباره امتحان نمی‌شود).
final class JobRejected implements Exception {
  const JobRejected(this.code, [this.detail = '']);
  final String code;
  final String detail;
  @override
  String toString() => detail.isEmpty ? code : '$code: $detail';
}

/// IP خصوصی/حلقه/محلی ⇒ سرور کمکی هرگز به آن درخواست نمی‌زند.
bool isPublicIp(String ip) {
  final a = InternetAddress.tryParse(ip);
  if (a == null) return false;
  if (a.type == InternetAddressType.IPv4) {
    final b = a.rawAddress;
    if (b[0] == 10 || b[0] == 127 || b[0] == 0 || b[0] >= 224) return false;
    if (b[0] == 169 && b[1] == 254) return false;
    if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return false;
    if (b[0] == 192 && b[1] == 168) return false;
    if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return false;
    return true;
  }
  final b = a.rawAddress;
  final allZeroHead = b.sublist(0, 10).every((x) => x == 0);
  if (allZeroHead && b[10] == 0xff && b[11] == 0xff) {
    return isPublicIp(b.sublist(12).join('.'));
  }
  if (b.every((x) => x == 0)) return false; // ::
  if (b.sublist(0, 15).every((x) => x == 0) && b[15] == 1) return false; // ::1
  if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return false; // fe80::/10
  if ((b[0] & 0xfe) == 0xfc) return false; // fc00::/7
  if (b[0] == 0xff) return false; // multicast
  return true;
}

/// پارامترهای معتبر هر نوع کار (همان validParams سرور).
Map<String, Object?> validJobParams(
  String kind,
  Object? params, {
  String prefix = helperRoot,
}) {
  final p = params is Map
      ? params.cast<String, Object?>()
      : <String, Object?>{};
  switch (kind) {
    case 'storage.usage':
      final pre = p['prefix'] == null ? prefix : '${p['prefix']}';
      if (!pre.startsWith(prefix) || pre.contains('..')) {
        throw const JobRejected('bad_params', 'prefix');
      }
      return {'prefix': pre};
    case 'object.verify':
      final key = '${p['key'] ?? ''}';
      if (!key.startsWith(prefix) || key.contains('..') || key.length > 512) {
        throw const JobRejected('bad_params', 'key');
      }
      final out = <String, Object?>{'key': key};
      if (p['sha256'] != null) {
        if (!RegExp(r'^[0-9a-f]{64}$').hasMatch('${p['sha256']}')) {
          throw const JobRejected('bad_params', 'sha256');
        }
        out['sha256'] = '${p['sha256']}';
      }
      if (p['size'] != null) {
        final s = p['size'];
        if (s is! int || s < 0) throw const JobRejected('bad_params', 'size');
        out['size'] = s;
      }
      return out;
    case 'endpoint.check':
      final u = Uri.tryParse('${p['url'] ?? ''}');
      if (u == null ||
          !(u.scheme == 'https' || u.scheme == 'http') ||
          u.host.isEmpty ||
          u.userInfo.isNotEmpty) {
        throw const JobRejected('bad_params', 'url');
      }
      return {'url': u.toString()};
    case 'bucket.gc':
      return {};
  }
  throw JobRejected('unknown_kind', kind);
}
