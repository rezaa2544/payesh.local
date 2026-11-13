/// مدارس، درخواست ثبت‌نام و اشتراک — سمت پنل مالک (ردیف ۱۴۵ · برگردان p2 · ADR 126 §۱۶).
///
/// قرارداد «schools v1» همان server/school-registry.js است (بردار مشترک:
/// docs/cloud/contracts/schools-vectors.json):
///
//    payesh/schools/registry.json         فهرست مدارس + سیاست اشتراک   (فقط پنل مالک می‌نویسد)
//    payesh/schools/req/<id>.json         درخواست ثبت‌نام مدرسهٔ جدید  (سرور مدرسه)
//    payesh/schools/pay/SUB-XXXXXXXX.json پرداخت اشتراک                 (سرور مدرسه)
//    payesh/schools/ack/<school_id>.json  گزارش سرورِ میزبان مدرسه       (سرور مدرسه)
//    payesh/schools/trial/<key>.json      دفتر «آزمایشی یک بار برای هر دستگاه» (سرور مدرسه)
///
/// پاکت: sealBox با نمک «payesh/schools» (HKDF-SHA256 از Secret صندوقچه + AES-256-GCM).
/// برنامهٔ کاربران هرگز کلید ندارد؛ فقط با سرور مدرسه حرف می‌زند.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart'
    show
        schoolLevels,
        schoolGenders,
        schoolShifts,
        schoolKindsFa,
        schoolTypeDefs,
        capDefs,
        schoolBranches,
        defaultWorkDays;

import '../local/cloud_control.dart';
import '../local/s3_client.dart';
import 'support_inbox.dart';

export 'support_inbox.dart';

// ردیف ۱۵۰: ثابت‌های مشخصات مدرسه به payesh_ui منتقل شد (مشترک با تنظیمات مدیر).
export 'package:payesh_ui/payesh_ui.dart'
    show
        schoolLevels,
        schoolGenders,
        schoolShifts,
        schoolKindsFa,
        schoolTypeDefs,
        capDefs,
        capDefaults,
        capsForType,
        schoolBranches,
        weekDays,
        defaultWorkDays;

const String schoolsSalt = 'payesh/schools';
const String schoolsRoot = 'payesh/';

abstract final class SchoolKinds {
  static const String registry = 'payesh-school-registry';
  static const String request = 'payesh-school-request';
  static const String payment = 'payesh-sub-payment';
  static const String ack = 'payesh-school-ack';
  static const String trial = 'payesh-sub-trial';
}

abstract final class SchoolDirs {
  static const String registry = 'schools/registry.json';
  static const String req = 'schools/req/';
  static const String pay = 'schools/pay/';
  static const String ack = 'schools/ack/';
  static const String trial = 'schools/trial/';
}

/// پلن‌های p2 (SUB_PLANS): هر ماه ۳۰ روز؛ قیمت به ریال.
final class SubPlan {
  const SubPlan(this.key, this.title, this.months, this.price);
  final String key;
  final String title;
  final int months;
  final int price;
}

const List<SubPlan> subPlans = [
  SubPlan('monthly', 'ماهانه', 1, 250000),
  SubPlan('seasonal', 'فصلی', 3, 650000),
  SubPlan('yearly', 'سالانه', 12, 2200000),
];

/// ردیف ۱۴۹: فقط ماهانه (۳۱ روز) و سالانه (تا ۳۱ شهریور) برای هر نقش ارائه می‌شود.
const List<SubPlan> offeredPlans = [
  SubPlan('monthly', 'ماهانه', 1, 250000),
  SubPlan('yearly', 'سالانه', 12, 2200000),
];

const List<String> subRoles = [
  'manager',
  'deputy',
  'teacher',
  'student',
  'parent',
];

const Map<String, String> subRoleTitles = {
  'manager': 'مدیر',
  'deputy': 'معاون',
  'teacher': 'دبیر',
  'student': 'دانش‌آموز',
  'parent': 'ولی',
};

/// پیش‌فرض‌های p2 (SUB_DEFAULTS) + سیاست نقش مالک.
const Map<String, String> defaultRolePolicy = {
  'manager': 'required',
  'deputy': 'free',
  'teacher': 'free',
  'student': 'free',
  'parent': 'required',
};
const int defaultTrialDays = 21;

/// ۳۱ استان کشور (تقسیمات p2: استان ← شهرستان ← منطقه/روستا).
const List<String> iranProvinces = [
  'آذربایجان شرقی',
  'آذربایجان غربی',
  'اردبیل',
  'اصفهان',
  'البرز',
  'ایلام',
  'بوشهر',
  'تهران',
  'چهارمحال و بختیاری',
  'خراسان جنوبی',
  'خراسان رضوی',
  'خراسان شمالی',
  'خوزستان',
  'زنجان',
  'سمنان',
  'سیستان و بلوچستان',
  'فارس',
  'قزوین',
  'قم',
  'کردستان',
  'کرمان',
  'کرمانشاه',
  'کهگیلویه و بویراحمد',
  'گلستان',
  'گیلان',
  'لرستان',
  'مازندران',
  'مرکزی',
  'هرمزگان',
  'همدان',
  'یزد',
];

final RegExp usernameRe = RegExp(r'^[a-z][a-z0-9._-]{2,31}$');
final RegExp requestIdRe = RegExp(r'^[0-9]{13}-[0-9a-f]{16}$');
final RegExp paymentIdRe = RegExp(r'^SUB-[0-9A-F]{8}$');
final RegExp schoolIdRe = RegExp(r'^s-[0-9a-f]{12}$');

