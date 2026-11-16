import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;
import 'package:payesh_secure/payesh_secure.dart' show SecureStore;

import 'lan_access.dart';

/// Row 145 — «درخواست ثبت نام مدرسه جدید» و اشتراک (برگردان p2) در برنامهٔ کاربران.
///
/// برنامهٔ کاربران هرگز کلید صندوقچه را ندارد: درخواست ثبت‌نام، وضعیت آن، دورهٔ آزمایشی،
/// پرداخت از درگاه و ثبت رسید همه از راه سرور مدرسه می‌روند (server → دیتابیس → پنل مالک):
///   POST /api/schools/register            (عمومی)
///   GET  /api/schools/register/status     (عمومی، با id + token همان درخواست)
///   GET  /api/sub/status · POST /api/sub/trial · POST /api/sub/pay · POST /api/sub/receipt
///
/// شناسهٔ دستگاه: شناسهٔ سخت‌افزاری/سیستمی (Android: ANDROID_ID، Windows: MachineGuid،
/// Linux: machine-id) که با حذف و نصب دوبارهٔ برنامه عوض نمی‌شود؛ فقط درهم‌سازی‌شدهٔ آن
/// (SHA-256) فرستاده می‌شود و سرور دوباره آن را درهم می‌کند — «آزمایشی فقط یک بار برای هر دستگاه».

/// مقطع‌ها (p2؛ همان LEVELS سرور).
const List<String> signupLevels = ['ابتدایی', 'متوسطه اول', 'متوسطه دوم'];

