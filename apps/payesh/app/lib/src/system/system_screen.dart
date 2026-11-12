// Row 128 / W12 — the "سیستم" page (web PAGES.system: status, connection diagnosis and, for the
// manager, mirror + daily backup, hourly backups, connected devices, school settings, audit
// log), the "حافظهٔ ابری" page (web PAGES.cloud) and "سلامت داده" (web client/diag.js).
//
// Server-management actions are online by design (see payesh_sync server_admin.dart): they
// work on the school server itself, so without the school's own server the page says so and
// nothing is half-done. Data health runs on the device's copy and repairs are queued writes.
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';

Widget _card(
  BuildContext context,
  String title,
  List<Widget> children, {
  Key? key,
  Widget? trailing,
}) => Card(
  key: key,
  child: Padding(
    padding: const EdgeInsets.all(PayeshTokens.space3),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            ?trailing,
          ],
        ),
        const SizedBox(height: PayeshTokens.space2),
        ...children,
      ],
    ),
  ),
);

Widget _small(BuildContext context, String text, {Key? key}) => Padding(
  padding: const EdgeInsets.only(top: PayeshTokens.space1),
  child: Text(text, key: key, style: Theme.of(context).textTheme.bodySmall),
);

Widget _buttons(List<Widget> children) => Padding(
  padding: const EdgeInsets.only(top: PayeshTokens.space2),
  child: Wrap(
    spacing: PayeshTokens.space2,
    runSpacing: PayeshTokens.space2,
    children: children,
  ),
);

/// Shared online runner: the school server call, busy state and the Persian outcome.
mixin _Online on SchoolController {
  ServerAdminApi? get admin => source.admin;

  Future<bool> online(Future<String?> Function(ServerAdminApi a) op) async {
    if (busy) return false;
    final a = admin;
    if (a == null) {
      error = const AdminFailure(AdminError.offline).messageFa;
      notice = null;
      emit();
      return false;
    }
    busy = true;
    error = null;
    notice = null;
    emit();
    var ok = false;
    try {
      notice = await op(a);
      ok = true;
    } on AdminFailure catch (e) {
      error = e.messageFa;
    }
    busy = false;
    emit();
    return ok;
  }
}

String _fa(int n) => faNumber(n);

String _size(int b) => b > 1024 * 1024
    ? '${_fa((b / 1048576).round())} مگابایت'
    : b > 1024
    ? '${_fa((b / 1024).round())} کیلوبایت'
    : '${_fa(b)} بایت';

// ─────────────────────────────────── system ───────────────────────────────────

class SystemController extends SchoolController with _Online {
  SystemController({
    required super.source,
    required super.role,
    required super.uid,
  });

  /// Reads the chosen backup file (tests replace it; production: the file system).
  static Future<Uint8List> Function(String path) readFile = (p) =>
      File(p).readAsBytes();

  String user = '';
  String phone = '';
  String school = '';
  int queued = 0;
  Map<String, int> stats = const {};
  ServerHealth? health;
  MirrorState? mirror;
  List<String>? backups;
  List<DeviceInfo>? devices;
  List<AuditEntry>? audit;
  List<ConnectionStep>? diagnosis;
  Map<int, String> names = const {};

  bool get isManager => role == 'manager';

  @override
  Future<void> read(SchoolRecords db) async {
    final me = await db.get('users', uid);
    user = SchoolRecords.str(me?.data['name']);
    phone = SchoolRecords.str(me?.data['phone']);
    school = SchoolRecords.str((await db.get('schools', 1))?.data['name']);
    queued = db.outbox.list().length;
    if (isManager) {
      final users = await db.allOrEmpty('users');
      names = {for (final u in users) u.id: SchoolRecords.str(u.data['name'])};
      stats = {
        'users': users.length,
        for (final c in const ['classes', 'attendance', 'grades'])
          c: (await db.allOrEmpty(c)).length,
      };
    }
  }

  /// The device's own copy of `users` names the device owner when the server cannot.
  String ownerOf(DeviceInfo d) => d.userName.isNotEmpty && d.userName != '—'
      ? d.userName
      : (names[d.userId] ?? '—');

  /// "همگام‌سازی": nudge AutoSync now.
  void syncNow() {
    source.queued();
    notice = queued == 0
        ? 'همگام‌سازی درخواست شد'
        : 'همگام‌سازی درخواست شد · ${_fa(queued)} تغییر در صف';
    error = null;
    emit();
  }

  /// Web `phone-diagnose`.
  Future<void> diagnose() async {
    if (busy) return;
    busy = true;
    emit();
    diagnosis = await diagnoseConnection(
      server: admin?.server,
      admin: admin,
      signedIn: db != null,
      queued: db?.outbox.list().length ?? queued,
    );
    busy = false;
    emit();
  }