/// ارقام فارسی/عربی ← لاتین و حذف هر چیز غیررقمی (همان digitsOnly سرور).
String digitsOnly(Object? v) {
  final s = '${v ?? ''}';
  final b = StringBuffer();
  for (final r in s.runes) {
    if (r >= 0x06F0 && r <= 0x06F9) {
      b.write(r - 0x06F0);
    } else if (r >= 0x0660 && r <= 0x0669) {
      b.write(r - 0x0660);
    } else if (r >= 0x30 && r <= 0x39) {
      b.writeCharCode(r);
    }
  }
  return b.toString();
}

/// اعتبار کد ملی (همان validNationalId سرور/p2).
bool validNationalId(String raw) {
  final s = digitsOnly(raw);
  if (!RegExp(r'^\d{10}$').hasMatch(s) || RegExp(r'^(\d)\1{9}$').hasMatch(s)) {
    return false;
  }
  var sum = 0;
  for (var i = 0; i < 9; i++) {
    sum += int.parse(s[i]) * (10 - i);
  }
  final r = sum % 11;
  final c = int.parse(s[9]);
  return r < 2 ? c == r : c == 11 - r;
}

String _hex(List<int> b) =>
    b.map((v) => v.toRadixString(16).padLeft(2, '0')).join();

/// هش رمز مدیر: `pbkdf2$<iter>$<salt>$<hash>` — نمک همان رشتهٔ hex (بایت‌های UTF-8)،
/// HMAC-SHA256، ۳۲ بایت (همان pbkdf2Hash/verifySecret سرور). در Isolate جدا اجرا می‌شود.
Future<String> pbkdf2Hash(
  String password, {
  int iterations = 150000,
  Random? random,
}) async {
  final rnd = random ?? Random.secure();
  final salt = _hex(List<int>.generate(16, (_) => rnd.nextInt(256)));
  final hash = await pbkdf2Hex(password, salt, iterations);
  return 'pbkdf2\$$iterations\$$salt\$$hash';
}

Future<String> pbkdf2Hex(String password, String salt, int iterations) =>
    Isolate.run(() async {
      final k = await Pbkdf2(
        macAlgorithm: Hmac.sha256(),
        iterations: iterations,
        bits: 256,
      ).deriveKeyFromPassword(password: password, nonce: utf8.encode(salt));
      return _hex(await k.extractBytes());
    });

Future<bool> pbkdf2Verify(String password, String stored) async {
  final p = stored.split('\$');
  if (p.length != 4 || p[0] != 'pbkdf2') return false;
  final it = int.tryParse(p[1]);
  if (it == null || it <= 0) return false;
  return await pbkdf2Hex(password, p[2], it) == p[3];
}

/// پاکت یک شیء قرارداد.
Future<String> sealSchools(
  String secret,
  String kind,
  int rev,
  Map<String, Object?> plain, {
  List<int>? nonce,
}) async => jsonEncode(
  await sealBox(
    secret: secret,
    salt: schoolsSalt,
    kind: kind,
    rev: rev,
    plaintext: jsonEncode(plain),
    nonce: nonce,
  ),
);

/// باز کردن؛ هر خطا ⇒ null.
Future<({int rev, Map<String, Object?> plain})?> openSchools(
  String secret,
  String kind,
  String text,
) async {
  try {
    final env = jsonDecode(text);
    if (env is! Map<String, Object?>) return null;
    final clear = await openBox(
      secret: secret,
      salt: schoolsSalt,
      kind: kind,
      env: env,
    );
    final p = jsonDecode(clear);
    if (p is! Map<String, Object?> || p['v'] != 1) return null;
    return (rev: env['rev']! as int, plain: p);
  } on Object {
    return null;
  }
}

/// سیاست اشتراک با پیش‌فرض‌ها (همان settingsOf سرور) — برای نمایش و ویرایش.
final class SubSettings {
  SubSettings({
    required this.trialEnabled,
    required this.trialDays,
    required this.paywallEnabled,
    required this.roles,
    required this.rolePrices,
    required this.payUrl,
    required this.verifyUrl,
    required this.receiptEnabled,
    required this.receiptNote,
  });

