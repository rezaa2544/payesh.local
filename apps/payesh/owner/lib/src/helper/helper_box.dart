// سرور کمکی — قرارداد v1 (همان server/helper-jobs.js؛ بردار مشترک:
// docs/cloud/contracts/helper-jobs-vectors.json).
//
// صندوقچهٔ آروان «صندوق نامه» است:
//   payesh/helpers/<helper_id>.json   حضور    kind=payesh-helper
//   payesh/jobs/req/<job_id>.json     درخواست kind=payesh-job
//   payesh/jobs/lease/<job_id>.json   رزرو    kind=payesh-job-lease
//   payesh/jobs/res/<job_id>.json     نتیجه   kind=payesh-job-result
//   payesh/control/infra-policy.json  سیاست   kind=payesh-infra-policy (ردیف ۱۳۱)
// پاکت = sealBox با نمک "payesh/helper-jobs" (HKDF-SHA256 از Secret صندوقچه + AES-256-GCM،
// AAD = "<kind>/v1/<rev>"). فقط دارندهٔ کلید همان صندوقچه کاری می‌گذارد یا نتیجه می‌نویسد.

import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'package:payesh_core/io.dart';

import '../local/cloud_control.dart';

const String helperSalt = 'payesh/helper-jobs';
const String helperRoot = 'payesh/';

abstract final class HelperKinds {
  static const String presence = 'payesh-helper';
  static const String request = 'payesh-job';
  static const String lease = 'payesh-job-lease';
  static const String result = 'payesh-job-result';

  /// ردیف ۲۰۹ — نشان ابطال توکن مدرسه (مالک می‌نویسد؛ کلید صندوقچه لازم دارد).
  static const String schoolTokenRevoked = 'payesh-school-token-revoked';

  /// سیاست زیرساخت که پنل مالک می‌نویسد (ردیف ۱۳۱؛ `infra/infra_policy.dart`).
  static const String policy = 'payesh-infra-policy';
}

abstract final class HelperDirs {
  static const String helpers = 'helpers/';
  static const String req = 'jobs/req/';
  static const String lease = 'jobs/lease/';
  static const String res = 'jobs/res/';

  /// ردیف ۲۰۹ — یک فایل برای هر مدرسهٔ باطل‌شده: `helpers/revoked/SCHOOL_ID.json`
  static const String revoked = 'helpers/revoked/';
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

/// ردیف ۲۱۳: سقف فاصلهٔ خواندن صف در بیکاری (زیر [claimWait]) — بیشتر از این، «آنلاین» بودن
/// سودی ندارد چون کار پیش از پایان پنجرهٔ برداشت دیده نمی‌شود (همان IDLE_POLL_CAP_MS در Node).
const Duration idlePollCap = Duration(seconds: 15);

/// حضور قدیمی (بی poll_ms): پله‌های بیکاری پیش از ۲۱۳ تا ۳۰ ثانیه بود.
const Duration legacyPollEvery = Duration(seconds: 30);

/// حاشیهٔ برداشت پس از خواندن صف (settle + jitter + رفت‌وبرگشت) — CLAIM_MARGIN_MS در Node.
const Duration claimMargin = Duration(seconds: 5);
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
    if (p is! Map<String, Object?> || (p['v'] != 1 && p['v'] != 2)) return null;
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
    this.pollMs,
    this.nextPollAt,
    this.accepting = true,
    this.cls = 'owner',
    this.caps = const [],
    this.schoolId,
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

  /// ردیف ۲۱۳: بیشترین فاصلهٔ دو خواندن صف (null = حضور قدیمی).
  final int? pollMs;

  /// زمان تقریبی خواندن بعدی صف (ms از epoch؛ برای cron).
  final int? nextPollAt;

  /// false ⇒ صف را نمی‌خواند (پردازش کمکی خاموش/متوقف).
  final bool accepting;

  /// بدترین حالتِ «تا خواندن بعدی صف» — همان pollEta در server/helper-v2.js.
  /// null ⇒ این سیستم صف را نمی‌خواند.
  Duration? pollEtaAt(DateTime now) {
    if (!accepting || paused) return null;
    final period = pollMs ?? legacyPollEvery.inMilliseconds;
    final next = nextPollAt;
    final n = now.millisecondsSinceEpoch;
    if (next != null && next >= n && next - n <= period) {
      return Duration(milliseconds: next - n);
    }
    return Duration(milliseconds: period);
  }

  bool onlineAt(DateTime now) =>
      !paused &&
      now.difference(at) <= presenceFresh &&
      at.difference(now) <= presenceFresh;