  Future<void> backupNow() =>
      online((a) async => 'پشتیبان ساخته شد: ${await a.backupNow()}');

  Future<void> listBackups() => online((a) async {
    backups = await a.backups();
    return null;
  });

  Future<void> loadMirror() => online((a) async {
    mirror = await a.mirror();
    return null;
  });

  Future<void> mirrorRefresh() => online((a) async {
    final m = mirror = await a.mirrorRefresh();
    return 'آینه به‌روز شد · ${_fa(m.total)} رکورد${m.ok ? ' — با دیتابیس یکی است ✅' : ' — اختلاف باقی است'}';
  });

  /// Web `actMirrorRestore`: checked on the device first, then sent to the school server.
  Future<bool> restore(String path) async {
    final p = path.trim();
    if (p.isEmpty) {
      error = 'اول فایل پشتیبان (.json) را انتخاب کنید';
      notice = null;
      emit();
      return false;
    }
    Map<String, Object?> data;
    try {
      data = BackupFile.parse(await readFile(p));
    } on AdminFailure catch (e) {
      error = e.messageFa;
      emit();
      return false;
    } on FileSystemException {
      error = 'فایل خوانده نشد';
      emit();
      return false;
    }
    final ok = await online((a) async {
      final r = await a.restore(data);
      mirror = null;
      return r.messageFa;
    });
    if (ok) source.queued();
    return ok;
  }

  Future<void> listDevices() => online((a) async {
    devices = await a.devices();
    return null;
  });

  Future<void> revoke(String id) => online((a) async {
    await a.revokeDevice(id);
    devices = await a.devices();
    return 'دستگاه باطل شد';
  });

  Future<void> listAudit() => online((a) async {
    audit = await a.audit();
    return null;
  });

  Future<void> saveSettings(String name) async {
    if (name.trim().isEmpty) {
      error = 'نام مدرسه را بنویسید';
      notice = null;
      emit();
      return;
    }
    final ok = await online((a) async {
      await a.saveSettings(name: name);
      health = await a.health();
      return 'ذخیره شد';
    });
    if (ok) {
      school = name.trim();
      source.queued();
    }
  }

  Future<void> loadHealth() => online((a) async {
    health = await a.health();
    return null;
  });
}

class SystemScreen extends StatefulWidget {
  const SystemScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
    this.openCloud,
    this.openHealth,
  });
  final SystemController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
  final VoidCallback? openCloud;
  final VoidCallback? openHealth;

  @override
  State<SystemScreen> createState() => _SystemScreenState();
}