  factory SubSettings.of(Map<String, Object?>? plain) {
    final raw = plain?['settings'];
    final s = raw is Map ? raw.cast<String, Object?>() : <String, Object?>{};
    final roles = Map<String, String>.of(defaultRolePolicy);
    final rr = s['roles'];
    if (rr is Map) {
      for (final e in rr.entries) {
        if (e.value == 'required' || e.value == 'free') {
          roles['${e.key}'] = '${e.value}';
        }
      }
    }
    // ردیف ۱۴۹: قیمت هر نقش (role_plans)؛ وگرنه از فهرست قدیمی plans برای همهٔ نقش‌ها
    final legacy = <String, int?>{};
    final pl = s['plans'];
    if (pl is List && pl.isNotEmpty) {
      for (final p in pl) {
        if (p is Map && offeredPlans.any((d) => d.key == p['key'])) {
          final v = p['price'];
          legacy['${p['key']}'] = v is num && v >= 0 ? v.round() : null;
        }
      }
    } else {
      for (final d in offeredPlans) {
        legacy[d.key] = d.price;
      }
    }
    final rp = s['role_plans'];
    int? priceOf(String role, String plan) {
      if (rp is! Map) return legacy[plan];
      final m = rp[role];
      final v = m is Map ? m[plan] : null;
      return v is num && v >= 0 ? v.round() : null;
    }

    final rolePrices = <String, Map<String, int?>>{
      for (final r in subRoles)
        r: {for (final d in offeredPlans) d.key: priceOf(r, d.key)},
    };
    final days = s['trial_days'];
    final g = s['gateway'] is Map
        ? (s['gateway']! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    return SubSettings(
      trialEnabled: s['trial_enabled'] is bool
          ? s['trial_enabled']! as bool
          : true,
      trialDays: days is int && days >= 0 && days <= 365
          ? days
          : defaultTrialDays,
      paywallEnabled: s['paywall_enabled'] is bool
          ? s['paywall_enabled']! as bool
          : true,
      roles: roles,
      rolePrices: rolePrices,
      payUrl: '${g['pay_url'] ?? ''}',
      verifyUrl: '${g['verify_url'] ?? ''}',
      receiptEnabled: s['receipt_enabled'] is bool
          ? s['receipt_enabled']! as bool
          : true,
      receiptNote: '${s['receipt_note'] ?? ''}',
    );
  }

  bool trialEnabled;
  int trialDays;
  bool paywallEnabled;
  Map<String, String> roles;

  /// نقش ← (پلن ← قیمت به ریال)؛ null یعنی آن پلن برای آن نقش ارائه نمی‌شود.
  Map<String, Map<String, int?>> rolePrices;

  bool offered(String role, String plan) => rolePrices[role]?[plan] != null;
  String payUrl;
  String verifyUrl;
  bool receiptEnabled;
  String receiptNote;

  bool get gatewayConfigured => payUrl.trim().isNotEmpty;

  int? _legacyPrice(String plan) {
    for (final r in ['manager', ...subRoles]) {
      final p = rolePrices[r]?[plan];
      if (p != null) return p;
    }
    return null;
  }

  Map<String, Object?> toJson() => {
    'trial_enabled': trialEnabled,
    'trial_days': trialDays,
    'paywall_enabled': paywallEnabled,
    'roles': roles,
    'role_plans': {
      for (final r in subRoles)
        r: {for (final d in offeredPlans) d.key: rolePrices[r]?[d.key]},
    },
    // سازگاری با سرورهای مدرسهٔ پیش از ردیف ۱۴۹: قیمت مدیر (یا نخستین نقشِ دارای قیمت)
    'plans': [
      for (final d in offeredPlans)
        if (_legacyPrice(d.key) case final int p) {'key': d.key, 'price': p},
    ],
    'gateway': {'pay_url': payUrl.trim(), 'verify_url': verifyUrl.trim()},
    'receipt_enabled': receiptEnabled,
    'receipt_note': receiptNote.trim(),
  };
}

/// نشانی درگاه: فقط http(s)؛ جای‌نگهدارها `{amount}` و … مجازند.
bool validGatewayUrl(String u) {
  final s = u.trim();
  if (s.isEmpty) return true;
  final x = Uri.tryParse(s.replaceAll(RegExp(r'\{[a-z_]+\}'), 'x'));
  return x != null &&
      (x.scheme == 'https' || x.scheme == 'http') &&
      x.host.isNotEmpty;
}

/// خطای یک کار مدارس (پیام فارسی برای نمایش).
final class SchoolsFailure implements Exception {
  const SchoolsFailure(this.code, this.messageFa);
  final String code;
  final String messageFa;
  @override
  String toString() => messageFa;
}

/// آنچه صفحه‌ها نشان می‌دهند.
final class SchoolsView {
  const SchoolsView({
    required this.connected,
    required this.rev,
    required this.plain,
    this.requests = const [],
    this.payments = const [],
    this.acks = const {},
    this.error,
  });

  /// دیتابیس (صندوقچه) تنظیم شده و خواندن موفق بود؟
  final bool connected;
  final int rev;
  final Map<String, Object?> plain;

  /// درخواست‌های ثبت‌نامِ در انتظار (تأییدنشده و ردنشده)، تازه‌ترین اول.
  final List<Map<String, Object?>> requests;

  /// پرداخت‌ها (تازه‌ترین اول)، با `decision` اگر مالک تصمیم گرفته و سرور هنوز اعمال نکرده.
  final List<Map<String, Object?>> payments;

  /// school_id ← گزارش سرور میزبان.
  final Map<String, Map<String, Object?>> acks;
  final String? error;

  List<Map<String, Object?>> get schools => _maps(plain['schools']);
  SubSettings get settings => SubSettings.of(plain);
  String get domain => '${plain['domain'] ?? ''}';
}

List<Map<String, Object?>> _maps(Object? v) => [
  if (v is List)
    for (final e in v)
      if (e is Map) e.cast<String, Object?>(),
];

/// مالکِ فهرست مدارس در صندوقچه.
final class SchoolRegistry {
  SchoolRegistry({
    required this.secure,
    required this.s3Factory,
    DateTime Function()? now,
    Random? random,
    this.hashIterations = 150000,
    this.timeout = const Duration(seconds: 20),
  }) : _now = now ?? DateTime.now,
       _rnd = random ?? Random.secure();

  final SecureStore secure;
  final S3Transport Function() s3Factory;
  final int hashIterations;
  final Duration timeout;
  final DateTime Function() _now;
  final Random _rnd;

  static const String cacheKey = 'owner.schools.registry';

  /// حداکثر پرونده‌ای که از هر پوشه خوانده می‌شود (تازه‌ترین‌ها).
  static const int maxRead = 300;

  Future<void> _queue = Future.value();
  Future<T> _serial<T>(Future<T> Function() f) {
    final c = Completer<T>();
    _queue = _queue.then((_) async {
      try {
        c.complete(await f());
      } on Object catch (e, s) {
        c.completeError(e, s);
      }
    });
    return c.future;
  }