/// ۳۱ استان کشور (همان فهرست فرم مدرسهٔ پنل مالک).
const List<String> signupProvinces = [
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

String _latin(String s) {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  final b = StringBuffer();
  for (final r in s.runes) {
    final ch = String.fromCharCode(r);
    final i = fa.indexOf(ch);
    final j = ar.indexOf(ch);
    b.write(i >= 0 ? '$i' : (j >= 0 ? '$j' : ch));
  }
  return b.toString();
}

/// درهم‌سازی شناسهٔ دستگاه (۶۴ رقم hex؛ همان DEV_RE سرور). null ⇒ شناسه در دسترس نیست.
String? deviceHashOf(String? rawId) {
  final id = rawId?.trim() ?? '';
  if (id.isEmpty) return null;
  return sha256.convert(utf8.encode('payesh-device/v1:$id')).toString();
}

/// فرم «درخواست ثبت نام مدرسه جدید».
final class SchoolSignup {
  const SchoolSignup({
    required this.schoolName,
    required this.level,
    required this.province,
    required this.county,
    this.village = '',
    required this.phone,
    required this.staffCount,
    required this.studentCount,
    required this.managerName,
    required this.username,
    required this.password,
  });
  final String schoolName;
  final String level;
  final String province;
  final String county;
  final String village;
  final String phone;
  final String staffCount;
  final String studentCount;
  final String managerName;
  final String username;
  final String password;

  String get normalizedPhone => _latin(phone).replaceAll(RegExp('[^0-9]'), '');
  String get normalizedUsername => LanServerRules.normalizeLogin(username);
  int? _count(String v) {
    final d = _latin(v).trim();
    return RegExp(r'^[0-9]{1,9}$').hasMatch(d) ? int.parse(d) : null;
  }

  /// همان قواعد سرور (validRequest) برای همهٔ کادرها: «نام کادر ← پیام» (ردیف ۱۶۶: هر کادر نادرست
  /// قاب قرمز می‌گیرد). کلیدها همان کلیدهای فرم درخواست‌اند (signup-<کلید>).
  Map<String, String> problems() {
    final out = <String, String>{};
    final n = schoolName.trim().length;
    if (n < 2 || n > 120) out['school'] = 'نام مدرسه را بنویسید';
    if (!signupLevels.contains(level)) out['level'] = 'مقطع را انتخاب کنید';
    if (province.trim().length < 2) out['province'] = 'استان را انتخاب کنید';
    final c = county.trim().length;
    if (c < 2 || c > 60) out['county'] = 'شهرستان را انتخاب کنید';
    if (village.trim().length > 60) out['village'] = 'نام روستا/منطقه طولانی است';
    if (!RegExp(r'^0\d{10}$').hasMatch(normalizedPhone)) {
      out['phone'] =
          'شمارهٔ تلفن را کامل و ۱۱ رقمی بنویسید (مثلاً ۰۹۱۲۱۲۳۴۵۶۷)';
    }
    final st = _count(staffCount);
    if (st == null || st > 10000) out['staff'] = 'تعداد کارکنان را درست بنویسید';
    // ردیف ۱۶۶: تعداد دانش‌آموزان سقف ندارد (فقط عدد درست)
    if (_count(studentCount) == null) {
      out['students'] = 'تعداد دانش‌آموزان را درست بنویسید';
    }
    final m = managerName.trim().length;
    if (m < 3 || m > 80) out['manager'] = 'نام و نام خانوادگی مدیر را بنویسید';
    if (!LanServerRules.usernameRe.hasMatch(normalizedUsername)) {
      out['username'] = LanServerRules.usernameRuleFa;
    }
    if (password.length < 6) out['password'] = 'رمز عبور دست‌کم ۶ نویسه باشد';
    return out;
  }

  /// همان قواعد سرور (validRequest)؛ پیام فارسیِ نخستین ایراد یا null.
  String? validate() {
    final p = problems();
    return p.isEmpty ? null : p.values.first;
  }

  /// کادرِ کد خطای سرور (`bad_<کلید>` / `username_taken`)، یا null.
  /// Row 166: the form field a refused request is about (red outline), or null.
  static String? fieldOfFailure(LanAccessFailure f) => fieldOfError(f.wire);

  static String? fieldOfError(String? code) => switch (code) {
    'bad_school_name' => 'school',
    'bad_level' => 'level',
    'bad_province' => 'province',
    'bad_county' => 'county',
    'bad_village' => 'village',
    'bad_phone' => 'phone',
    'bad_staff_count' => 'staff',
    'bad_student_count' => 'students',
    'bad_manager_name' => 'manager',
    'bad_username' || 'username_taken' => 'username',
    'bad_password' => 'password',
    _ => null,
  };

  Map<String, Object?> toJson({String? deviceHash}) => {
    'school_name': schoolName.trim(),
    'level': level,
    'province': province.trim(),
    'county': county.trim(),
    'village': village.trim(),
    'phone': normalizedPhone,
    'staff_count': _count(staffCount),
    'student_count': _count(studentCount),
    'manager_name': managerName.trim(),
    'username': normalizedUsername,
    'password': password,
    'device_hash': ?deviceHash,
  };
}

/// رسید درخواست ثبت‌شده (روی همین دستگاه، در انبار امن) برای پیگیری وضعیت.
final class SignupTicket {
  const SignupTicket({
    required this.server,
    required this.id,
    required this.token,
    required this.schoolName,
    required this.username,
    required this.at,
  });
  final Uri server;
  final String id;
  final String token;
  final String schoolName;
  final String username;
  final DateTime at;

  Map<String, Object?> toJson() => {
    'server': server.toString(),
    'id': id,
    'token': token,
    'school_name': schoolName,
    'username': username,
    'at': at.toUtc().toIso8601String(),
  };

  static SignupTicket? fromJson(Object? j) {
    if (j is! Map) return null;
    final server = Uri.tryParse('${j['server']}');
    final at = DateTime.tryParse('${j['at']}');
    if (server == null ||
        !LanServerRules.allowed(server) ||
        j['id'] is! String ||
        j['token'] is! String ||
        at == null) {
      return null;
    }
    return SignupTicket(
      server: server,
      id: j['id']! as String,
      token: j['token']! as String,
      schoolName: '${j['school_name'] ?? ''}',
      username: '${j['username'] ?? ''}',
      at: at,
    );
  }
}

/// انبار رسید درخواست (جدا از حساب LAN؛ با «خروج» پاک نمی‌شود تا پیگیری ممکن بماند).
final class SignupStore {
  const SignupStore(this.store);
  final SecureStore store;
  static const String key = 'lan.signup';

  Future<SignupTicket?> load() async {
    final t = await store.read(key);
    if (t == null || t.isEmpty) return null;
    try {
      return SignupTicket.fromJson(jsonDecode(t));
    } on FormatException {
      return null;
    }
  }

  Future<void> save(SignupTicket t) => store.write(key, jsonEncode(t.toJson()));
  Future<void> clear() => store.delete(key);
}

/// وضعیت درخواست: pending | approved | rejected | inactive.
final class SignupStatus {
  const SignupStatus(this.status, {this.school, this.username, this.reason});
  final String status;
  final String? school;
  final String? username;
  final String? reason;

  bool get approved => status == 'approved';

  String get titleFa => switch (status) {
    'approved' => 'تأیید شد',
    'rejected' => 'رد شد',
    'inactive' => 'تأیید شد، ولی مدرسه غیرفعال است',
    _ => 'در انتظار بررسی پشتیبانی پایش',
  };
}

/// یک پلن اشتراک (p2: ماهانه/فصلی/سالانه).
final class SubPlanOffer {
  const SubPlanOffer(this.key, this.price);
  final String key;
  final int price;

  String get titleFa => switch (key) {
    'monthly' => 'ماهانه',
    'seasonal' => 'فصلی',
    'yearly' => 'سالانه',
    _ => key,
  };

  int get months => switch (key) {
    'monthly' => 1,
    'seasonal' => 3,
    'yearly' => 12,
    _ => 1,
  };
}

/// پرداخت در انتظار تأیید.
final class SubPayment {
  const SubPayment({
    required this.id,
    required this.plan,
    required this.amount,
    required this.method,
    required this.status,
    this.ref,
  });
  final String id;
  final String plan;
  final int amount;
  final String method;
  final String status;
  final String? ref;

  static SubPayment? fromJson(Object? j) {
    if (j is! Map || j['id'] is! String) return null;
    return SubPayment(
      id: j['id']! as String,
      plan: '${j['plan'] ?? ''}',
      amount: j['amount'] is num ? (j['amount']! as num).round() : 0,
      method: '${j['method'] ?? ''}',
      status: '${j['status'] ?? ''}',
      ref: j['ref'] as String?,
    );
  }
}

/// پاسخ `/api/sub/status` (همان gate() سرور).
final class SubStatus {
  const SubStatus({
    required this.managed,
    required this.access,
    required this.status,
    this.role,
    this.policy,
    this.school,
    this.plans = const [],
    this.trialDays = 0,
    this.trialAvailable = false,
    this.gateway = false,
    this.receipt = false,
    this.receiptNote = '',
    this.plan,
    this.end,
    this.daysLeft = 0,
    this.pending = const [],
    this.renewWarning = false,
    this.yearEnd,
  });
  final bool managed;
  final bool access;

  /// free | trial | active | expired | cancelled | none | school_inactive | school_removed
  final String status;
  final String? role;
  final String? policy;
  final String? school;
  final List<SubPlanOffer> plans;
  final int trialDays;
  final bool trialAvailable;
  final bool gateway;
  final bool receipt;
  final String receiptNote;
  final String? plan;
  final DateTime? end;
  final int daysLeft;
  final List<SubPayment> pending;

  /// ردیف ۱۴۹: از ۱ تیر، مدیری که اشتراک سال بعد را نخریده هشدار تمدید می‌بیند.
  final bool renewWarning;

  /// پایان سال تحصیلی جاری (۳۱ شهریور) — همهٔ اشتراک‌ها آن‌جا تمام می‌شوند.
  final DateTime? yearEnd;

  bool get blockedSchool =>
      status == 'school_inactive' || status == 'school_removed';

  static SubStatus fromJson(Map<String, Object?> j) {
    final sub = j['sub'] is Map
        ? (j['sub']! as Map).cast<String, Object?>()
        : j;
    int n(Object? v) => v is num ? v.round() : 0;
    return SubStatus(
      managed: sub['managed'] == true,
      access: sub['access'] != false,
      status: '${sub['status'] ?? 'free'}',
      role: sub['role'] as String?,
      policy: sub['policy'] as String?,
      school: sub['school'] as String?,
      plans: [
        if (sub['plans'] is List)
          for (final p in sub['plans']! as List)
            if (p is Map && p['key'] is String && p['price'] is num)
              SubPlanOffer(p['key']! as String, (p['price']! as num).round()),
      ],
      trialDays: n(sub['trial_days']),
      trialAvailable: sub['trial_available'] == true,
      gateway: sub['gateway'] == true,
      receipt: sub['receipt'] == true,
      receiptNote: '${sub['receipt_note'] ?? ''}',
      plan: sub['plan'] as String?,
      end: DateTime.tryParse('${sub['end']}'),
      daysLeft: n(sub['days_left']),
      renewWarning: sub['renew_warning'] == true,
      yearEnd: DateTime.tryParse('${sub['year_end']}'),
      pending: [
        if (sub['pending'] is List)
          for (final p in sub['pending']! as List) ?SubPayment.fromJson(p),
      ],
    );
  }
}

/// پیام فارسی خطاهای ثبت‌نام/اشتراک (رشتهٔ `error` سرور).
String schoolsErrorFa(LanAccessFailure e) => switch (e.wire) {
  'username_taken' =>
    'این نام کاربری قبلاً گرفته شده است — نام کاربری دیگری انتخاب کنید',
  'not_connected' =>
    'این سرور هنوز به دیتابیس پایش وصل نیست — درخواست ثبت نمی‌شود',
  'registry_unreachable' =>
    'دیتابیس پایش در دسترس نیست — کمی بعد دوباره امتحان کنید',
  'bad_school_name' => 'نام مدرسه را بنویسید',
  'bad_level' => 'مقطع را انتخاب کنید',
  'bad_province' => 'استان را انتخاب کنید',
  'bad_county' => 'شهرستان را انتخاب کنید',
  'bad_village' => 'نام روستا/منطقه طولانی است',
  'bad_phone' => 'شمارهٔ تلفن را کامل و ۱۱ رقمی بنویسید',
  'bad_staff_count' => 'تعداد کارکنان را درست بنویسید',
  'bad_student_count' => 'تعداد دانش‌آموزان را درست بنویسید',
  'bad_manager_name' => 'نام و نام خانوادگی مدیر را بنویسید',
  'bad_username' => 'نام کاربری درست نیست',
  'bad_password' => 'رمز عبور دست‌کم ۶ نویسه باشد',
  'not_found' || 'bad_id' => 'این درخواست روی این سرور پیدا نشد',
  'bad_device' =>
    'شناسهٔ این دستگاه خوانده نشد — دورهٔ آزمایشی روی این دستگاه ممکن نیست',
  'already_active' => 'اشتراک شما همین حالا فعال است',
  'trial_used_device' => 'دورهٔ آزمایشی روی این دستگاه قبلاً استفاده شده است (حتی با نصب دوبارهٔ برنامه) — لطفاً اشتراک تهیه کنید',
  'trial_unavailable' => 'دورهٔ آزمایشی برای شما در دسترس نیست',
  'trial_check_unavailable' => 'بررسی دورهٔ آزمایشی ممکن نشد (دیتابیس در دسترس نیست) — کمی بعد دوباره امتحان کنید',
  'gateway_not_configured' =>
    'درگاه پرداخت هنوز فعال نشده است — از «ثبت رسید» استفاده کنید',
  'no_callback_address' =>
    'نشانی بازگشت از درگاه تعریف نشده است — به پشتیبانی پایش اطلاع دهید',
  'bad_plan' => 'پلن را انتخاب کنید',
  'bad_ref' => 'شمارهٔ پیگیری/رسید را درست بنویسید (۴ تا ۴۰ نویسه)',
  'dup_ref' => 'این شمارهٔ پیگیری/رسید قبلاً ثبت شده است',
  'receipt_disabled' => 'ثبت رسید فعال نیست',
  'not_required' => 'نقش شما به اشتراک نیاز ندارد',
  _ => e.messageFa,
};

/// تماس‌های ثبت‌نام و اشتراک با سرور مدرسه؛ آزمون‌ها جعلی می‌سازند.
abstract interface class LanSchoolsApi {
  Future<({String id, String token})> register(
    Uri server,
    SchoolSignup form, {
    String? deviceHash,
  });
  Future<SignupStatus> registrationStatus(SignupTicket t);
  Future<SubStatus> subStatus(Uri server, String token);
  Future<SubStatus> startTrial(Uri server, String token, String deviceHash);

  /// پیوند درگاه برای باز کردن در مرورگر.
  Future<({String payUrl, String paymentId})> startPayment(
    Uri server,
    String token,
    String plan,
  );
  Future<SubPayment> submitReceipt(
    Uri server,
    String token,
    String plan,
    String ref,
  );
}

/// پیاده‌سازی واقعی روی همان [LanAccessClient] (همان سرآیندها، زمان‌سنج و نگاشت خطا).
final class LanSchoolsClient implements LanSchoolsApi {
  LanSchoolsClient(this.client);
  final LanAccessClient client;

  @override
  Future<({String id, String token})> register(
    Uri server,
    SchoolSignup form, {
    String? deviceHash,
  }) async {
    final j = await client.request(
      'POST',
      server.resolve('/api/schools/register'),
      form.toJson(deviceHash: deviceHash),
    );
    final id = j['id'];
    final token = j['token'];
    if (id is! String || token is! String) {
      throw const LanAccessFailure(LanAccessError.unknown, wire: 'bad_body');
    }
    return (id: id, token: token);
  }

  @override
  Future<SignupStatus> registrationStatus(SignupTicket t) async {
    final j = await client.request(
      'GET',
      t.server.replace(
        path: '/api/schools/register/status',
        queryParameters: {'id': t.id, 'token': t.token},
      ),
      null,
    );
    return SignupStatus(
      '${j['status'] ?? 'pending'}',
      school: j['school'] as String?,
      username: j['username'] as String?,
      reason: j['reason'] as String?,
    );
  }

  @override
  Future<SubStatus> subStatus(Uri server, String token) async =>
      SubStatus.fromJson(
        await client.request(
          'GET',
          server.resolve('/api/sub/status'),
          null,
          token: token,
        ),
      );

  @override
  Future<SubStatus> startTrial(
    Uri server,
    String token,
    String deviceHash,
  ) async {
    final j = await client.request('POST', server.resolve('/api/sub/trial'), {
      'device_hash': deviceHash,
    }, token: token);
    return SubStatus.fromJson(
      j['sub'] is Map ? (j['sub']! as Map).cast<String, Object?>() : j,
    );
  }

  @override
  Future<({String payUrl, String paymentId})> startPayment(
    Uri server,
    String token,
    String plan,
  ) async {
    final j = await client.request('POST', server.resolve('/api/sub/pay'), {
      'plan': plan,
    }, token: token);
    final url = Uri.tryParse('${j['pay_url']}');
    final p = SubPayment.fromJson(j['payment']);
    if (url == null ||
        (url.scheme != 'https' && url.scheme != 'http') ||
        p == null) {
      throw const LanAccessFailure(LanAccessError.unknown, wire: 'bad_body');
    }
    return (payUrl: url.toString(), paymentId: p.id);
  }

  @override
  Future<SubPayment> submitReceipt(
    Uri server,
    String token,
    String plan,
    String ref,
  ) async {
    final j = await client.request('POST', server.resolve('/api/sub/receipt'), {
      'plan': plan,
      'ref': ref.trim(),
    }, token: token);
    final p = SubPayment.fromJson(j['payment']);
    if (p == null) {
      throw const LanAccessFailure(LanAccessError.unknown, wire: 'bad_body');
    }
    return p;
  }
}