class _SystemScreenState extends State<SystemScreen> {
  SystemController get c => widget.controller;
  final name = TextEditingController();
  final restorePath = TextEditingController();
  bool _named = false;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    name.dispose();
    restorePath.dispose();
    super.dispose();
  }

  Future<void> _revoke(DeviceInfo d) async {
    final ok = await confirmAction(
      context,
      prefix: 'sys',
      title: 'ابطال دستگاه',
      message:
          'دستگاه «${d.name.isEmpty ? d.platform : d.name}» از «${c.ownerOf(d)}» باطل شود؟ این دستگاه دیگر به سرور مدرسه وصل نمی‌شود.',
      confirm: 'ابطال',
    );
    if (ok) await c.revoke(d.id);
  }

  Future<void> _restore() async {
    if (restorePath.text.trim().isEmpty) {
      await c.restore('');
      return;
    }
    final ok = await confirmAction(
      context,
      prefix: 'sys',
      title: 'بازیابی از پشتیبان',
      message: 'اطلاعات همین فایل روی سیستم نوشته شود؟ رکوردهای فعلی حفظ می‌شوند و پیش از آن یک نسخهٔ ایمنی گرفته می‌شود.',
      confirm: 'بازیابی',
    );
    if (ok) await c.restore(restorePath.text);
  }

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'sys',
    title: 'سیستم',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        if (!_named && c.school.isNotEmpty) {
          name.text = c.school;
          _named = true;
        }
        final m = c.mirror;
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            _card(
              context,
              'وضعیت',
              key: const Key('sys-status'),
              trailing: StatusBadge(
                c.queued == 0 ? 'همه‌چیز رسیده' : 'در صف ارسال',
                key: const Key('sys-state'),
                tone: c.queued == 0 ? PayeshTone.success : PayeshTone.warning,
              ),
              [
                Text(
                  'کاربر: ${c.user.isEmpty ? '—' : c.user} · نقش: ${roleFa[c.role] ?? c.role}',
                  key: const Key('sys-user'),
                ),
                _small(
                  context,
                  'نام کاربری (شمارهٔ همراه): ${c.phone.isEmpty ? '—' : faDigits(c.phone)}',
                ),
                _small(
                  context,
                  'تغییرات در صف: ${_fa(c.queued)}',
                  key: const Key('sys-queued'),
                ),
                _buttons([
                  OutlinedButton(
                    key: const Key('sys-sync'),
                    onPressed: c.syncNow,
                    child: const Text('همگام‌سازی'),
                  ),
                ]),
              ],
            ),
            _card(
              context,
              'بررسی اتصال این دستگاه',
              key: const Key('sys-diag-card'),
              [
                _small(
                  context,
                  'اگر اطلاعات به این دستگاه نمی‌رسد، این دکمه گام‌به‌گام بررسی می‌کند کجا گیر است.',
                ),
                _buttons([
                  FilledButton.tonal(
                    key: const Key('sys-diagnose'),
                    onPressed: c.busy ? null : c.diagnose,
                    child: const Text('بررسی اتصال'),
                  ),
                ]),
                for (final (i, s) in (c.diagnosis ?? const []).indexed)
                  _small(
                    context,
                    '${s.ok ? '✅' : '❌'} ${s.textFa}${s.detail.isEmpty ? '' : ' — ${faDigits(s.detail)}'}',
                    key: Key('sys-diag-$i'),
                  ),
              ],
            ),
            if (c.isManager) ...[
              if (c.admin == null)
                Padding(
                  padding: const EdgeInsets.all(PayeshTokens.space2),
                  child: Text(
                    'پشتیبان، دستگاه‌ها، سابقهٔ تغییرات و حافظهٔ ابری روی سرور مدرسه‌اند؛ این دستگاه الان به سرور مدرسه وصل نیست.',
                    key: const Key('sys-no-server'),
                    style: TextStyle(color: context.tokens.warning),
                  ),
                ),
              _card(
                context,
                'آینهٔ داده و پشتیبان روزانه',
                key: const Key('sys-mirror-card'),
                trailing: m == null
                    ? const StatusBadge(
                        'بررسی نشده',
                        key: Key('sys-mirror-state'),
                        tone: PayeshTone.warning,
                      )
                    : StatusBadge(
                        m.ok ? 'آینه با دیتابیس یکی است' : 'آینه عقب است',
                        key: const Key('sys-mirror-state'),
                        tone: m.ok ? PayeshTone.success : PayeshTone.warning,
                      ),
                [
                  _small(
                    context,
                    'یک نسخهٔ خوانا روی خودِ سیستم مدرسه نگه داشته می‌شود و با دیتابیس مقایسه می‌شود؛ هر روز یک فایل پشتیبان ساخته و به‌روز می‌شود.',
                  ),
                  if (m != null) ...[
                    if (m.at.isNotEmpty)
                      _small(
                        context,
                        'آخرین آینه: ${faDigits(m.at.length >= 16 ? m.at.substring(0, 16).replaceFirst('T', ' ') : m.at)} · ${_fa(m.total)} رکورد',
                        key: const Key('sys-mirror-at'),
                      ),
                    if (m.diffs.isNotEmpty)
                      _small(
                        context,
                        '⚠️ اختلاف با دیتابیس: ${m.diffs.take(4).map((d) => '${d.collection} (${_fa(d.db)}/${_fa(d.mirror)})').join('، ')}',
                        key: const Key('sys-mirror-diffs'),
                      ),
                    _small(
                      context,
                      m.daily.isEmpty
                          ? 'هنوز فایل روزانه ساخته نشده'
                          : 'روزهای پشتیبان: ${_fa(m.daily.length)} فایل',
                      key: const Key('sys-mirror-daily'),
                    ),
                    for (final f in m.daily.take(10))
                      _small(
                        context,
                        '${faDigits(f.day)} · ${_fa(f.total)} رکورد · ${_size(f.size)}',
                        key: Key('sys-daily-${f.day}'),
                      ),
                  ],
                  _buttons([
                    FilledButton.tonal(
                      key: const Key('sys-mirror-refresh'),
                      onPressed: c.busy ? null : c.mirrorRefresh,
                      child: const Text('به‌روزرسانی و مقایسه'),
                    ),
                  ]),
                  const SizedBox(height: PayeshTokens.space3),
                  TextField(
                    key: const Key('sys-restore-path'),
                    controller: restorePath,
                    textDirection: TextDirection.ltr,
                    decoration: const InputDecoration(
                      labelText: 'مسیر فایل پشتیبان (.json) برای بازیابی',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  _buttons([
                    OutlinedButton(
                      key: const Key('sys-restore'),
                      onPressed: c.busy ? null : _restore,
                      child: const Text('بازیابی'),
                    ),
                  ]),
                ],
              ),
              _card(
                context,
                'پشتیبان‌گیری',
                key: const Key('sys-backup-card'),
                [
                  _small(
                    context,
                    'هر ساعت خودکار گرفته می‌شود و ۴۸ نسخه نگه داشته می‌شود.',
                  ),
                  _buttons([
                    FilledButton.tonal(
                      key: const Key('sys-backup-now'),
                      onPressed: c.busy ? null : c.backupNow,
                      child: const Text('پشتیبان همین حالا'),
                    ),
                    OutlinedButton(
                      key: const Key('sys-backup-list'),
                      onPressed: c.busy ? null : c.listBackups,
                      child: const Text('فهرست نسخه‌ها'),
                    ),
                  ]),
                  if (c.backups case final b?)
                    b.isEmpty
                        ? _small(
                            context,
                            'نسخه‌ای نیست.',
                            key: const Key('sys-backups-none'),
                          )
                        : Column(
                            key: const Key('sys-backups'),
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              for (final f in b.take(48))
                                Text(
                                  f,
                                  textDirection: TextDirection.ltr,
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                            ],
                          ),
                ],
              ),
              _card(context, 'حافظهٔ ابری و سلامت داده', [
                _small(
                  context,
                  'جایی که وقتی هیچ سیستمی روشن نیست، داده‌ها نگه داشته می‌شوند؛ و آزمون‌های سلامت دادهٔ مدرسه.',
                ),
                _buttons([
                  OutlinedButton(
                    key: const Key('sys-cloud'),
                    onPressed: widget.openCloud,
                    child: const Text('حافظهٔ ابری'),
                  ),
                  OutlinedButton(
                    key: const Key('sys-health'),
                    onPressed: widget.openHealth,
                    child: const Text('سلامت داده'),
                  ),
                ]),
              ]),
              _card(context, 'دستگاه‌های متصل', key: const Key('sys-dev-card'), [
                if (c.devices == null)
                  _small(context, 'برای دیدن فهرست، دکمه را بزنید.'),
                if (c.devices case final ds? when ds.isEmpty)
                  _small(
                    context,
                    'دستگاهی ثبت نشده.',
                    key: const Key('sys-dev-none'),
                  ),
                for (final d in c.devices ?? const <DeviceInfo>[])
                  ListTile(
                    key: Key('sys-dev-${d.id}'),
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      '${c.ownerOf(d)} · ${roleFa[d.role] ?? d.role}',
                    ),
                    subtitle: Text(
                      '${d.name.isEmpty ? '—' : d.name} · ${d.platform} · ${d.revoked ? 'باطل' : 'فعال'}',
                    ),
                    trailing: d.revoked
                        ? const StatusBadge('باطل', tone: PayeshTone.danger)
                        : TextButton(
                            key: Key('sys-revoke-${d.id}'),
                            onPressed: c.busy ? null : () => _revoke(d),
                            child: const Text('ابطال'),
                          ),
                  ),
                _buttons([
                  OutlinedButton(
                    key: const Key('sys-devices'),
                    onPressed: c.busy ? null : c.listDevices,
                    child: const Text('نمایش دستگاه‌ها'),
                  ),
                ]),
              ]),
              _card(context, 'تنظیمات مدرسه', [
                TextField(
                  key: const Key('sys-name'),
                  controller: name,
                  decoration: const InputDecoration(
                    labelText: 'نام مدرسه',
                    border: OutlineInputBorder(),
                  ),
                ),
                _buttons([
                  FilledButton.tonal(
                    key: const Key('sys-settings-save'),
                    onPressed: c.busy ? null : () => c.saveSettings(name.text),
                    child: const Text('ذخیره'),
                  ),
                ]),
              ]),
              _card(context, 'آمار پایگاه داده', key: const Key('sys-stats'), [
                Text(
                  'کاربران: ${_fa(c.stats['users'] ?? 0)} · کلاس‌ها: ${_fa(c.stats['classes'] ?? 0)} · حضور: ${_fa(c.stats['attendance'] ?? 0)} · نمره: ${_fa(c.stats['grades'] ?? 0)}',
                  key: const Key('sys-stats-text'),
                ),
                _buttons([
                  OutlinedButton(
                    key: const Key('sys-audit'),
                    onPressed: c.busy ? null : c.listAudit,
                    child: const Text('سابقهٔ تغییرات'),
                  ),
                ]),
                for (final (i, a) in (c.audit ?? const <AuditEntry>[]).indexed)
                  _small(
                    context,
                    '${JalaliDate.fromIso(a.at)?.slash ?? a.at} · ${faDigits(a.user)} · ${a.action} · ${a.collection}',
                    key: Key('sys-audit-$i'),
                  ),
              ]),
            ],
          ],
        );
      },
    ),
  );
}