  static Map<String, Object?> emptyPlain() => {
    'v': 1,
    'schools': <Object?>[],
    'settings': <String, Object?>{},
    'domain': '',
    'grants': <Object?>[],
    'decisions': <String, Object?>{},
    'rejected': <Object?>[],
  };

  Future<S3Settings?> _s3() async {
    try {
      final s = await S3Settings.load(secure);
      return s == null || s.bucket.isEmpty ? null : s;
    } on SecureStoreException {
      return null;
    } on FormatException {
      return null;
    }
  }

  Future<({int rev, Map<String, Object?> plain})> _cached() async {
    try {
      final t = await secure.read(cacheKey);
      if (t != null) {
        final j = jsonDecode(t);
        if (j is Map<String, Object?> &&
            j['rev'] is int &&
            j['plain'] is Map<String, Object?>) {
          return (
            rev: j['rev']! as int,
            plain: j['plain']! as Map<String, Object?>,
          );
        }
      }
    } on Object {
      // نسخهٔ صندوقچه معتبر است
    }
    return (rev: 0, plain: emptyPlain());
  }

  Future<void> _saveCache(int rev, Map<String, Object?> plain) async {
    try {
      await secure.write(cacheKey, jsonEncode({'rev': rev, 'plain': plain}));
    } on SecureStoreException {
      // فقط حافظهٔ موقت است
    }
  }

  String _k(String rel) => '$schoolsRoot$rel';

  Future<({int rev, Map<String, Object?> plain})> _pull(
    S3Settings s,
    S3Transport t,
  ) async {
    final local = await _cached();
    final text = await s3GetText(
      s,
      t,
      _k(SchoolDirs.registry),
      now: _now,
    ).timeout(timeout);
    if (text == null) return local;
    final r = await openSchools(s.secretKey, SchoolKinds.registry, text);
    if (r == null) return local;
    final base = emptyPlain()..addAll(r.plain);
    if (r.rev >= local.rev) {
      await _saveCache(r.rev, base);
      return (rev: r.rev, plain: base);
    }
    return local;
  }

  Future<List<({String name, Map<String, Object?> plain})>> _readDir(
    S3Settings s,
    S3Transport t,
    String dir,
    String kind,
  ) async {
    final (objs, _) = await s3ListObjects(
      s,
      t,
      _k(dir),
      now: _now,
    ).timeout(timeout);
    final names =
        [
            for (final o in objs)
              if (o.key.endsWith('.json'))
                o.key.substring(_k(dir).length, o.key.length - 5),
          ]
          ..sort()
          ..removeWhere((n) => n.contains('/'));
    final pick = names.length > maxRead
        ? names.sublist(names.length - maxRead)
        : names;
    final out = <({String name, Map<String, Object?> plain})>[];
    for (final n in pick.reversed) {
      final text = await s3GetText(
        s,
        t,
        '${_k(dir)}$n.json',
        now: _now,
      ).timeout(timeout);
      if (text == null) continue;
      final r = await openSchools(s.secretKey, kind, text);
      if (r != null) out.add((name: n, plain: r.plain));
    }
    return out;
  }

  /// خواندن همه‌چیز از صندوقچه (یا آخرین نسخهٔ همین دستگاه اگر وصل نیست).
  Future<SchoolsView> load() => _serial(() async {
    final s = await _s3();
    if (s == null) {
      final c = await _cached();
      return SchoolsView(
        connected: false,
        rev: c.rev,
        plain: c.plain,
        error: 'دیتابیس در «تنظیمات» وصل نشده است.',
      );
    }
    final t = s3Factory();
    try {
      final reg = await _pull(s, t);
      final reqs = await _readDir(s, t, SchoolDirs.req, SchoolKinds.request);
      final pays = await _readDir(s, t, SchoolDirs.pay, SchoolKinds.payment);
      final acks = await _readDir(s, t, SchoolDirs.ack, SchoolKinds.ack);
      final schools = _maps(reg.plain['schools']);
      final taken = {for (final x in schools) '${x['request_id'] ?? ''}'};
      final rejected = {
        for (final x in _maps(reg.plain['rejected'])) '${x['id'] ?? ''}',
      };
      final dec = reg.plain['decisions'] is Map
          ? (reg.plain['decisions']! as Map).cast<String, Object?>()
          : const <String, Object?>{};
      return SchoolsView(
        connected: true,
        rev: reg.rev,
        plain: reg.plain,
        requests: [
          for (final r in reqs)
            if (requestIdRe.hasMatch(r.name) &&
                r.plain['id'] == r.name &&
                !taken.contains(r.name) &&
                !rejected.contains(r.name))
              r.plain,
        ],
        payments: [
          for (final p in pays)
            if (paymentIdRe.hasMatch(p.name) && p.plain['id'] == p.name)
              {...p.plain, 'decision': ?dec[p.name]},
        ]..sort((a, b) => '${b['created_at']}'.compareTo('${a['created_at']}')),
        acks: {
          for (final a in acks)
            if (a.plain['school_id'] == a.name) a.name: a.plain,
        },
      );
    } on Object catch (e) {
      final c = await _cached();
      return SchoolsView(
        connected: false,
        rev: c.rev,
        plain: c.plain,
        error: e is S3Failure
            ? e.messageFa
            : e is TimeoutException
            ? 'دیتابیس در زمان مقرر پاسخ نداد.'
            : 'اتصال به دیتابیس برقرار نشد.',
      );
    } finally {
      t.close();
    }
  });