  // Row 205/209/210 (v2, additive): executor class + capabilities + school id.
  // v1 presence has none of these: cls=owner, caps=kinds, schoolId=null
  // (same defaults as server/helper-v2.js normalizePresence).
  final String cls;
  final List<String> caps;
  final String? schoolId;

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
    if (pollMs != null) 'poll_ms': pollMs,
    if (nextPollAt != null) 'next_poll_at': nextPollAt,
    if (pollMs != null || !accepting) 'accepting': accepting,
  };

  static HelperPresence? fromPlain(String id, Map<String, Object?> p) {
    final at = p['at'];
    if (p['helper_id'] != id || at is! int) return null;
    final kinds = p['kinds'];
    final kindList = kinds is List
        ? kinds.whereType<String>().where(jobKinds.contains).toList()
        : const <String>[];
    final capsRaw = p['caps'];
    final capList = capsRaw is List
        ? capsRaw.whereType<String>().take(32).toList()
        : kindList;
    const classes = ['owner', 'school', 'cloudflare', 'actions'];
    final clsRaw = p['cls'];
    final sidRaw = p['school_id'];
    return HelperPresence(
      helperId: id,
      host: '${p['host'] ?? ''}'.characters80,
      version: '${p['version'] ?? ''}'.characters40,
      slots: p['slots'] is int ? p['slots']! as int : 1,
      paused: p['paused'] == true,
      kinds: kindList,
      at: DateTime.fromMillisecondsSinceEpoch(at, isUtc: true),
      done: p['done'] is int ? p['done']! as int : 0,
      failed: p['failed'] is int ? p['failed']! as int : 0,
      cls: clsRaw is String && classes.contains(clsRaw) ? clsRaw : 'owner',
      caps: capList.isEmpty ? kindList : capList,
      schoolId: sidRaw is String && schoolIdRe.hasMatch(sidRaw) ? sidRaw : null,
      pollMs: _pollMsOf(p['poll_ms']),
      nextPollAt: p['next_poll_at'] is int ? p['next_poll_at']! as int : null,
      accepting: p['accepting'] != false,
    );
  }
}

int? _pollMsOf(Object? v) =>
    v is int && v >= 1000 && v <= 24 * 3600 * 1000 ? v : null;

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

/// Row 209 — school helper token: school_id + '.' + b64u(HMAC-SHA256(secret,
/// 'payesh/school-helper:SCHOOL_ID')) — identical to server/helper-v2.js.
/// The bucket secret itself is never given to a school; the owner issues
/// this derived token per school and can revoke by rotating/revoking.
String schoolHelperToken(String secret, String schoolId) {
  final mac = Hmac(
    sha256,
    utf8.encode(secret),
  ).convert(utf8.encode('payesh/school-helper:$schoolId'));
  final b = base64Url.encode(mac.bytes).replaceAll('=', '');
  return '$schoolId.$b';
}

/// شناسهٔ معتبر مدرسه (همان SCHOOL_ID_RE در server/helper-v2.js).
final RegExp schoolIdRe = RegExp(r'^[a-z0-9][a-z0-9_-]{1,62}$');

bool verifySchoolHelperToken(String secret, String token) {
  final i = token.lastIndexOf('.');
  if (i <= 0) return false;
  final id = token.substring(0, i);
  if (!schoolIdRe.hasMatch(id)) return false;
  final want = schoolHelperToken(secret, id);
  if (want.length != token.length) return false;
  var diff = 0;
  for (var j = 0; j < want.length; j++) {
    diff |= want.codeUnitAt(j) ^ token.codeUnitAt(j);
  }
  return diff == 0;
}

/// ردیف ۲۱۰ — وضعیت صف کارها برای نمای یکپارچهٔ پنل (فقط شمارش؛ بدون محتوا).
/// هم‌معنای queueStatus در server/helper-jobs.js است.
final class HelperQueueStatus {
  const HelperQueueStatus({
    required this.pending,
    required this.leased,
    required this.done,
    required this.stuck,
    required this.at,
  });

  final int pending;
  final int leased;
  final int done;
  final int stuck;
  final DateTime at;
}

/// شمارش خالص از روی کلیدهای صندوقچه: [keys] کلیدهای زیر jobs/،
/// [leaseUntilMs] مهلت اجارهٔ هر کار (از پاکت lease؛ نبودش یعنی نامشخص)،
/// و [now] لحظهٔ شمارش. کاری «گیرکرده» است که اجاره‌اش گذشته و نتیجه ندارد.
HelperQueueStatus queueStatusFromKeys(
  Iterable<String> keys, {
  Map<String, int> leaseUntilMs = const {},
  required DateTime now,
}) {
  final resIds = <String>{};
  final reqIds = <String>{};
  final leaseIds = <String>{};
  for (final k in keys) {
    final id = nameOfKey(k);
    if (k.contains('/res/')) {
      resIds.add(id);
    } else if (k.contains('/req/')) {
      reqIds.add(id);
    } else if (k.contains('/lease/')) {
      leaseIds.add(id);
    }
  }
  var stuck = 0;
  for (final id in leaseIds) {
    final until = leaseUntilMs[id];
    if (until != null &&
        until < now.millisecondsSinceEpoch &&
        !resIds.contains(id)) {
      stuck++;
    }
  }
  var pending = 0;
  for (final id in reqIds) {
    if (!resIds.contains(id) && !leaseIds.contains(id)) pending++;
  }
  return HelperQueueStatus(
    pending: pending,
    leased: leaseIds.length,
    done: resIds.length,
    stuck: stuck,
    at: now,
  );
}

/// ردیف ۲۰۹ — متن داخل پاکت «ابطال توکن مدرسه» و خواندنش.
Map<String, Object?> schoolTokenRevokedPlain(String schoolId, DateTime at) => {
  'v': 1,
  'school_id': schoolId,
  'revoked_at': at.millisecondsSinceEpoch,
};

String? schoolIdFromRevokedPlain(Map<String, Object?>? p) {
  if (p == null) return null;
  final id = p['school_id'];
  return id is String && schoolIdRe.hasMatch(id) ? id : null;
}