// ─────────────────────────────────── cloud ───────────────────────────────────

class CloudController extends SchoolController with _Online {
  CloudController({
    required super.source,
    required super.role,
    required super.uid,
  });

  CloudConfig? config;
  bool editing = false;
  CloudOutcome? outcome;
  CloudOutcome? phone;

  @override
  Future<void> read(SchoolRecords db) async {}

  @override
  Future<void> load() async {
    loading = true;
    emit();
    await online((a) async {
      config = await a.cloud();
      return null;
    });
    loading = false;
    emit();
  }

  void toggleEdit() {
    editing = !editing;
    emit();
  }

  Future<void> test() => online((a) async {
    outcome = await a.cloudTest();
    return null;
  });

  Future<void> cors() => online((a) async {
    outcome = await a.cloudCors();
    return null;
  });

  Future<void> reset() => online((a) async {
    final bucket = await a.cloudReset();
    config = await a.cloud();
    return bucket.isEmpty
        ? 'به پیش‌فرض برنامه برگشت'
        : 'به پیش‌فرض برنامه برگشت (صندوقچه: $bucket)';
  });

  /// Web `cloud-save`: saved settings; when complete, CORS is set automatically too.
  Future<bool> save(CloudForm form) => online((a) async {
    final complete = await a.cloudSave(form);
    var msg = complete ? 'ذخیره شد' : 'ذخیره شد — ولی کامل نیست';
    if (complete) {
      try {
        final o = outcome = await a.cloudCors();
        msg +=
            ' · ${o.ok ? 'CORS هم خودکار تنظیم شد' : 'CORS خودکار نشد — دکمهٔ تنظیم خودکار CORS را بزن'}';
      } on AdminFailure {
        // silent, like the web
      }
    }
    config = await a.cloud();
    editing = false;
    return msg;
  });

