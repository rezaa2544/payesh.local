// Row 128 / W12 — managing the school server itself (web PAGES.system manager sections and
// PAGES.cloud: `backup-now`, `backup-list`, `mirror-refresh`, `mirror-restore`,
// `devices-list`, `revoke-device`, `audit-list`, `settings-save`, `cloud-edit`, `cloud-save`,
// `cloud-test`, `cloud-cors`, `cloud-reset`, `cloud-phone-check`, `phone-diagnose`).
//
// These are ONLINE BY DESIGN (documented in the parity matrix, like W7 passwords): each one
// acts on the school server's own disk, device table, audit log or cloud-storage settings —
// there is nothing on the device to queue. They call the school server directly and fail
// with a clear "needs the school server" message when it is unreachable; nothing is
// half-written. The cloud key is write-only (D‑23/F‑04): the server never returns it, and
// the native app never stores it.
import 'dart:convert';

import 'lan_access.dart';

enum AdminError {
  /// The school server did not answer (or this device is not on the school's own server).
  offline,
  notManager,
  badFile,
  notBackup,
  tooLarge,
  crossTenant,
  notFound,
  unknown,
}

final class AdminFailure implements Exception {
  const AdminFailure(this.kind, [this.detail]);
  final AdminError kind;
  final String? detail;

  String get messageFa => switch (kind) {
    AdminError.offline => 'این کار روی سرور مدرسه انجام می‌شود — اتصال را بررسی کنید و دوباره بزنید',
    AdminError.notManager => 'این کار فقط برای مدیر است',
    AdminError.badFile => 'این فایل پشتیبان معتبر نیست (JSON ناخوانا)',
    AdminError.notBackup => 'این فایل، فایل پشتیبان پایش نیست',
    AdminError.tooLarge => 'این فایل بزرگ‌تر از حد مجاز است',
    AdminError.crossTenant => 'این فایل مال مدرسهٔ دیگری است — بازیابی نشد',
    AdminError.notFound => 'پیدا نشد',
    AdminError.unknown => 'انجام نشد${detail == null ? '' : ': $detail'}',
  };

  @override
  String toString() =>
      'AdminFailure(${kind.name}${detail == null ? '' : ' $detail'})';
}

Map<String, Object?> _map(Object? v) =>
    v is Map ? v.cast<String, Object?>() : const {};
List<Map<String, Object?>> _list(Object? v) => [
  if (v is List)
    for (final e in v)
      if (e is Map) e.cast<String, Object?>(),
];
int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
String _str(Object? v) => v == null ? '' : '$v';

/// `GET /api/health`.
final class ServerHealth {
  const ServerHealth({
    required this.version,
    required this.school,
    required this.uptimeSeconds,
    required this.cloudReady,
    this.restartPending = false,
  });
  factory ServerHealth.fromJson(Map<String, Object?> j) => ServerHealth(
    version: _str(j['version']),
    school: _str(j['school']),
    uptimeSeconds: _int(j['uptime_s']),
    cloudReady: j['cloud_ready'] == true,
    restartPending: j['restart_pending'] == true,
  );
  final String version;
  final String school;
  final int uptimeSeconds;
  final bool cloudReady;
  final bool restartPending;
}

final class MirrorDiff {
  const MirrorDiff(this.collection, this.db, this.mirror);
  final String collection;
  final int db;
  final int mirror;
}

final class DailyBackup {
  const DailyBackup(this.file, this.total, this.size);
  final String file;
  final int total;
  final int size;

  /// `payesh-2026-11-12.json` → `2026-11-12`.
  String get day => file.replaceAll(RegExp(r'^payesh-|\.json$'), '');
}

/// `GET /api/admin/mirror` / `POST /api/admin/mirror/refresh`.
final class MirrorState {
  const MirrorState({
    required this.ok,
    required this.at,
    required this.total,
    required this.diffs,
    required this.daily,
  });
  factory MirrorState.fromJson(Map<String, Object?> j) {
    final m = _map(j['mirror']);
    return MirrorState(
      ok: m['ok'] == true,
      at: _str(m['at']),
      total: _int(m['total']),
      diffs: [
        for (final d in _list(m['diffs']))
          MirrorDiff(_str(d['collection']), _int(d['db']), _int(d['mirror'])),
      ],
      daily: [
        for (final f in _list(j['daily']))
          DailyBackup(_str(f['file']), _int(f['total']), _int(f['size'])),
      ],
    );
  }
  final bool ok;
  final String at;
  final int total;
  final List<MirrorDiff> diffs;
  final List<DailyBackup> daily;
}