  /// تغییر فهرست: آخرین نسخه خوانده، تغییر اعمال و با rev تازه نوشته می‌شود.
  Future<T> _mutate<T>(
    FutureOr<T> Function(Map<String, Object?> plain) change,
  ) => _serial(() async {
    final s = await _s3();
    if (s == null) {
      throw const SchoolsFailure(
        'not_connected',
        'برای این کار دیتابیس باید در «تنظیمات» وصل باشد؛ سرورهای مدرسه فهرست را از همان‌جا می‌خوانند.',
      );
    }
    final t = s3Factory();
    try {
      final cur = await _pull(s, t);
      final plain = jsonDecode(jsonEncode(cur.plain)) as Map<String, Object?>;
      final out = await change(plain);
      final rev = max(_now().millisecondsSinceEpoch, cur.rev + 1);
      await s3PutJson(
        s,
        t,
        _k(SchoolDirs.registry),
        await sealSchools(s.secretKey, SchoolKinds.registry, rev, plain),
        now: _now,
      ).timeout(timeout);
      await _saveCache(rev, plain);
      return out;
    } on SchoolsFailure {
      rethrow;
    } on S3Failure catch (e) {
      throw SchoolsFailure('s3', e.messageFa);
    } on TimeoutException {
      throw const SchoolsFailure('timeout', 'دیتابیس در زمان مقرر پاسخ نداد.');
    } finally {
      t.close();
    }
  });

  // ── ردیف ۱۵۲: صندوق پشتیبانی (تیکت‌های سرورهای مدرسه + پاسخ‌های همین پنل) ──

  String _isoNow() => DateTime.fromMillisecondsSinceEpoch(
    _now().millisecondsSinceEpoch,
    isUtc: true,
  ).toIso8601String();

  static const _supportOff = SchoolsFailure(
    'not_connected',
    'برای دیدن و پاسخ دادن به پیام‌های پشتیبانی، دیتابیس باید در «تنظیمات» وصل باشد.',
  );

  /// همهٔ گفت‌وگوها، تازه‌ترین بالا؛ «باز — منتظر پاسخ» پیش از بقیه.
  Future<List<SupportThread>> loadSupport() => _serial(() async {
    final s = await _s3();
    if (s == null) throw _supportOff;
    final t = s3Factory();
    try {
      final tickets = await _readDir(
        s,
        t,
        SupportDirs.ticket,
        SupportKinds.ticket,
      );
      final replies = {
        for (final r in await _readDir(
          s,
          t,
          SupportDirs.reply,
          SupportKinds.reply,
        ))
          r.name: r.plain,
      };
      final out = [
        for (final x in tickets) ?SupportThread.merge(x.plain, replies[x.name]),
      ];
      out.sort((a, b) {
        final o = (a.needsAnswer ? 0 : 1).compareTo(b.needsAnswer ? 0 : 1);
        return o != 0 ? o : b.updatedAt.compareTo(a.updatedAt);
      });
      return out;
    } on S3Failure catch (e) {
      throw SchoolsFailure('s3', e.messageFa);
    } on TimeoutException {
      throw const SchoolsFailure('timeout', 'دیتابیس در زمان مقرر پاسخ نداد.');
    } finally {
      t.close();
    }
  });

  /// پاسخ مالک (و/یا تغییر وضعیت). پاکت پاسخ تازه از روی آخرین نسخه ساخته می‌شود تا هیچ پاسخی
  /// گم نشود؛ سرور مدرسه در «فهرست» کاربر آن را می‌خواند.
  Future<SupportThread> answerSupport(
    String id, {
    String? text,
    required String status,
  }) => _serial(() async {
    if (!supportIdRe.hasMatch(id)) {
      throw const SchoolsFailure('bad_id', 'شناسهٔ گفت‌وگو درست نیست.');
    }
    if (!supportStatuses.contains(status)) {
      throw const SchoolsFailure('bad_status', 'وضعیت درست نیست.');
    }
    final body = text?.trim() ?? '';
    if (body.length > 2000) {
      throw const SchoolsFailure('bad_text', 'پاسخ حداکثر ۲۰۰۰ نویسه باشد.');
    }
    if (body.isEmpty && status == 'answered') {
      throw const SchoolsFailure('bad_text', 'متن پاسخ را بنویسید.');
    }
    final s = await _s3();
    if (s == null) throw _supportOff;
    final t = s3Factory();
    try {
      final tk = await s3GetText(
        s,
        t,
        _k('${SupportDirs.ticket}$id.json'),
        now: _now,
      ).timeout(timeout);
      final ticket = tk == null
          ? null
          : await openSchools(s.secretKey, SupportKinds.ticket, tk);
      if (ticket == null) {
        throw const SchoolsFailure(
          'not_found',
          'این گفت‌وگو در دیتابیس پیدا نشد.',
        );
      }
      final key = _k('${SupportDirs.reply}$id.json');
      final rp = await s3GetText(s, t, key, now: _now).timeout(timeout);
      final prev = rp == null
          ? null
          : await openSchools(s.secretKey, SupportKinds.reply, rp);
      final cur = SupportThread.merge(ticket.plain, prev?.plain)!;
      final plain = cur.replyPlain(now: _isoNow(), text: body, status: status);
      final rev = max(_now().millisecondsSinceEpoch, (prev?.rev ?? 0) + 1);
      await s3PutJson(
        s,
        t,
        key,
        await sealSchools(s.secretKey, SupportKinds.reply, rev, plain),
        now: _now,
      ).timeout(timeout);
      return SupportThread.merge(ticket.plain, plain)!;
    } on SchoolsFailure {
      rethrow;
    } on S3Failure catch (e) {
      throw SchoolsFailure('s3', e.messageFa);
    } on TimeoutException {
      throw const SchoolsFailure('timeout', 'دیتابیس در زمان مقرر پاسخ نداد.');
    } finally {
      t.close();
    }
  });