  Future<void> phoneCheck() => online((a) async {
    final p = phone = await a.phoneCheck();
    return p.ok ? 'دسترسی گوشی درست شد ✅' : 'هنوز کامل نشد — پایین را ببینید';
  });
}

class CloudScreen extends StatefulWidget {
  const CloudScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final CloudController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<CloudScreen> createState() => _CloudScreenState();
}

class _CloudScreenState extends State<CloudScreen> {
  CloudController get c => widget.controller;
  final endpoint = TextEditingController();
  final bucket = TextEditingController();
  final region = TextEditingController();
  final access = TextEditingController();
  final secret = TextEditingController();

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    for (final t in [endpoint, bucket, region, access, secret]) {
      t.dispose();
    }
    super.dispose();
  }

  void _toggle() {
    final cfg = c.config;
    if (!c.editing && cfg != null) {
      endpoint.text = cfg.endpoint;
      bucket.text = cfg.bucket;
      region.text = cfg.region;
      access.clear();
      secret.clear();
    }
    c.toggleEdit();
  }

  Future<void> _save() async {
    final ok = await c.save(
      CloudForm(
        endpoint: endpoint.text,
        bucket: bucket.text,
        region: region.text,
        accessKey: access.text,
        secret: secret.text,
      ),
    );
    if (ok) {
      access.clear();
      secret.clear();
    }
  }

  Widget _outcome(
    BuildContext context,
    CloudOutcome o,
    String prefix,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const SizedBox(height: PayeshTokens.space2),
      StatusBadge(
        o.headlineFa,
        key: Key('$prefix-head'),
        tone: o.ok ? PayeshTone.success : PayeshTone.danger,
      ),
      for (final (i, s) in o.steps.indexed)
        _small(
          context,
          '${s.ok ? '✅' : '⛔'} ${s.name}${s.ms > 0 ? ' · ${_fa(s.ms)}ms' : ''}${s.note.isEmpty ? '' : ' — ${s.note}'}',
          key: Key('$prefix-step-$i'),
        ),
    ],
  );

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'cld',
    title: 'حافظهٔ ابری',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final cfg = c.config;
        final ready = cfg?.configured ?? false;
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            _small(
              context,
              'وقتی هیچ سیستمی در مدرسه روشن نیست، داده‌ها باید جایی بمانند تا اولین دستگاهِ روشن‌شده همه را بردارد. اینجا همان «صندوقچه» است.',
            ),
            if (cfg == null)
              _small(
                context,
                c.admin == null
                    ? 'این تنظیمات روی سرور مدرسه است؛ این دستگاه الان به سرور مدرسه وصل نیست.'
                    : 'در حال خواندن تنظیمات…',
                key: const Key('cld-none'),
              )
            else
              _card(
                context,
                'وضعیت صندوقچه',
                key: const Key('cld-card'),
                trailing: StatusBadge(
                  cfg.stateFa,
                  key: const Key('cld-state'),
                  tone: ready ? PayeshTone.success : PayeshTone.warning,
                ),
                [
                  if (cfg.fromOwner)
                    _small(
                      context,
                      '✅ همان دیتابیسی که مالک در پنل مدیریت تعریف کرده است؛ اگر مالک آن را عوض کند، این سرور خودش به‌روز می‌شود. صندوقچه: ${cfg.bucket.isEmpty ? '—' : cfg.bucket} · سرور: ${cfg.endpoint}',
                      key: const Key('cld-owner'),
                    )
                  else if (cfg.builtIn)
                    _small(
                      context,
                      '✅ از قبل داخل برنامه تنظیم شده است — لازم نیست چیزی وارد کنید.${cfg.bucket.isEmpty ? '' : ' صندوقچه: ${cfg.bucket}'} · سرور: ${cfg.endpoint}',
                      key: const Key('cld-builtin'),
                    )
                  else
                    _small(
                      context,
                      'تنظیمات دستی روی سرور مدرسه فعال است (بر پیش‌فرضِ داخل برنامه مقدم است). صندوقچه: ${cfg.bucket.isEmpty ? '—' : cfg.bucket} · کلید: ${cfg.hasAccessKey ? cfg.accessHint : '—'}',
                      key: const Key('cld-manual'),
                    ),
                  _buttons([
                    OutlinedButton(
                      key: const Key('cld-test'),
                      onPressed: c.busy || !ready ? null : c.test,
                      child: const Text('آزمایش اتصال'),
                    ),
                    OutlinedButton(
                      key: const Key('cld-cors'),
                      onPressed: c.busy || !ready ? null : c.cors,
                      child: const Text('تنظیم خودکار CORS'),
                    ),
                    OutlinedButton(
                      key: const Key('cld-edit'),
                      onPressed: _toggle,
                      child: Text(
                        c.editing ? 'بستن کادر تغییر' : 'تغییر تنظیمات',
                      ),
                    ),
                    if (!cfg.builtIn)
                      OutlinedButton(
                        key: const Key('cld-reset'),
                        onPressed: c.busy ? null : c.reset,
                        child: const Text('بازگشت به پیش‌فرض برنامه'),
                      ),
                  ]),
                  if (c.outcome case final o?) _outcome(context, o, 'cld-out'),
                ],
              ),
            if (cfg != null && c.editing)
              _card(
                context,
                'تنظیمات صندوقچه (تغییر)',
                key: const Key('cld-form'),
                [
                  _small(
                    context,
                    'مقدار خالی = همان مقدار فعلی می‌ماند. کلید فقط روی سرور مدرسه می‌ماند و هرگز به این دستگاه برنمی‌گردد.',
                  ),
                  for (final (k, label, t, hide) in [
                    ('cld-endpoint', 'آدرس سرویس (Endpoint)', endpoint, false),
                    (
                      'cld-bucket',
                      'نام صندوقچه (اختیاری — خودکار پیدا می‌شود)',
                      bucket,
                      false,
                    ),
                    ('cld-region', 'منطقه (اختیاری)', region, false),
                    ('cld-access', 'کلید عمومی (Access Key)', access, false),
                    ('cld-secret', 'کلید خصوصی (Secret Key)', secret, true),
                  ])
                    Padding(
                      padding: const EdgeInsets.only(top: PayeshTokens.space2),
                      child: TextField(
                        key: Key(k),
                        controller: t,
                        obscureText: hide,
                        textDirection: TextDirection.ltr,
                        decoration: InputDecoration(
                          labelText: label,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                    ),
                  _buttons([
                    FilledButton(
                      key: const Key('cld-save'),
                      onPressed: c.busy ? null : _save,
                      child: const Text('ذخیرهٔ تنظیمات تازه'),
                    ),
                  ]),
                ],
              ),
            _card(context, 'دسترسی گوشی‌ها', key: const Key('cld-phone-card'), [
              _small(
                context,
                'این دکمه خودش بررسی و درست می‌کند: صندوقچه پیدا می‌شود، اجازهٔ خواندن برای گوشی گذاشته می‌شود و نتیجه همین‌جا دیده می‌شود.',
              ),
              _buttons([
                FilledButton.tonal(
                  key: const Key('cld-phone'),
                  onPressed: c.busy ? null : c.phoneCheck,
                  child: const Text('بررسی و درست‌کردن دسترسی گوشی'),
                ),
              ]),
              if (c.phone case final p?) _outcome(context, p, 'cld-phone'),
            ]),
          ],
        );
      },
    ),
  );
}