final class DeviceInfo {
  const DeviceInfo({
    required this.id,
    required this.userName,
    required this.role,
    required this.name,
    required this.platform,
    required this.revoked,
    this.userId = 0,
    this.lastSeen = '',
  });
  factory DeviceInfo.fromJson(Map<String, Object?> j) => DeviceInfo(
    id: _str(j['id']),
    userId: _int(j['user_id']),
    userName: _str(j['user_name']),
    role: _str(j['role']),
    name: _str(j['name']),
    platform: _str(j['platform']),
    revoked: j['revoked'] == true,
    lastSeen: _str(j['last_seen_at']),
  );
  final String id;
  final int userId;

  /// The server's `user_name` ('—' when its lookup fails — the page then shows the name
  /// from the device's own copy of `users`, see [userId]).
  final String userName;
  final String role;
  final String name;
  final String platform;
  final bool revoked;
  final String lastSeen;
}

final class AuditEntry {
  const AuditEntry(this.at, this.user, this.action, this.collection);
  factory AuditEntry.fromJson(Map<String, Object?> j) => AuditEntry(
    _str(j['at']),
    _str(j['user_id']).isEmpty ? '—' : _str(j['user_id']),
    _str(j['action']),
    _str(j['collection']),
  );
  final String at;
  final String user;
  final String action;
  final String collection;
}

/// What `GET /api/admin/cloud` shows (never a key — only "set or not" and a 4-char hint).
final class CloudConfig {
  const CloudConfig({
    required this.endpoint,
    required this.bucket,
    required this.region,
    required this.accessHint,
    required this.hasAccessKey,
    required this.hasSecret,
    required this.configured,
    required this.builtIn,
  });
  factory CloudConfig.fromJson(Map<String, Object?> j) {
    final c = _map(j['config']);
    return CloudConfig(
      endpoint: _str(c['endpoint']),
      bucket: _str(c['bucket']),
      region: _str(c['region']),
      accessHint: _str(c['accessKey']),
      hasAccessKey: c['has_access_key'] == true,
      hasSecret: c['has_secret'] == true,
      configured: c['configured'] == true,
      builtIn: c['built_in'] == true,
    );
  }
  final String endpoint;
  final String bucket;
  final String region;
  final String accessHint;
  final bool hasAccessKey;
  final bool hasSecret;
  final bool configured;
  final bool builtIn;

  /// Web badge: آماده / در حال آماده‌سازی / تنظیم نشده.
  String get stateFa => configured
      ? 'آماده'
      : (hasAccessKey ? 'در حال آماده‌سازی' : 'تنظیم نشده');
}

/// The manager's edit form. Empty = keep the current value (web: "مقدار خالی = همان مقدار
/// فعلی می‌ماند"); the secret is only ever sent, never read back.
final class CloudForm {
  const CloudForm({
    this.endpoint = '',
    this.bucket = '',
    this.region = '',
    this.accessKey = '',
    this.secret = '',
  });
  final String endpoint;
  final String bucket;
  final String region;
  final String accessKey;
  final String secret;

  Map<String, Object?> toJson() => {
    if (endpoint.trim().isNotEmpty) 'endpoint': endpoint.trim(),
    if (bucket.trim().isNotEmpty) 'bucket': bucket.trim(),
    if (region.trim().isNotEmpty) 'region': region.trim(),
    if (accessKey.trim().isNotEmpty) 'accessKey': accessKey.trim(),
    if (secret.isNotEmpty) 'secret': secret,
  };
}

final class CloudStep {
  const CloudStep(this.name, this.ok, {this.note = '', this.ms = 0});
  final String name;
  final bool ok;
  final String note;
  final int ms;
}

/// `cloud-test` / `cloud-cors` / `cloud-phone-check` result, in the web's words.
final class CloudOutcome {
  const CloudOutcome(this.ok, this.headlineFa, this.steps);
  final bool ok;
  final String headlineFa;
  final List<CloudStep> steps;

  /// Web `cloudStepsHtml`.
  factory CloudOutcome.test(Map<String, Object?> r) => CloudOutcome(
    r['ok'] == true,
    r['ok'] == true
        ? 'حافظهٔ ابری سالم است'
        : 'وصل نشد${_str(r['error']).isEmpty ? '' : ' — ${_str(r['error'])}'}',
    [
      for (final s in _list(r['steps']))
        CloudStep(
          _str(s['name']),
          s['ok'] == true,
          note: _str(s['note']),
          ms: _int(s['ms']),
        ),
    ],
  );

  factory CloudOutcome.cors(Map<String, Object?> r) {
    final origins = [
      for (final o in (r['origins'] is List ? r['origins'] as List : const []))
        '$o',
    ];
    return CloudOutcome(
      r['ok'] == true,
      r['ok'] == true ? 'CORS تنظیم شد' : 'تنظیم خودکار نشد',
      [
        if (r['ok'] == true && origins.isNotEmpty)
          CloudStep('دامنه‌های مجاز: ${origins.join(' , ')}', true),
        if (r['ok'] != true)
          CloudStep(
            'کلید اجازهٔ تغییر تنظیمات صندوقچه را ندارد؛ قانون CORS را در پنل دستی بسازید',
            false,
            note: _str(r['error']),
          ),
      ],
    );
  }