  String _newSchoolId() =>
      's-${_hex(List<int>.generate(6, (_) => _rnd.nextInt(256)))}';

  /// اعتبارسنجی p2 «school-save» (نام، کد یکتا، استان/شهرستان، شاخه، مدیر، کد ملی، نام کاربری یکتا).
  static String? validateSchool(
    Map<String, Object?> f,
    List<Map<String, Object?>> schools, {
    String? selfId,
    bool needPassword = false,
    String? password,
  }) {
    String t(String k) => '${f[k] ?? ''}'.trim();
    if (t('name').length < 2 || t('code').isEmpty) {
      return 'نام و کد مدرسه الزامی است';
    }
    if (schools.any((x) => '${x['code']}' == t('code') && x['id'] != selfId)) {
      return 'کد مدرسه تکراری است';
    }
    if (t('province').isEmpty) return 'استان را انتخاب کنید';
    if (t('county').isEmpty) return 'شهرستان را وارد کنید';
    // ردیف ۱۵۰: مقطع را مدیر در «مشخصات مدرسه» تعیین می‌کند؛ اگر آمده باشد (درخواست
    // ثبت‌نام یا مدرسهٔ قدیمی) باید معتبر باشد.
    if (t('level').isNotEmpty && !schoolLevels.contains(t('level'))) {
      return 'مقطع را انتخاب کنید';
    }
    final br = f['branches'];
    if (t('level') == 'متوسطه دوم' && (br is! List || br.isEmpty)) {
      return 'برای متوسطه دوم دست‌کم یک شاخه (نظری، فنی و حرفه‌ای یا کاردانش) انتخاب کنید';
    }
    final m = f['manager'] is Map
        ? (f['manager']! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    final mName = '${m['name'] ?? ''}'.trim();
    final mUser = '${m['username'] ?? ''}'.trim().toLowerCase();
    final nid = digitsOnly(m['national_id']);
    if (mName.length < 3 || mUser.isEmpty) {
      return 'نام مدیر و نام کاربری مدیر الزامی است';
    }
    if (!usernameRe.hasMatch(mUser)) {
      return 'نام کاربری مدیر باید ۳ تا ۳۲ نویسهٔ لاتین کوچک، رقم یا . _ - باشد و با حرف شروع شود';
    }
    if (nid.isNotEmpty && !validNationalId(nid)) {
      return 'کد ملی مدیر معتبر نیست';
    }
    final phone = digitsOnly(m['phone']);
    if (phone.isNotEmpty && !RegExp(r'^09\d{9}$').hasMatch(phone)) {
      return 'شمارهٔ همراه مدیر باید ۱۱ رقم و با ۰۹ شروع شود';
    }
    for (final x in schools) {
      if (x['id'] == selfId) continue;
      final xm = x['manager'] is Map
          ? (x['manager']! as Map).cast<String, Object?>()
          : const <String, Object?>{};
      if ('${xm['username'] ?? ''}'.toLowerCase() == mUser) {
        return 'نام کاربری مدیر تکراری است';
      }
      if (nid.isNotEmpty && digitsOnly(xm['national_id']) == nid) {
        return 'این کد ملی قبلاً برای فرد دیگری ثبت شده است';
      }
    }
    if (needPassword && (password ?? '').length < 6) {
      return 'رمز ورود مدیر دست‌کم ۶ نویسه باشد';
    }
    if (!needPassword && password != null && password.isNotEmpty) {
      if (password.length < 6) return 'رمز ورود مدیر دست‌کم ۶ نویسه باشد';
    }
    return null;
  }

  /// ردیف ۱۵۰: کلیدهایی که مدیر در «مشخصات مدرسه» تعیین می‌کند؛ فرم مالک آن‌ها را
  /// نمی‌فرستد و فقط اگر آمده باشند (درخواست ثبت‌نام/مدرسهٔ قدیمی) نگه داشته می‌شوند.
  static const List<String> managerOwnedKeys = [
    'phone',
    'landline',
    'level',
    'type',
    'school_type',
    'gender',
    'shift',
    'capacity',
    'work_days',
    'excuse_window_minutes',
    'capabilities',
    'branches',
    'fields',
    'boom_goals',
    'public_goals',
    'staff_count',
    'student_count',
  ];

  static Map<String, Object?> _clean(Map<String, Object?> f) => _cleanAll(f)
    ..removeWhere((k, _) => managerOwnedKeys.contains(k) && !f.containsKey(k));

  static Map<String, Object?> _cleanAll(Map<String, Object?> f) {
    String t(String k) => '${f[k] ?? ''}'.trim();
    final m = f['manager'] is Map
        ? (f['manager']! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    final level = t('level');
    final branches = level == 'متوسطه دوم' && f['branches'] is List
        ? [
            for (final b in f['branches']! as List)
              if (schoolBranches.containsKey(b)) '$b',
          ]
        : <String>[];
    final fields = level == 'متوسطه دوم' && f['fields'] is List
        ? [
            for (final x in f['fields']! as List)
              if (branches.any((b) => schoolBranches[b]!.contains(x))) '$x',
          ]
        : <String>[];
    final caps = <String, int>{};
    final rc = f['capabilities'];
    for (final d in capDefs) {
      caps[d.$1] = rc is Map && (rc[d.$1] == 1 || rc[d.$1] == true) ? 1 : 0;
    }
    final type = schoolTypeDefs.any((d) => d.$1 == t('school_type'))
        ? t('school_type')
        : 'governmental';
    final wd = f['work_days'] is List
        ? ([
            for (final d in f['work_days']! as List)
              if (d is int && d >= 0 && d <= 6) d,
          ]..sort())
        : List<int>.of(defaultWorkDays);
    final ex = f['excuse_window_minutes'];
    final cap = f['capacity'];
    return <String, Object?>{
      'name': t('name'),
      'code': t('code'),
      'province': t('province'),
      'county': t('county'),
      'district': t('district'),
      'area_kind': t('area_kind') == 'village' ? 'village' : 'district',
      'phone': digitsOnly(f['phone']),
      'landline': digitsOnly(f['landline']),
      'level': level,
      'type': schoolKindsFa.contains(t('type')) ? t('type') : 'عادی',
      'school_type': type,
      'gender': schoolGenders.contains(t('gender')) ? t('gender') : 'پسرانه',
      'shift': schoolShifts.contains(t('shift')) ? t('shift') : 'صبح',
      'capacity': cap is int && cap > 0 ? cap : 300,
      'work_days': wd,
      'excuse_window_minutes': ex is int && ex >= 0 && ex <= 240 ? ex : 15,
      'capabilities': caps,
      'branches': branches,
      'fields': fields,
      'address': t('address'),
      'boom_goals': t('boom_goals'),
      'public_goals': f['public_goals'] == true || f['public_goals'] == 1,
      'staff_count': f['staff_count'] is int ? f['staff_count'] : null,
      'student_count': f['student_count'] is int ? f['student_count'] : null,
      'manager': <String, Object?>{
        'name': '${m['name'] ?? ''}'.trim(),
        'username': '${m['username'] ?? ''}'.trim().toLowerCase(),
        'national_id': digitsOnly(m['national_id']),
        'phone': digitsOnly(m['phone']),
        'title': 'مدیر مدرسه',
      },
    };
  }

  /// نوع ۱: ساخت دستی مدرسه + حساب مدیر (نام کاربری و رمزی که مالک می‌دهد).
  Future<String> createSchool(
    Map<String, Object?> fields, {
    String? password,
    String? requestId,
    String? passwordHash,
    bool active = true,
  }) async {
    final hash =
        passwordHash ??
        await pbkdf2Hash(password ?? '', iterations: hashIterations);
    return _mutate((plain) {
      final list = _maps(plain['schools']);
      final err = validateSchool(
        fields,
        list,
        needPassword: passwordHash == null,
        password: passwordHash == null ? password : null,
      );
      if (err != null) throw SchoolsFailure('invalid', err);
      if (requestId != null && list.any((x) => x['request_id'] == requestId)) {
        throw const SchoolsFailure(
          'duplicate',
          'این درخواست قبلاً تأیید شده است.',
        );
      }
      final id = _newSchoolId();
      final rec = _clean(fields);
      final m = (rec['manager']! as Map<String, Object?>)
        ..['password_hash'] = hash
        ..['rev'] = 1;
      rec['manager'] = m;
      list.add({
        'id': id,
        ...rec,
        'active': active,
        'request_id': ?requestId,
        'created_at': _now().toUtc().toIso8601String(),
      });
      plain['schools'] = list;
      return id;
    });
  }

  /// ویرایش (p2 «school-save» برای مدرسهٔ موجود)؛ رمز تازه اختیاری.
  Future<void> updateSchool(
    String id,
    Map<String, Object?> fields, {
    String? password,
  }) async {
    final hash = password == null || password.isEmpty
        ? null
        : await pbkdf2Hash(password, iterations: hashIterations);
    await _mutate((plain) {
      final list = _maps(plain['schools']);
      final i = list.indexWhere((x) => x['id'] == id);
      if (i < 0) throw const SchoolsFailure('not_found', 'مدرسه پیدا نشد.');
      final err = validateSchool(fields, list, selfId: id, password: password);
      if (err != null) throw SchoolsFailure('invalid', err);
      final old = list[i];
      final oldM = old['manager'] is Map
          ? (old['manager']! as Map).cast<String, Object?>()
          : <String, Object?>{};
      final rec = _clean(fields);
      final m = rec['manager']! as Map<String, Object?>;
      final userChanged = m['username'] != oldM['username'];
      m['password_hash'] = hash ?? oldM['password_hash'];
      final rev = (oldM['rev'] is int ? oldM['rev']! as int : 1);
      m['rev'] = hash != null || userChanged ? rev + 1 : rev;
      list[i] = {
        ...old,
        ...rec,
        'manager': m,
        'updated_at': _now().toUtc().toIso8601String(),
      };
      plain['schools'] = list;
    });
  }

  /// فعال/غیرفعال (p2: غیرفعال کردن مدرسه ورود را می‌بندد).
  Future<void> setActive(String id, bool active) => _mutate((plain) {
    final list = _maps(plain['schools']);
    final s = list.where((x) => x['id'] == id).firstOrNull;
    if (s == null) throw const SchoolsFailure('not_found', 'مدرسه پیدا نشد.');
    s['active'] = active;
    plain['schools'] = list;
  });

  /// تعیین رمز تازهٔ مدیر.
  Future<void> resetManagerPassword(String id, String password) async {
    if (password.length < 6) {
      throw const SchoolsFailure(
        'invalid',
        'رمز ورود مدیر دست‌کم ۶ نویسه باشد',
      );
    }
    final hash = await pbkdf2Hash(password, iterations: hashIterations);
    await _mutate((plain) {
      final list = _maps(plain['schools']);
      final s = list.where((x) => x['id'] == id).firstOrNull;
      if (s == null) throw const SchoolsFailure('not_found', 'مدرسه پیدا نشد.');
      final m = (s['manager'] as Map?)?.cast<String, Object?>() ?? {};
      m['password_hash'] = hash;
      m['rev'] = (m['rev'] is int ? m['rev']! as int : 1) + 1;
      s['manager'] = m;
      plain['schools'] = list;
    });
  }

  /// حذف از فهرست (سرور میزبان دیگر به آن مدرسه دسترسی نمی‌دهد؛ داده روی همان سرور می‌ماند).
  Future<void> removeSchool(String id) => _mutate((plain) {
    final list = _maps(plain['schools']);
    final n = list.length;
    list.removeWhere((x) => x['id'] == id);
    if (list.length == n) {
      throw const SchoolsFailure('not_found', 'مدرسه پیدا نشد.');
    }
    plain['schools'] = list;
  });

  /// نوع ۲: تأیید درخواست ثبت‌نام ⇒ مدرسه با همان نام کاربری و هش رمزی که مدیر داده ساخته می‌شود.
  Future<String> approveRequest(
    Map<String, Object?> request,
    Map<String, Object?> fields,
  ) {
    final id = '${request['id'] ?? ''}';
    final hash = '${request['password_hash'] ?? ''}';
    if (!requestIdRe.hasMatch(id) || !hash.startsWith('pbkdf2\$')) {
      throw const SchoolsFailure('invalid', 'درخواست معتبر نیست.');
    }
    final m = fields['manager'] is Map
        ? (fields['manager']! as Map).cast<String, Object?>()
        : <String, Object?>{};
    m['username'] = '${request['username'] ?? ''}';
    return createSchool(
      {...fields, 'manager': m},
      passwordHash: hash,
      requestId: id,
    );
  }

  /// ردِ درخواست (دلیل برای متقاضی نمایش داده می‌شود).
  Future<void> rejectRequest(String id, String reason) => _mutate((plain) {
    if (!requestIdRe.hasMatch(id)) {
      throw const SchoolsFailure('invalid', 'درخواست معتبر نیست.');
    }
    final list = _maps(plain['rejected'])
      ..removeWhere((x) => x['id'] == id)
      ..add({
        'id': id,
        'reason': reason.trim(),
        'at': _now().toUtc().toIso8601String(),
      });
    plain['rejected'] = list.length > 2000
        ? list.sublist(list.length - 2000)
        : list;
  });

  /// سیاست اشتراک (نقش‌ها، آزمایشی، پلن‌ها، درگاه، رسید) + کادر دامنه.
  Future<void> saveSettings(SubSettings s, {required String domain}) {
    if (!validGatewayUrl(s.payUrl) || !validGatewayUrl(s.verifyUrl)) {
      throw const SchoolsFailure(
        'invalid',
        'پیوند درگاه باید با http:// یا https:// شروع شود.',
      );
    }
    if (s.trialDays < 0 || s.trialDays > 365) {
      throw const SchoolsFailure(
        'invalid',
        'روزهای آزمایشی باید بین ۰ تا ۳۶۵ باشد.',
      );
    }
    if (s.payUrl.trim().isEmpty && s.verifyUrl.trim().isNotEmpty) {
      throw const SchoolsFailure(
        'invalid',
        'پیوند تأیید بدون پیوند درگاه معنا ندارد.',
      );
    }
    return _mutate((plain) {
      plain['settings'] = s.toJson();
      plain['domain'] = domain.trim();
    });
  }

  /// p2 «🎁 فعال‌سازی» (gift) و «♻️ بازنشانی» (reset) — برای یک کاربر یا یک نقش یا کل مدرسه.
  Future<void> grant(
    String schoolId,
    String kind, {
    int days = 0,
    int? userId,
    String? role,
  }) {
    if (kind != 'gift' && kind != 'reset' && kind != 'cancel') {
      throw const SchoolsFailure('invalid', 'نوع فرمان نامعتبر است.');
    }
    if (kind == 'gift' && (days < 1 || days > 3650)) {
      throw const SchoolsFailure(
        'invalid',
        'تعداد روز هدیه باید بین ۱ تا ۳۶۵۰ باشد.',
      );
    }
    return _mutate((plain) {
      final list = _maps(plain['grants'])
        ..add({
          'id': 'g-${_hex(List<int>.generate(6, (_) => _rnd.nextInt(256)))}',
          'school_id': schoolId,
          'kind': kind,
          if (kind == 'gift') 'days': days,
          'user_id': ?userId,
          'role': ?role,
          'at': _now().toUtc().toIso8601String(),
        });
      plain['grants'] = list.length > 2000
          ? list.sublist(list.length - 2000)
          : list;
    });
  }

  /// تأیید یا رد یک پرداخت (رسید یا درگاهِ بدون پیوند تأیید).
  Future<void> decide(String paymentId, bool approved, {String reason = ''}) =>
      _decision(paymentId, approved ? 'approved' : 'rejected', reason);

  /// ردیف ۱۴۹: لغو پرداختِ تأییدشده — سرور مدرسه اشتراک ساخته‌شده از آن را همین حالا می‌بندد.
  Future<void> cancelPayment(String paymentId, {required String reason}) =>
      _decision(paymentId, 'cancelled', reason);

  Future<void> _decision(String paymentId, String status, String reason) {
    if (!paymentIdRe.hasMatch(paymentId)) {
      throw const SchoolsFailure('invalid', 'شناسهٔ پرداخت نامعتبر است.');
    }
    return _mutate((plain) {
      final d = plain['decisions'] is Map
          ? (plain['decisions']! as Map).cast<String, Object?>()
          : <String, Object?>{};
      d[paymentId] = {
        'status': status,
        if (status != 'approved') 'reason': reason.trim(),
        'at': _now().toUtc().toIso8601String(),
      };
      plain['decisions'] = d;
    });
  }
}