// ─────────────────────────────────── data health ───────────────────────────────────

class HealthController extends SchoolController {
  HealthController({
    required super.source,
    required super.role,
    required super.uid,
  });

  HealthRun? last;

  @override
  Future<void> read(SchoolRecords db) async {
    last = await DataHealth(db).run();
  }

  /// Web `diag-rerun`.
  Future<void> rerun() async {
    await load();
    final bad = last?.bad.length ?? 0;
    if (error == null) {
      notice = bad > 0
          ? 'بررسی دوباره تمام شد — ${_fa(bad)} مورد ایراد پیدا شد'
          : 'بررسی دوباره تمام شد — همه‌چیز سالم است ✅';
      emit();
    }
  }

  /// Web `diag-open`.
  Future<HealthResult?> open(String id) async {
    final d = db;
    if (d == null) return null;
    try {
      return await DataHealth(d).check(id);
    } on RecordFailure catch (e) {
      error = e.messageFa;
      emit();
      return null;
    }
  }

  /// Web `diag-fix`.
  Future<RecordWrite?> fix(String id) => run((db) => DataHealth(db).fix(id));

  Future<List<HealthMember>> group(String key) async {
    final d = db;
    return d == null ? const [] : DataHealth(d).mergeGroup(key);
  }

  /// Web `diag-merge-do`.
  Future<bool> merge(int keep, List<int> drops) async {
    final r = await run((db) async {
      final m = await DataHealth(db).merge(keep, drops);
      return RecordWrite(m.messageFa, keys: m.keys);
    });
    return r != null;
  }
}