  static const Map<String, String> phoneStepFa = {
    'bucket': 'پیدا کردن صندوقچه',
    'cors': 'اجازهٔ خواندن برای گوشی',
    'set_cors': 'گذاشتن اجازهٔ خواندن',
    'cors_after': 'آزمایش دوباره بعد از تنظیم',
  };

  /// Web `phoneCheckHtml`.
  factory CloudOutcome.phone(Map<String, Object?> r) => CloudOutcome(
    r['ok'] == true,
    r['ok'] == true ? 'گوشی می‌تواند بخواند و بنویسد' : 'هنوز نشده',
    [
      for (final s in _list(r['steps']))
        CloudStep(
          phoneStepFa[_str(s['step'])] ?? _str(s['step']),
          s['ok'] != false,
          note: [
            if (_int(s['status']) != 0) 'کد ${_int(s['status'])}',
            if (_str(s['error']).isNotEmpty) _str(s['error']),
          ].join(' — '),
        ),
    ],
  );
}

final class RestoreReport {
  const RestoreReport(this.restored, this.safety);
  final int restored;
  final String safety;
  String get messageFa =>
      'بازیابی انجام شد · $restored رکورد${safety.isEmpty ? '' : ' · نسخهٔ ایمنی: $safety'}';
}

/// Web `actMirrorRestore` checks, before anything is sent.
abstract final class BackupFile {
  static const int maxBytes = 60 * 1024 * 1024;

  static Map<String, Object?> parse(List<int> bytes) {
    if (bytes.length > maxBytes) throw const AdminFailure(AdminError.tooLarge);
    Object? data;
    try {
      data = jsonDecode(utf8.decode(bytes));
    } on FormatException {
      throw const AdminFailure(AdminError.badFile);
    }
    if (data is! Map || data['format'] != 'payesh-backup') {
      throw const AdminFailure(AdminError.notBackup);
    }
    return data.cast<String, Object?>();
  }
}

/// One line of "بررسی اتصال این دستگاه" (web `phone-diagnose`, without technical words).
final class ConnectionStep {
  const ConnectionStep(this.ok, this.textFa, [this.detail = '']);
  final bool ok;
  final String textFa;
  final String detail;
}

abstract interface class ServerAdminApi {
  /// The school server this device talks to.
  Uri get server;
  Future<ServerHealth> health();
  Future<String> backupNow();
  Future<List<String>> backups();
  Future<MirrorState> mirror();
  Future<MirrorState> mirrorRefresh();
  Future<RestoreReport> restore(Map<String, Object?> data);
  Future<List<DeviceInfo>> devices();
  Future<void> revokeDevice(String id);
  Future<List<AuditEntry>> audit({int limit = 60});
  Future<void> saveSettings({required String name});
  Future<CloudConfig> cloud();

  /// Returns whether the saved settings are complete.
  Future<bool> cloudSave(CloudForm form);
  Future<CloudOutcome> cloudTest();
  Future<CloudOutcome> cloudCors();

  /// Back to the built-in default; returns the bucket (may be empty offline).
  Future<String> cloudReset();
  Future<CloudOutcome> phoneCheck();
}

/// Web `phone-diagnose` for the native app: where this device thinks the school server is,
/// whether it answers, whether this user is signed in and how much is still queued.
Future<List<ConnectionStep>> diagnoseConnection({
  required Uri? server,
  required ServerAdminApi? admin,
  required bool signedIn,
  required int queued,
}) async {
  final steps = <ConnectionStep>[
    ConnectionStep(
      server != null,
      server != null
          ? 'نشانی سرور مدرسه شناخته شده است'
          : 'نشانی سرور مدرسه روی این دستگاه نیست (حالت ابری یا هنوز وصل نشده)',
      server?.toString() ?? '—',
    ),
  ];
  if (admin != null) {
    try {
      final h = await admin.health();
      steps.add(
        ConnectionStep(
          true,
          'سرور مدرسه جواب می‌دهد',
          [h.school, h.version].where((s) => s.isNotEmpty).join(' · '),
        ),
      );
      steps.add(
        ConnectionStep(
          h.cloudReady,
          h.cloudReady
              ? 'حافظهٔ ابری روی سرور تنظیم شده است'
              : 'روی سرور هنوز حافظهٔ ابری تنظیم نشده',
        ),
      );
    } on AdminFailure catch (e) {
      steps.add(
        ConnectionStep(
          false,
          'به سرور مدرسه دسترسی نداریم (شبکه/نشانی)',
          e.detail ?? e.kind.name,
        ),
      );
    }
  }
  steps.add(
    ConnectionStep(
      signedIn,
      signedIn
          ? 'این دستگاه وارد شده است'
          : 'این دستگاه وارد نشده — یک‌بار با شماره و رمز وارد شوید',
    ),
  );
  steps.add(
    ConnectionStep(
      queued == 0,
      queued == 0
          ? 'همهٔ تغییرات این دستگاه رسیده است'
          : '$queued تغییر هنوز در صف ارسال است',
    ),
  );
  return steps;
}