class HealthScreen extends StatefulWidget {
  const HealthScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final HealthController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<HealthScreen> createState() => _HealthScreenState();
}

class _HealthScreenState extends State<HealthScreen> {
  HealthController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _fix(HealthRow r) async {
    final ok = await confirmAction(
      context,
      prefix: 'hlt',
      title: r.check.title,
      message:
          '«${r.check.title}» — ${_fa(r.result.count)} مورد خودکار اصلاح شود؟ هیچ داده‌ای حذف نمی‌شود جز ردیف‌های تکراریِ اضافی.',
      confirm: 'اصلاح',
    );
    if (ok) await c.fix(r.check.id);
  }

  Future<void> _open(HealthCheck check) async {
    final res = await c.open(check.id);
    if (res == null || !mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _HealthDetail(controller: c, check: check, result: res),
      ),
    );
    if (mounted) await c.load();
  }

  Widget _row(BuildContext context, HealthRow r) {
    final ok = r.result.ok;
    final sev = r.check.severity;
    return ListTile(
      key: Key('hlt-row-${r.check.id}'),
      contentPadding: EdgeInsets.zero,
      title: Text(
        '${ok ? '✅' : switch (sev) {
                HealthSeverity.critical => '🔴',
                HealthSeverity.warning => '🟡',
                HealthSeverity.info => '🔵',
              }} ${r.check.title}',
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(ok ? 'درست است' : faDigits(r.result.message)),
          if (!ok && r.check.guide.isNotEmpty)
            _small(context, '💡 ${r.check.guide}'),
          if (!ok)
            _buttons([
              TextButton(
                key: Key('hlt-open-${r.check.id}'),
                onPressed: () => _open(r.check),
                child: const Text('دیدن موارد'),
              ),
              if (r.check.autoFix)
                FilledButton.tonal(
                  key: Key('hlt-fix-${r.check.id}'),
                  onPressed: c.busy ? null : () => _fix(r),
                  child: const Text('اصلاح خودکار'),
                ),
            ]),
        ],
      ),
      trailing: ok
          ? const StatusBadge('سالم', tone: PayeshTone.success)
          : StatusBadge(
              _fa(r.result.count),
              key: Key('hlt-count-${r.check.id}'),
              tone: switch (sev) {
                HealthSeverity.critical => PayeshTone.danger,
                HealthSeverity.warning => PayeshTone.warning,
                HealthSeverity.info => PayeshTone.neutral,
              },
            ),
    );
  }

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'hlt',
    title: 'سلامت داده',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    actions: [
      IconButton(
        key: const Key('hlt-rerun'),
        tooltip: 'بررسی دوباره',
        icon: const Icon(Icons.refresh),
        onPressed: c.rerun,
      ),
    ],
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final run = c.last;
        if (run == null) return const SizedBox.shrink();
        final bad = run.bad;
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            _card(
              context,
              bad.isEmpty
                  ? '✅ همهٔ آزمون‌ها سالم‌اند'
                  : '🔎 ${_fa(bad.length)} آزمون ایراد پیدا کرد',
              key: const Key('hlt-summary'),
              trailing: Text('${_fa(run.rows.length)} آزمون'),
              [
                Text(
                  '${run.critical > 0 ? '${_fa(run.critical)} بحرانی' : 'بدون بحرانی'} · ${run.warning > 0 ? '${_fa(run.warning)} هشدار' : 'بدون هشدار'}',
                  key: const Key('hlt-summary-text'),
                ),
              ],
            ),
            if (bad.isNotEmpty)
              _card(context, 'ایرادها', key: const Key('hlt-bad'), [
                for (final r in bad) _row(context, r),
              ]),
            if (run.good.isNotEmpty)
              _card(context, 'سالم', key: const Key('hlt-good'), [
                for (final r in run.good) _row(context, r),
              ]),
            _small(
              context,
              '«اصلاح خودکار» فقط برای موردهایی است که هیچ داده‌ای از بین نمی‌رود. برای کد ملی تکراری یا دو حساب از یک نفر، خودتان «ادغام» را بزنید تا نمرات و حضور و والدین منتقل شوند.',
            ),
          ],
        );
      },
    ),
  );
}

class _HealthDetail extends StatelessWidget {
  const _HealthDetail({
    required this.controller,
    required this.check,
    required this.result,
  });
  final HealthController controller;
  final HealthCheck check;
  final HealthResult result;

  Future<void> _merge(BuildContext context, String key) async {
    final members = await controller.group(key);
    if (!context.mounted) return;
    if (members.length < 2) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('این گروه دیگر تکراری نیست')),
      );
      return;
    }
    final merged = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => _MergePage(controller: controller, members: members),
      ),
    );
    if (merged == true && context.mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: IconButton(
        key: const Key('hld-back'),
        tooltip: 'بازگشت',
        icon: const BackButtonIcon(),
        onPressed: () => Navigator.maybePop(context),
      ),
      title: Text(check.title),
    ),
    body: ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        Text(check.description),
        if (result.ok)
          const Padding(
            padding: EdgeInsets.all(PayeshTokens.space4),
            child: Text('✅ چیزی پیدا نشد', key: Key('hld-ok')),
          )
        else ...[
          _small(
            context,
            '${_fa(result.count)} مورد',
            key: const Key('hld-count'),
          ),
          if (check.guide.isNotEmpty) _small(context, '💡 ${check.guide}'),
          for (final (i, it) in result.items.take(30).indexed)
            ListTile(
              key: Key('hld-item-$i'),
              contentPadding: EdgeInsets.zero,
              leading: Text(_fa(i + 1)),
              title: it.isGroup
                  ? Text(
                      it.members
                          .map(
                            (m) =>
                                '${m.name}${m.contact.isEmpty ? '' : ' · ${faDigits(m.contact)}'}',
                          )
                          .join('\n'),
                    )
                  : Text(it.name.isEmpty ? (it.key ?? '—') : it.name),
              subtitle: it.isGroup || it.note.isEmpty
                  ? null
                  : Text(faDigits(it.note)),
              trailing: it.isGroup && check.mergeable && it.key != null
                  ? TextButton(
                      key: Key('hld-merge-$i'),
                      onPressed: () => _merge(context, it.key!),
                      child: const Text('ادغام'),
                    )
                  : null,
            ),
        ],
      ],
    ),
  );
}

class _MergePage extends StatefulWidget {
  const _MergePage({required this.controller, required this.members});
  final HealthController controller;
  final List<HealthMember> members;

  @override
  State<_MergePage> createState() => _MergePageState();
}

class _MergePageState extends State<_MergePage> {
  late int keep = widget.members.first.id;

  @override
  Widget build(BuildContext context) {
    final others = widget.members.where((m) => m.id != keep).toList();
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          leading: IconButton(
            key: const Key('hlm-back'),
            tooltip: 'بازگشت',
            icon: const BackButtonIcon(),
            onPressed: () => Navigator.maybePop(context),
          ),
          title: const Text('ادغام کاربران تکراری'),
        ),
        body: ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            Text(
              'این ${_fa(widget.members.length)} حساب احتمالاً یک نفرند. یکی را «اصلی» انتخاب کنید؛ نمرات، حضور، مرخصی و پیوند والدین بقیه به آن منتقل و بقیه حذف می‌شوند.',
            ),
            if (widget.controller.error != null)
              Text(
                widget.controller.error!,
                key: const Key('hlm-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            RadioGroup<int>(
              groupValue: keep,
              onChanged: (v) => setState(() => keep = v ?? keep),
              child: Column(
                children: [
                  for (final m in widget.members)
                    RadioListTile<int>(
                      key: Key('hlm-keep-${m.id}'),
                      value: m.id,
                      title: Text(m.name),
                      subtitle: m.contact.isEmpty
                          ? null
                          : Text(faDigits(m.contact)),
                    ),
                ],
              ),
            ),
            _small(
              context,
              'بقیهٔ حساب‌ها: ${others.map((m) => m.name).join('، ')}',
              key: const Key('hlm-others'),
            ),
          ],
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(PayeshTokens.space3),
            child: FilledButton(
              key: const Key('hlm-do'),
              onPressed: widget.controller.busy
                  ? null
                  : () async {
                      final ok = await widget.controller.merge(keep, [
                        for (final m in others) m.id,
                      ]);
                      if (ok && context.mounted) {
                        Navigator.of(context).pop(true);
                      }
                    },
              child: const Text('ادغام کن'),
            ),
          ),
        ),
      ),
    );
  }
}