/// [ServerAdminApi] on the school's own server (row 127 LAN mode).
final class LanServerAdmin implements ServerAdminApi {
  LanServerAdmin({
    required this.client,
    required this.server,
    required this.token,
  });
  final LanAccessClient client;
  @override
  final Uri server;
  final Future<String?> Function() token;

  Future<Map<String, Object?>> _call(
    String method,
    String path, [
    Object? body,
    bool auth = true,
  ]) async {
    String? t;
    if (auth) {
      try {
        t = await token();
      } on Object {
        t = null;
      }
      if (t == null) throw const AdminFailure(AdminError.offline);
    }
    try {
      return await client.request(method, server.resolve(path), body, token: t);
    } on LanAccessFailure catch (e) {
      throw switch (e.wire) {
        'forbidden' => const AdminFailure(AdminError.notManager),
        'bad_json' => const AdminFailure(AdminError.badFile),
        'bad_format' => const AdminFailure(AdminError.notBackup),
        'cross_tenant' => const AdminFailure(AdminError.crossTenant),
        'not_found' => const AdminFailure(AdminError.notFound),
        _ when e.kind == LanAccessError.unreachable => AdminFailure(
          AdminError.offline,
          e.wire,
        ),
        _ => AdminFailure(AdminError.unknown, e.wire),
      };
    }
  }

  @override
  Future<ServerHealth> health() async =>
      ServerHealth.fromJson(await _call('GET', '/api/health', null, false));

  @override
  Future<String> backupNow() async =>
      _str((await _call('POST', '/api/admin/backup', const {}))['file']);

  @override
  Future<List<String>> backups() async {
    final j = await _call('GET', '/api/admin/backups');
    return [
      for (final f in (j['files'] is List ? j['files'] as List : const []))
        '$f',
    ];
  }

  @override
  Future<MirrorState> mirror() async =>
      MirrorState.fromJson(await _call('GET', '/api/admin/mirror'));

  @override
  Future<MirrorState> mirrorRefresh() async => MirrorState.fromJson(
    await _call('POST', '/api/admin/mirror/refresh', const {}),
  );

  @override
  Future<RestoreReport> restore(Map<String, Object?> data) async {
    final j = await _call('POST', '/api/admin/restore', {
      'data': data,
      'replace': false,
    });
    final restored = _map(_map(j['report'])['restored']);
    return RestoreReport(
      restored.values.fold<int>(0, (a, v) => a + _int(v)),
      _str(j['safety']),
    );
  }

  @override
  Future<List<DeviceInfo>> devices() async => [
    for (final d in _list(
      (await _call('GET', '/api/admin/devices'))['devices'],
    ))
      DeviceInfo.fromJson(d),
  ];

  @override
  Future<void> revokeDevice(String id) async {
    if (!RegExp(r'^[a-f0-9]+$').hasMatch(id)) {
      throw const AdminFailure(AdminError.notFound);
    }
    await _call('DELETE', '/api/admin/devices/$id');
  }

  @override
  Future<List<AuditEntry>> audit({int limit = 60}) async => [
    for (final r in _list(
      (await _call('GET', '/api/admin/audit?limit=$limit'))['rows'],
    ))
      AuditEntry.fromJson(r),
  ];

  @override
  Future<void> saveSettings({required String name}) async {
    await _call('POST', '/api/admin/settings', {'name': name.trim()});
  }

  @override
  Future<CloudConfig> cloud() async =>
      CloudConfig.fromJson(await _call('GET', '/api/admin/cloud'));

  @override
  Future<bool> cloudSave(CloudForm form) async =>
      (await _call('POST', '/api/admin/cloud', form.toJson()))['configured'] ==
      true;

  @override
  Future<CloudOutcome> cloudTest() async => CloudOutcome.test(
    await _call('POST', '/api/admin/cloud/test', const {
      'config': <String, Object?>{},
    }),
  );

  @override
  Future<CloudOutcome> cloudCors() async => CloudOutcome.cors(
    await _call('POST', '/api/admin/cloud/cors', const {
      'config': <String, Object?>{},
    }),
  );

  @override
  Future<String> cloudReset() async =>
      _str((await _call('POST', '/api/admin/cloud/reset', const {}))['bucket']);

  @override
  Future<CloudOutcome> phoneCheck() async => CloudOutcome.phone(
    await _call('POST', '/api/admin/cloud/phone-check', const {}),
  );
}
