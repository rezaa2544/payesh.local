// Row 128 / W12 — the "سیستم" page (web PAGES.system: status, connection diagnosis and, for the
// manager, mirror + daily backup, hourly backups, connected devices, school settings, audit
// log), the "حافظهٔ ابری" page (web PAGES.cloud) and "سلامت داده" (web client/diag.js).
//
// Server-management actions are online by design (see payesh_sync server_admin.dart): they
// work on the school server itself, so without the school's own server the page says so and
// nothing is half-done. Data health runs on the device's copy and repairs are queued writes.
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart' show TapGestureRecognizer;
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:flutter/material.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_update/payesh_update.dart' show UpdatePhase;

import '../pulse/web.dart';
import '../school/school_source.dart';
import '../accounts/accounts_screen.dart' show OwnPasswordController;
import '../pulse/pulse.dart';
import '../update/app_update.dart' show appChannel;
import 'school_profile_screen.dart';
import '../login/device_identity.dart' show openExternalUrl;

Widget _small(BuildContext context, String text, {Key? key}) => Padding(
  padding: const EdgeInsets.only(top: PayeshTokens.space1),
  child: Text(text, key: key, style: Theme.of(context).textTheme.bodySmall),
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

String _hm(DateTime d) =>
    '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

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

  /// Row 172: the web page knows the server (version, «حافظهٔ مشترک» ready) from boot; here it is
  /// read quietly once the page opens — no red bar when the school server is out of reach.
  Future<void> peekHealth() async {
    final a = admin;
    if (a == null || health != null) return;
    try {
      health = await a.health();
      emit();
    } on AdminFailure {
      // the cards say «بررسی نشده» / «آماده نشده» instead
    }
  }

  /// Web `cloud-phone-check` from the «📱 گوشی‌ها به حافظهٔ مدرسه وصل‌اند؟» card.
  CloudOutcome? phoneOut;
  Future<void> phoneCheck() => online((a) async {
    final p = phoneOut = await a.phoneCheck();
    return p.ok ? 'دسترسی گوشی درست شد ✅' : 'هنوز کامل نشد — پایین را ببینید';
  });
}

class SystemScreen extends StatefulWidget {
  const SystemScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
    this.openCloud,
  });
  final SystemController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
  final VoidCallback? openCloud;

  @override
  State<SystemScreen> createState() => _SystemScreenState();
}

class _SystemScreenState extends State<SystemScreen> {
  SystemController get c => widget.controller;
  final name = TextEditingController();
  final restorePath = TextEditingController();
  bool _named = false;

  /// Row 172: web `accountCard` — «👤 حساب من» changes the own password right on this page.
  late final OwnPasswordController pw = OwnPasswordController(
    source: c.source,
    role: c.role,
    uid: c.uid,
  );
  final pwCurrent = TextEditingController();
  final pwNext = TextEditingController();
  final pwAgain = TextEditingController();

  @override
  void initState() {
    super.initState();
    c.load().then((_) => c.peekHealth());
  }

  @override
  void dispose() {
    name.dispose();
    restorePath.dispose();
    for (final t in [pwCurrent, pwNext, pwAgain]) {
      t.dispose();
    }
    pw.dispose();
    super.dispose();
  }

  Future<void> _changePassword() async {
    pw.notice = null;
    final ok = await pw.change(
      current: pwCurrent.text,
      next: pwNext.text,
      again: pwAgain.text,
    );
    if (ok) {
      pwCurrent.clear();
      pwNext.clear();
      pwAgain.clear();
      pw.done = false;
    }
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

  static const _note = TextStyle(fontSize: 12.5, color: Web.muted, height: 1.9);
  static const _plain = TextStyle(fontSize: 12.5, color: Web.ink, height: 1.9);
  static const _bold = TextStyle(fontWeight: FontWeight.w700);

  /// Web `.row between` card head: bold title, badge on the far side.
  Widget _head(String title, {Widget? badge, double bottom = 0}) => Padding(
    padding: EdgeInsets.only(bottom: bottom),
    child: Row(
      children: [
        Expanded(child: Text(title, style: Web.b)),
        ?badge,
      ],
    ),
  );

  Widget _btns(List<Widget> children, {double top = 10}) => Padding(
    padding: EdgeInsets.only(top: top),
    child: Wrap(spacing: 6, runSpacing: 6, children: children),
  );

  Widget _col(List<Widget> children, {Key? key}) => WebCard(
    key: key,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    ),
  );

  Widget _phoneOut(CloudOutcome p) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        WebBadge(
          p.ok ? 'گوشی می‌تواند بخواند و بنویسد' : 'هنوز نشده',
          key: const Key('sys-phone-head'),
          tone: p.ok ? WebTone.green : WebTone.amber,
        ),
        const SizedBox(height: 6),
        for (final (i, st) in p.steps.indexed)
          Text(
            '${st.ok ? '✅' : '❌'} ${st.name}${st.ms > 0 ? ' · ${_fa(st.ms)}ms' : ''}${st.note.isEmpty ? '' : ' — ${st.note}'}',
            key: Key('sys-phone-step-$i'),
            style: _plain,
          ),
        if (!p.ok)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              'اگر «گذاشتن اجازه» خطا داد، کلیدِ صندوقچه اجازهٔ مدیریت ندارد؛ در پنل ابری یک قانون CORS با * و متدهای GET/PUT/DELETE/HEAD بسازید.',
              style: _note,
            ),
          ),
      ],
    ),
  );

  Widget _secret(
    String key,
    String label,
    TextEditingController t,
    String hint,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 9.6),
    child: WebField(
      label: label,
      child: TextField(
        key: Key(key),
        controller: t,
        obscureText: true,
        textDirection: TextDirection.ltr,
        autocorrect: false,
        enableSuggestions: false,
        autofillHints: [hint],
        style: const TextStyle(fontSize: 15, color: Web.ink),
        decoration: webInput(),
      ),
    ),
  );

  /// Web `PAGES.system`, card for card: «وضعیت», «⚡ همگام‌سازی زنده», (manager)
  /// «📱 گوشی‌ها به حافظهٔ مدرسه وصل‌اند؟», «👤 حساب من», «به‌روزرسانی برنامه», (manager) mirror,
  /// backups, cloud, devices, school settings, database stats — then «راهنمای دستگاه‌ها».
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([c, pw, widget.sync]),
    builder: (context, _) {
      if (!_named && c.school.isNotEmpty) {
        name.text = c.school;
        _named = true;
      }
      final m = c.mirror;
      final st = widget.sync.value;
      final last = st.lastSuccessAt?.toLocal();
      final app = PulseApp.of(context);
      final upd = app?.updater;
      final lock = PulseInline.lockOf(context);
      final server = c.admin?.server;
      final p = c.phoneOut;
      final phoneBadge = c.health != null && !c.health!.cloudReady
          ? const WebBadge(
              'حافظهٔ مشترک آماده نشده',
              key: Key('sys-phone-state'),
              tone: WebTone.amber,
            )
          : p != null
          ? WebBadge(
              p.ok ? 'گوشی‌ها وصل‌اند' : 'گوشی‌ها وصل نیستند',
              key: const Key('sys-phone-state'),
              tone: p.ok ? WebTone.green : WebTone.red,
            )
          : const WebBadge(
              'بررسی نشده',
              key: Key('sys-phone-state'),
              tone: WebTone.amber,
            );
      final restoreBad =
          c.error != null &&
          (c.error!.contains('فایل پشتیبان') || c.error == 'فایل خوانده نشد');
      return SchoolPage(
        prefix: 'sys',
        title: 'سیستم',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        // web: the school server's version (boot); before it is known, this app's own.
        sub:
            'نسخه ${c.health?.version.isNotEmpty == true ? c.health!.version : appChannel.version}',
        children: [
          _col(key: const Key('sys-status'), [
            _head(
              'وضعیت',
              badge: st.phase == SyncPhase.offline
                  ? const WebBadge(
                      'آفلاین',
                      key: Key('sys-state'),
                      tone: WebTone.amber,
                    )
                  : const WebBadge(
                      'متصل',
                      key: Key('sys-state'),
                      tone: WebTone.green,
                    ),
            ),
            const SizedBox(height: 6),
            Text(
              'کاربر: ${c.user.isEmpty ? '—' : c.user} · نقش: ${roleFa[c.role] ?? c.role}',
              key: const Key('sys-user'),
              style: _note,
            ),
            Text(
              'آخرین همگام‌سازی: ${last == null ? '—' : '${Web.jdate(last.toIso8601String())} ${Web.fa(_hm(last))}'}',
              key: const Key('sys-last-sync'),
              style: _note,
            ),
            Text(
              'تغییرات در صف: ${_fa(c.queued)}',
              key: const Key('sys-queued'),
              style: _note,
            ),
            _btns([
              WebBtn(
                'همگام‌سازی',
                key: const Key('sys-sync'),
                onPressed: c.syncNow,
              ),
              if (lock != null)
                WebBtn('🔒 خروج', key: const Key('sys-lock'), onPressed: lock),
            ]),
          ]),
          _col(key: const Key('sys-live'), [
            _head(
              '⚡ همگام‌سازی زنده',
              badge: const WebBadge('خودکار', tone: WebTone.green),
              bottom: 6,
            ),
            // Row 172: the web card's words, true for this app: a change is sent the moment it
            // is made; the other devices pick it up on their next automatic round.
            const Text(
              'هر تغییری که هر کاربر بدهد، همان لحظه برای سرور مدرسه فرستاده می‌شود و دستگاه‌های دیگر در دور خودکار بعدی '
              '(حداکثر حدود یک دقیقه) آن را می‌گیرند. اگر دستگاهی خاموش یا بی‌اینترنت باشد، تغییرهایش روی خودش می‌ماند و '
              'اولین لحظه‌ای که وصل شود فرستاده می‌شود.',
              style: _note,
            ),
            const SizedBox(height: 8),
            Text.rich(
              TextSpan(
                style: _plain,
                children: [
                  const TextSpan(text: 'آخرین به‌روزرسانی روی این دستگاه: '),
                  TextSpan(
                    text: last == null
                        ? '—'
                        : Web.fa(
                            '${_hm(last)}:${last.second.toString().padLeft(2, '0')}',
                          ),
                    style: _bold,
                  ),
                ],
              ),
              key: const Key('sys-live-at'),
            ),
          ]),
          if (c.isManager)
            _col(key: const Key('sys-phone-card'), [
              _head('📱 گوشی‌ها به حافظهٔ مدرسه وصل‌اند؟', badge: phoneBadge),
              const SizedBox(height: 6),
              const Text(
                'اگر گوشی پیام «به حافظه نرسیدیم» می‌دهد، این دکمه را بزنید؛ خودش بررسی و درست می‌کند.',
                style: _note,
              ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: _btns([
                  WebBtn(
                    'بررسی و درست‌کردن',
                    key: const Key('sys-phone'),
                    kind: WebBtnKind.primary,
                    onPressed: c.busy || c.admin == null ? null : c.phoneCheck,
                  ),
                ]),
              ),
              if (p != null) _phoneOut(p),
            ]),
          _col(key: const Key('sys-account'), [
            _head(
              '👤 حساب من',
              badge: WebBadge(roleFa[c.role] ?? c.role, tone: WebTone.none),
            ),
            const SizedBox(height: 6),
            Text.rich(
              TextSpan(
                style: _note,
                children: [
                  const TextSpan(text: 'نام: '),
                  TextSpan(text: c.user, style: _bold),
                ],
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'نام کاربری (شمارهٔ همراه): ${c.phone.isEmpty ? '—' : c.phone}',
              key: const Key('sys-phone-no'),
              style: _note,
            ),
            const SizedBox(height: 10),
            if (pw.formError != null)
              WebBanner(
                kind: WebBannerKind.err,
                text: pw.formError!,
                textKey: const Key('pw-error'),
              )
            else if (pw.notice != null)
              WebBanner(
                kind: WebBannerKind.ok,
                text: pw.notice!,
                textKey: const Key('pw-notice'),
              ),
            _secret(
              'pw-current',
              'رمز فعلی',
              pwCurrent,
              AutofillHints.password,
            ),
            _secret('pw-next', 'رمز تازه', pwNext, AutofillHints.newPassword),
            _secret(
              'pw-again',
              'تکرار رمز تازه',
              pwAgain,
              AutofillHints.newPassword,
            ),
            WebBtn(
              'تغییر رمز عبور',
              key: const Key('pw-submit'),
              kind: WebBtnKind.primary,
              size: WebBtnSize.normal,
              block: true,
              onPressed: pw.busy ? null : _changePassword,
            ),
            const SizedBox(height: 6),
            const Text(
              'اگر رمز فعلی را نمی‌دانید، از مدیر بخواهید رمز تازه بگذارد.',
              style: _note,
            ),
          ]),
          // Web `clientUpdateCard` — this app updates itself (the school server's own updater
          // has no endpoint for the app).
          if (upd != null)
            StreamBuilder<void>(
              stream: upd.changes,
              builder: (context, _) => _col(key: const Key('sys-update'), [
                const Text('به‌روزرسانی برنامه', style: Web.b),
                const SizedBox(height: 6),
                Text(
                  upd.available
                      ? 'نسخهٔ ${upd.channel.versionOf(upd.plan?.manifest.build ?? 0)} آماده است؛ فقط فایل‌های تغییرکرده دانلود می‌شود.'
                      : upd.phase == UpdatePhase.failed
                      ? 'منبع آپدیت در دسترس نیست. برنامه بدون آپدیت هم کار می‌کند.'
                      : 'برنامه به‌روز است.',
                  key: const Key('sys-update-line'),
                  style: _note,
                ),
                _btns([
                  WebBtn(
                    upd.busy ? '…' : 'بررسی به‌روزرسانی',
                    key: const Key('sys-update-check'),
                    onPressed: upd.busy ? null : upd.check,
                  ),
                  if (upd.available)
                    WebBtn(
                      'اعمال',
                      key: const Key('sys-update-apply'),
                      kind: WebBtnKind.primary,
                      onPressed: upd.busy ? null : upd.tap,
                    ),
                ], top: 8),
                const SizedBox(height: 8),
                const Text(
                  'به‌روزرسانی خود سیستم را مدیر انجام می‌دهد؛ دستگاه شما خودکار تازه می‌شود.',
                  style: _note,
                ),
              ]),
            ),
          if (c.isManager) ...[
            if (c.admin == null)
              const WebBanner(
                kind: WebBannerKind.warn,
                text: 'پشتیبان، دستگاه‌ها، سابقهٔ تغییرات و حافظهٔ ابری روی سرور مدرسه‌اند؛ این دستگاه الان به سرور مدرسه وصل نیست.',
                textKey: Key('sys-no-server'),
              ),
            _col(key: const Key('sys-mirror-card'), [
              _head(
                '🗄️ آینهٔ داده و پشتیبان روزانه',
                badge: m == null
                    ? const WebBadge(
                        'بررسی نشده',
                        key: Key('sys-mirror-state'),
                        tone: WebTone.amber,
                      )
                    : WebBadge(
                        m.ok ? 'آینه با دیتابیس یکی است' : 'آینه عقب است',
                        key: const Key('sys-mirror-state'),
                        tone: m.ok ? WebTone.green : WebTone.amber,
                      ),
                bottom: 6,
              ),
              const Text(
                'اطلاعات فقط در دیتابیس نیست: یک نسخهٔ خوانا هم روی خودِ این سیستم نگه داشته می‌شود و هر دقیقه با دیتابیس مقایسه می‌شود. '
                'هر روز یک فایل پشتیبان ساخته می‌شود و اگر همان روز داده عوض شود، همان فایل به‌روز می‌شود. '
                'اگر روزی دیتابیس از دست رفت یا عوض شد، همین فایل را اینجا آپلود کنید.',
                style: TextStyle(fontSize: 12.5, color: Web.muted, height: 2),
              ),
              const SizedBox(height: 8),
              if (m == null)
                const Text(
                  'برای دیدن وضعیت، دکمهٔ «به‌روزرسانی و مقایسه» را بزنید.',
                  style: _note,
                )
              else ...[
                if (m.at.isNotEmpty)
                  Text(
                    'آخرین آینه: ${m.at.length >= 16 ? m.at.substring(0, 16).replaceFirst('T', ' ') : m.at} · ${_fa(m.total)} رکورد',
                    key: const Key('sys-mirror-at'),
                    style: _plain.copyWith(height: 2),
                  ),
                if (m.diffs.isNotEmpty)
                  Text(
                    '⚠️ اختلاف با دیتابیس: ${m.diffs.take(4).map((d) => '${d.collection} (${_fa(d.db)}/${_fa(d.mirror)})').join('، ')}',
                    key: const Key('sys-mirror-diffs'),
                    style: _plain.copyWith(height: 2),
                  ),
                Text(
                  m.daily.isEmpty
                      ? 'هنوز فایل روزانه ساخته نشده'
                      : 'روزهای پشتیبان: ${_fa(m.daily.length)} فایل',
                  key: const Key('sys-mirror-daily'),
                  style: _plain.copyWith(height: 2),
                ),
              ],
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: _btns([
                  WebBtn(
                    '🔄 به‌روزرسانی و مقایسه',
                    key: const Key('sys-mirror-refresh'),
                    kind: WebBtnKind.primary,
                    onPressed: c.busy ? null : c.mirrorRefresh,
                  ),
                ]),
              ),
              if (m != null && m.daily.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 190),
                    child: SingleChildScrollView(
                      child: WebTable(
                        head: const ['روز', 'رکورد', 'حجم'],
                        rows: [
                          for (final f in m.daily.take(60))
                            [
                              Text(
                                f.day,
                                key: Key('sys-daily-${f.day}'),
                                textDirection: TextDirection.ltr,
                                style: const TextStyle(fontSize: 12.5),
                              ),
                              Text(
                                _fa(f.total),
                                style: const TextStyle(fontSize: 12.5),
                              ),
                              Text(
                                _size(f.size),
                                style: const TextStyle(fontSize: 12.5),
                              ),
                            ],
                        ],
                      ),
                    ),
                  ),
                ),
              Container(
                margin: const EdgeInsets.only(top: 12),
                padding: const EdgeInsets.only(top: 10),
                decoration: const BoxDecoration(
                  border: Border(top: BorderSide(color: Web.line)),
                ),
                child: const Text(
                  'بازیابی از فایل پشتیبان (روی همین سیستم یا سیستم تازه):',
                  style: _note,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('sys-restore-path'),
                      controller: restorePath,
                      textDirection: TextDirection.ltr,
                      style: const TextStyle(fontSize: 15, color: Web.ink),
                      decoration: webInput(
                        hint: 'مسیر فایل پشتیبان (.json)',
                        error: restoreBad ? checkFieldFa : null,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  WebBtn(
                    'بازیابی',
                    key: const Key('sys-restore'),
                    onPressed: c.busy ? null : _restore,
                  ),
                ],
              ),
            ]),
            _col(key: const Key('sys-backup-card'), [
              const Text('پشتیبان‌گیری', style: Web.b),
              const SizedBox(height: 6),
              const Text(
                'هر ساعت خودکار گرفته می‌شود و ۴۸ نسخه نگه داشته می‌شود.',
                style: _note,
              ),
              _btns([
                WebBtn(
                  'پشتیبان همین حالا',
                  key: const Key('sys-backup-now'),
                  onPressed: c.busy ? null : c.backupNow,
                ),
                WebBtn(
                  'فهرست نسخه‌ها',
                  key: const Key('sys-backup-list'),
                  kind: WebBtnKind.ghost,
                  onPressed: c.busy ? null : c.listBackups,
                ),
              ], top: 8),
              if (c.backups case final b?)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: b.isEmpty
                      ? const Text(
                          'نسخه‌ای نیست.',
                          key: Key('sys-backups-none'),
                          style: _note,
                        )
                      : Column(
                          key: const Key('sys-backups'),
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            for (final f in b.take(48))
                              Text(
                                f,
                                textDirection: TextDirection.ltr,
                                style: _note,
                              ),
                          ],
                        ),
                ),
            ]),
            _col([
              const Text('حافظهٔ ابری', style: Web.b),
              const SizedBox(height: 6),
              const Text(
                'جایی که وقتی هیچ سیستمی روشن نیست، پیام‌ها و تکالیف نگه داشته می‌شوند تا اولین دستگاه همه را بردارد.',
                style: _note,
              ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: _btns([
                  WebBtn(
                    'تنظیم صندوقچه',
                    key: const Key('sys-cloud'),
                    onPressed: () {
                      if (!PulseInline.go(context, 'cloud')) {
                        widget.openCloud?.call();
                      }
                    },
                  ),
                ], top: 8),
              ),
            ]),
            _col(key: const Key('sys-dev-card'), [
              const Text('دستگاه‌های متصل', style: Web.b),
              const SizedBox(height: 6),
              if (c.devices == null)
                const Text('برای دیدن فهرست، دکمه را بزنید.', style: _note),
              if (c.devices case final ds? when ds.isEmpty)
                const Text(
                  'دستگاهی ثبت نشده.',
                  key: Key('sys-dev-none'),
                  style: _note,
                ),
              if (c.devices case final ds? when ds.isNotEmpty)
                WebList(
                  children: [
                    for (final d in ds)
                      WebItem(
                        key: Key('sys-dev-${d.id}'),
                        title: '${c.ownerOf(d)} · ${roleFa[d.role] ?? d.role}',
                        sub:
                            '${d.name.isEmpty ? '—' : d.name} · ${d.platform} · ${d.revoked ? 'باطل' : 'فعال'}',
                        actions: [
                          if (d.revoked)
                            const WebBadge('باطل', tone: WebTone.red)
                          else
                            WebBtn.delete(
                              'ابطال',
                              key: Key('sys-revoke-${d.id}'),
                              onPressed: c.busy ? null : () => _revoke(d),
                            ),
                        ],
                      ),
                  ],
                ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: _btns([
                  WebBtn(
                    'نمایش دستگاه‌ها',
                    key: const Key('sys-devices'),
                    onPressed: c.busy ? null : c.listDevices,
                  ),
                ], top: 8),
              ),
            ]),
            _col([
              const Text('تنظیمات مدرسه', style: Web.b),
              const SizedBox(height: 8),
              WebField(
                label: 'نام مدرسه',
                child: TextField(
                  key: const Key('sys-name'),
                  controller: name,
                  style: const TextStyle(fontSize: 15, color: Web.ink),
                  // row 166: the refused field is outlined red
                  decoration: webInput(
                    error: fieldIssueFor(c.error, 'نام مدرسه', name.text),
                  ),
                ),
              ),
              _btns([
                WebBtn(
                  'ذخیره',
                  key: const Key('sys-settings-save'),
                  onPressed: c.busy ? null : () => c.saveSettings(name.text),
                ),
                WebBtn(
                  'مشخصات مدرسه',
                  key: const Key('sys-profile'),
                  kind: WebBtnKind.ghost,
                  onPressed: () => openSchoolProfile(context, c.admin),
                ),
              ]),
              const SizedBox(height: 8),
              const Text(
                'قابلیت‌ها، مقطع، نوع، جنسیت، شیفت، آمار، تلفن‌ها، روزهای کاری و پنجرهٔ موجه در «مشخصات مدرسه».',
                style: _note,
              ),
            ]),
            _col(key: const Key('sys-stats'), [
              const Text('آمار پایگاه داده', style: Web.b),
              const SizedBox(height: 6),
              Text(
                'کاربران: ${_fa(c.stats['users'] ?? 0)} · کلاس‌ها: ${_fa(c.stats['classes'] ?? 0)} · حضور: ${_fa(c.stats['attendance'] ?? 0)} · نمره: ${_fa(c.stats['grades'] ?? 0)}',
                key: const Key('sys-stats-text'),
                style: _note,
              ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: _btns([
                  WebBtn(
                    'سابقهٔ تغییرات',
                    key: const Key('sys-audit'),
                    onPressed: c.busy ? null : c.listAudit,
                  ),
                ], top: 8),
              ),
              for (final (i, a) in (c.audit ?? const <AuditEntry>[]).indexed)
                Text(
                  '${JalaliDate.fromIso(a.at)?.slash ?? a.at} · ${faDigits(a.user)} · ${a.action} · ${a.collection}',
                  key: Key('sys-audit-$i'),
                  style: _note,
                ),
            ]),
          ],
          _col(key: const Key('sys-guide'), [
            const Text('راهنمای دستگاه‌ها', style: Web.b),
            const SizedBox(height: 6),
            const Text(
              'همهٔ دستگاه‌ها از طریق حافظهٔ مشترک ابری به همین اطلاعات می‌رسند؛ آدرس زیر فقط آدرس همین دستگاه است:',
              style: _note,
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(
                server == null ? '—' : server.origin,
                key: const Key('sys-guide-url'),
                textDirection: TextDirection.ltr,
                style: _note.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            if (server != null && app?.openUrl != null)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: InkWell(
                  key: const Key('sys-guide-install'),
                  onTap: () => app!.openUrl!(server.resolve('/install')),
                  child: const Text(
                    'صفحهٔ نصب و راهنما',
                    style: TextStyle(
                      fontSize: 12.5,
                      color: Web.primary,
                      height: 1.9,
                    ),
                  ),
                ),
              ),
          ]),
          // Native only: the web panel has this check on its sign-in page; the app keeps it
          // here, last, so a device that gets no data can still see where it is stuck.
          _col(key: const Key('sys-diag-card'), [
            const Text('بررسی اتصال این دستگاه', style: Web.b),
            const SizedBox(height: 6),
            const Text(
              'اگر اطلاعات به این دستگاه نمی‌رسد، این دکمه گام‌به‌گام بررسی می‌کند کجا گیر است.',
              style: _note,
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: _btns([
                WebBtn(
                  'بررسی دقیق اتصال',
                  key: const Key('sys-diagnose'),
                  onPressed: c.busy ? null : c.diagnose,
                ),
              ], top: 8),
            ),
            for (final (i, s) in (c.diagnosis ?? const []).indexed)
              Text(
                '${s.ok ? '✅' : '❌'} ${s.textFa}${s.detail.isEmpty ? '' : ' — ${faDigits(s.detail)}'}',
                key: Key('sys-diag-$i'),
                style: _plain.copyWith(height: 2),
              ),
            // Row 172: this device's own controls (support, the previous web version,
            // sign-out) — the native shell has no menu any more, like the web panel.
            if (PulseInline.extrasOf(context) case final x?) ...[
              const SizedBox(height: 10),
              x(context),
            ],
          ]),
        ],
      );
    },
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

  /// Row 165: why the settings could not be read (shown as a calm empty state with «دوباره»,
  /// not as the red bar over a page stuck on «در حال خواندن…»).
  String? loadError;

  @override
  Future<void> load() async {
    if (busy) return;
    loading = true;
    loadError = null;
    emit();
    final ok = await online((a) async {
      config = await a.cloud();
      return null;
    });
    if (!ok && config == null && admin != null) {
      loadError = error ?? const AdminFailure(AdminError.offline).messageFa;
      error = null;
    }
    // Row 172: with no school server the empty card already says so — no red bar on top.
    if (admin == null) error = null;
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
  ) => Padding(
    padding: const EdgeInsets.only(top: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        WebBadge(
          o.headlineFa,
          key: Key('$prefix-head'),
          tone: o.ok ? WebTone.green : WebTone.amber,
        ),
        const SizedBox(height: 6),
        for (final (i, st) in o.steps.indexed)
          Text(
            '${st.ok ? '✅' : '❌'} ${st.name}${st.ms > 0 ? ' · ${_fa(st.ms)}ms' : ''}${st.note.isEmpty ? '' : ' — ${st.note}'}',
            key: Key('$prefix-step-$i'),
            style: const TextStyle(fontSize: 12.5, height: 1.9),
          ),
      ],
    ),
  );

  static const _note = TextStyle(fontSize: 12.5, color: Web.muted, height: 1.9);

  Widget _field(String k, String label, TextEditingController t, bool hide) =>
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: WebField(
          label: label,
          child: TextField(
            key: Key(k),
            controller: t,
            obscureText: hide,
            textDirection: TextDirection.ltr,
            style: const TextStyle(fontSize: 15, color: Web.ink),
            decoration: webInput(
              hint: k == 'cld-secret'
                  ? 'کلید خصوصی فعلی می‌ماند'
                  : k == 'cld-endpoint'
                  // web placeholder names the storage host; D-36 keeps storage hosts out of
                  // native code, so only the shape is shown
                  ? 'https://s3.ir-central1.…'
                  : k == 'cld-region'
                  ? 'ir-central1'
                  : null,
              error: fieldIssueFor(c.error, label, t.text),
            ),
          ),
        ),
      );

  /// Row 172: web `PAGES.cloud` exactly — pageHead «حافظهٔ ابری» + «جایی در اینترنت که همهٔ
  /// دستگاه‌ها رویش می‌نویسند»; the «صندوقچه» note card; «وضعیت صندوقچه»; the change form;
  /// «📱 دسترسی گوشی‌ها»; «CORS — اجازهٔ مرورگر».
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final cfg = c.config;
      final ready = cfg?.configured ?? false;
      return SchoolPage(
        prefix: 'cld',
        title: 'حافظهٔ ابری',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub: 'جایی در اینترنت که همهٔ دستگاه‌ها رویش می‌نویسند',
        children: [
          const WebCard(
            child: Text(
              'وقتی هیچ سیستمی در مدرسه روشن نیست، پیام‌ها و تکالیف باید جایی بمانند تا اولین دستگاهِ روشن‌شده همه را بردارد. '
              'اینجا همان «صندوقچه» است.',
              style: _note,
            ),
          ),
          if (cfg == null)
            _CloudEmpty(
              offline: c.admin == null || c.loadError != null,
              text: c.admin == null
                  ? 'این تنظیمات روی سرور مدرسه است؛ این دستگاه الان به سرور مدرسه وصل نیست.'
                  : c.loadError != null
                  ? 'سرور مدرسه جواب نداد، پس تنظیمات خوانده نشد. سرور مدرسه روشن باشد و این گوشی به آن (یا به اینترنت) وصل باشد، بعد «دوباره» را بزنید.'
                  : 'در حال خواندن تنظیمات…',
              onRetry: c.admin == null || c.busy ? null : c.load,
            )
          else
            WebCard(
              key: const Key('cld-card'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text('وضعیت صندوقچه', style: Web.b),
                      ),
                      WebBadge(
                        cfg.stateFa,
                        key: const Key('cld-state'),
                        tone: ready ? WebTone.green : WebTone.amber,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (cfg.fromOwner)
                    Text(
                      '✅ همان دیتابیسی که مالک در پنل مدیریت تعریف کرده است؛ اگر مالک آن را عوض کند، این سرور خودش به‌روز می‌شود.\n'
                      'صندوقچه: ${cfg.bucket.isEmpty ? '—' : cfg.bucket}\nسرور: ${cfg.endpoint}',
                      key: const Key('cld-owner'),
                      style: _note,
                    )
                  else if (cfg.builtIn)
                    Text.rich(
                      TextSpan(
                        style: _note,
                        children: [
                          const TextSpan(text: '✅ '),
                          const TextSpan(
                            text: 'از قبل داخل برنامه تنظیم شده است',
                            style: TextStyle(fontWeight: FontWeight.w700),
                          ),
                          const TextSpan(text: ' — لازم نیست چیزی وارد کنید.'),
                          TextSpan(
                            text: cfg.bucket.isEmpty
                                ? '\nنام صندوقچه به‌زودی خودکار پیدا می‌شود (به اینترنت نیاز دارد).'
                                : '\nصندوقچه: ${cfg.bucket}',
                          ),
                          TextSpan(text: '\nسرور: ${cfg.endpoint}'),
                        ],
                      ),
                      key: const Key('cld-builtin'),
                    )
                  else
                    Text(
                      'تنظیمات دستی روی این دستگاه فعال است (بر پیش‌فرضِ داخل برنامه مقدم است).',
                      key: const Key('cld-manual'),
                      style: _note,
                    ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      WebBtn(
                        'آزمایش اتصال',
                        key: const Key('cld-test'),
                        onPressed: c.busy || !ready ? null : c.test,
                      ),
                      WebBtn(
                        'تنظیم خودکار CORS',
                        key: const Key('cld-cors'),
                        kind: WebBtnKind.ghost,
                        onPressed: c.busy || !ready ? null : c.cors,
                      ),
                      WebBtn(
                        c.editing ? 'بستن کادر تغییر' : 'تغییر تنظیمات',
                        key: const Key('cld-edit'),
                        kind: WebBtnKind.ghost,
                        onPressed: _toggle,
                      ),
                      if (!cfg.builtIn)
                        WebBtn(
                          'بازگشت به پیش‌فرض برنامه',
                          key: const Key('cld-reset'),
                          kind: WebBtnKind.ghost,
                          onPressed: c.busy ? null : c.reset,
                        ),
                    ],
                  ),
                  if (c.outcome case final o?) _outcome(context, o, 'cld-out'),
                ],
              ),
            ),
          if (cfg != null && c.editing)
            WebCard(
              key: const Key('cld-form'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('تنظیمات صندوقچه (تغییر)', style: Web.b),
                  const SizedBox(height: 4),
                  const Text(
                    'فقط وقتی لازم است که صندوقچه عوض شود. مقدار خالی = همان مقدار فعلی می‌ماند.',
                    style: Web.small,
                  ),
                  _field(
                    'cld-endpoint',
                    'آدرس سرویس (Endpoint)',
                    endpoint,
                    false,
                  ),
                  _field(
                    'cld-bucket',
                    'نام صندوقچه (اختیاری — خودکار پیدا می‌شود)',
                    bucket,
                    false,
                  ),
                  _field('cld-region', 'منطقه (اختیاری)', region, false),
                  _field(
                    'cld-access',
                    'کلید عمومی (Access Key)',
                    access,
                    false,
                  ),
                  _field('cld-secret', 'کلید خصوصی (Secret Key)', secret, true),
                  const SizedBox(height: 6),
                  const Text(
                    'کلید فقط روی سرور می‌ماند و هرگز به مرورگر/گوشی برنمی‌گردد؛ برای تغییر، مقدار تازه بگذارید. تست اتصال هم فقط از سرور انجام می‌شود.',
                    style: Web.small,
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: WebBtn(
                      'ذخیرهٔ تنظیمات تازه',
                      key: const Key('cld-save'),
                      onPressed: c.busy ? null : _save,
                    ),
                  ),
                ],
              ),
            ),
          WebCard(
            key: const Key('cld-phone-card'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('📱 دسترسی گوشی‌ها', style: Web.b),
                const SizedBox(height: 6),
                const Text(
                  'گوشی و رایانهٔ خانه با همین حافظهٔ مشترک کار می‌کنند. این دکمه همه‌چیز را خودش بررسی و درست می‌کند: '
                  'صندوقچه پیدا می‌شود، اجازهٔ خواندن برای گوشی گذاشته می‌شود، و نتیجه را همین‌جا می‌بینید.',
                  style: _note,
                ),
                const SizedBox(height: 10),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: WebBtn(
                    'بررسی و درست‌کردن دسترسی گوشی',
                    key: const Key('cld-phone'),
                    kind: WebBtnKind.primary,
                    onPressed: c.busy || c.admin == null ? null : c.phoneCheck,
                  ),
                ),
                if (c.phone case final p?) _outcome(context, p, 'cld-phone'),
              ],
            ),
          ),
          const WebCard(
            key: Key('cld-cors-card'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('CORS — اجازهٔ مرورگر', style: Web.b),
                SizedBox(height: 6),
                Text.rich(
                  TextSpan(
                    style: _note,
                    children: [
                      TextSpan(
                        text: 'گوشی‌ها مستقیم با صندوقچه حرف می‌زنند، پس صندوقچه باید به مرورگر اجازه بدهد. دکمهٔ ',
                      ),
                      TextSpan(
                        text: '«تنظیم خودکار CORS»',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      TextSpan(
                        text:
                            ' همین کار را از داخل برنامه انجام می‌دهد؛ لازم نیست در پنل دنبالش بگردید. '
                            'اگر کلید اجازهٔ مدیریت صندوقچه را نداشت، باید در پنل '
                            '(فضای ابری ← صندوقچه ← عملیات ← تنظیمات CORS) دستی یک قانون با * و متدهای GET, PUT, DELETE, HEAD بسازید.',
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      );
    },
  );
}

/// Row 165: settings not (yet) read — spinner while reading; otherwise an icon, one clear
/// sentence and «دوباره» (never a page stuck on «در حال خواندن…» under a red bar).
class _CloudEmpty extends StatelessWidget {
  const _CloudEmpty({
    required this.offline,
    required this.text,
    required this.onRetry,
  });

  final bool offline;
  final String text;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return WebCard(
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: PayeshTokens.space4,
          vertical: PayeshTokens.space3,
        ),
        child: Column(
          children: [
            if (offline)
              Icon(Icons.cloud_off_outlined, size: 40, color: t.muted)
            else
              const SizedBox.square(
                dimension: 28,
                child: CircularProgressIndicator(strokeWidth: 3),
              ),
            const SizedBox(height: PayeshTokens.space3),
            Text(
              text,
              key: const Key('cld-none'),
              textAlign: TextAlign.center,
              style: TextStyle(color: t.muted, fontSize: 13.5, height: 1.7),
            ),
            if (offline && onRetry != null) ...[
              const SizedBox(height: PayeshTokens.space3),
              OutlinedButton.icon(
                key: const Key('cld-retry'),
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('دوباره'),
              ),
            ],
          ],
        ),
      ),
    );
  }
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
    return WebItem(
      key: Key('hlt-row-${r.check.id}'),
      title:
          '${ok ? '✅' : switch (sev) {
                  HealthSeverity.critical => '🔴',
                  HealthSeverity.warning => '🟡',
                  HealthSeverity.info => '🔵',
                }} ${r.check.title}',
      subWidget: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            ok ? 'درست است' : r.result.message,
            style: const TextStyle(fontSize: 12, color: Web.muted),
          ),
          if (!ok && r.check.guide.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('💡 ${r.check.guide}', style: Web.small),
            ),
        ],
      ),
      actions: ok
          ? const [WebBadge('سالم', tone: WebTone.green)]
          : [
              WebBadge(
                _fa(r.result.count),
                key: Key('hlt-count-${r.check.id}'),
                tone: switch (sev) {
                  HealthSeverity.critical => WebTone.red,
                  HealthSeverity.warning => WebTone.amber,
                  HealthSeverity.info => WebTone.none,
                },
              ),
              WebBtn(
                'دیدن موارد',
                key: Key('hlt-open-${r.check.id}'),
                kind: WebBtnKind.ghost,
                onPressed: () => _open(r.check),
              ),
              if (r.check.autoFix)
                WebBtn(
                  'اصلاح خودکار',
                  key: Key('hlt-fix-${r.check.id}'),
                  onPressed: c.busy ? null : () => _fix(r),
                ),
            ],
    );
  }

  /// Row 172: web `diagPageHtml()` exactly — pageHead «سلامت داده» + «N مورد برای رسیدگی» /
  /// «همه چیز سالم است» with «🔄 بررسی دوباره»; the summary card; «ایرادها»; «سالم»; the note.
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final run = c.last;
      final bad = run?.bad ?? const <HealthRow>[];
      return SchoolPage(
        prefix: 'hlt',
        title: 'سلامت داده',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub: run == null
            ? null
            : bad.isNotEmpty
            ? '${_fa(bad.length)} مورد برای رسیدگی'
            : 'همه چیز سالم است',
        headActions: [
          WebBtn(
            '🔄 بررسی دوباره',
            key: const Key('hlt-rerun'),
            onPressed: c.rerun,
          ),
        ],
        children: run == null
            ? const []
            : [
                WebCard.tight(
                  key: const Key('hlt-summary'),
                  child: Wrap(
                    alignment: WrapAlignment.spaceBetween,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            bad.isEmpty
                                ? '✅ همهٔ آزمون‌ها سالم‌اند'
                                : '🔎 ${_fa(bad.length)} آزمون ایراد پیدا کرد',
                            style: Web.b,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${run.critical > 0 ? '${_fa(run.critical)} بحرانی' : 'بدون بحرانی'} · '
                            '${run.warning > 0 ? '${_fa(run.warning)} هشدار' : 'بدون هشدار'}'
                            ' · آخرین بررسی: ${Web.fa(Web.clock24('${run.at.hour}:${run.at.minute.toString().padLeft(2, '0')}'))}',
                            key: const Key('hlt-summary-text'),
                            style: Web.small,
                          ),
                        ],
                      ),
                      Text('${_fa(run.rows.length)} آزمون', style: Web.small),
                    ],
                  ),
                ),
                if (bad.isNotEmpty)
                  WebCard(
                    key: const Key('hlt-bad'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text('ایرادها', style: Web.b),
                        const SizedBox(height: 6),
                        WebList(
                          children: [for (final r in bad) _row(context, r)],
                        ),
                      ],
                    ),
                  ),
                if (run.good.isNotEmpty)
                  WebCard(
                    key: const Key('hlt-good'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text('سالم', style: Web.b),
                        const SizedBox(height: 6),
                        WebList(
                          children: [
                            for (final r in run.good) _row(context, r),
                          ],
                        ),
                      ],
                    ),
                  ),
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    '«اصلاح خودکار» فقط برای موردهایی است که هیچ داده‌ای از بین نمی‌رود (مثل ردیف تکراریِ اضافی). '
                    'برای کد ملی تکراری یا دو حساب از یک نفر، خودتان «ادغام» را بزنید تا نمرات و حضور و والدین منتقل شوند.',
                    style: TextStyle(
                      fontSize: 12.5,
                      color: Web.muted,
                      height: 2,
                    ),
                  ),
                ),
              ],
      );
    },
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

// ─────────────────────────────────── network ───────────────────────────────────

/// Row 172: web `PAGES.network` — `loadNetwork`, `net-refresh`, the tunnel actions and
/// `outbox-sync` (client/app.js), on the school server through [ServerAdminApi].
class NetworkController extends SchoolController with _Online {
  NetworkController({
    required super.source,
    required super.role,
    required super.uid,
  });

  NetworkState? state;
  String? loadError;

  /// Web `S.tunnelBusy`.
  bool tunnelBusy = false;

  @override
  Future<void> read(SchoolRecords db) async {}

  @override
  Future<void> load({bool force = false}) async {
    if (busy) return;
    loading = true;
    loadError = null;
    emit();
    final ok = await online((a) async {
      final n = await a.network(force: force);
      var pending = 0;
      try {
        pending = await a.outboxCheck();
      } on AdminFailure {
        // the web keeps the last outbox state when it cannot read it
      }
      state = n.copyWith(outboxPending: pending);
      return null;
    });
    if (!ok && state == null && admin != null) {
      loadError = error ?? const AdminFailure(AdminError.offline).messageFa;
      error = null;
    }
    if (admin == null) error = null;
    loading = false;
    emit();
  }

  /// `net-refresh`.
  Future<void> refresh() => load(force: true);

  /// The address form (web `data-form="network"`): '' clears the address.
  Future<bool> save(String url) async {
    final ok = await online((a) async {
      await a.saveNetwork(url.trim());
      state = (await a.network(force: true))
          .copyWith(outboxPending: state?.outboxPending ?? 0);
      return 'ذخیره شد';
    });
    return ok;
  }

  Future<void> _tunnel(
    Future<String?> Function(ServerAdminApi a) op, {
    bool reload = true,
  }) async {
    tunnelBusy = true;
    emit();
    await online((a) async {
      final msg = await op(a);
      if (reload) {
        state = (await a.network(force: true))
            .copyWith(outboxPending: state?.outboxPending ?? 0);
      }
      return msg;
    });
    tunnelBusy = false;
    emit();
  }

  /// `tunnel-refresh`.
  Future<void> tunnelRefresh() => _tunnel((a) async {
    final t = await a.tunnel();
    state = (state ?? const NetworkState()).copyWith(public: t);
    if (t.publicUrl.isEmpty) {
      throw const AdminFailure(AdminError.unknown, 'آدرس عمومی فعال نیست');
    }
    return 'آدرس عمومی فعال است';
  }, reload: false);

  /// `tunnel-enable`.
  Future<void> tunnelEnable() => _tunnel((a) async {
    final r = await a.tunnelAction('enable');
    if (!r.ok) {
      throw AdminFailure(
        AdminError.unknown,
        r.error == 'tailscale_not_installed'
            ? 'Tailscale نصب نیست'
            : r.error == 'tailscale_not_logged_in'
            ? 'اول وارد Tailscale شوید'
            : 'فعال‌سازی ناموفق: ${r.detail.isNotEmpty ? r.detail : r.error}',
      );
    }
    return 'آدرس عمومی فعال شد: ${r.url}';
  });

  /// `tunnel-off` (after the confirm).
  Future<void> tunnelOff() => _tunnel((a) async {
    await a.tunnelAction('off');
    return 'دسترسی اینترنتی قطع شد';
  });

  /// `tunnel-login`: the server opens the browser on itself; [openDownload] gets the
  /// installer link when Tailscale is missing. The state is read again after 4 seconds.
  Future<void> tunnelLogin(
    void Function(String url) openDownload, {
    Duration after = const Duration(seconds: 4),
  }) async {
    await online((a) async {
      final r = await a.tunnelAction('login');
      if (r.ok) {
        return r.message.isNotEmpty ? r.message : 'مرورگر برای ورود باز شد';
      }
      if (r.download.isNotEmpty) {
        openDownload(r.download);
        return 'Tailscale را نصب کنید و دوباره برگردید';
      }
      throw AdminFailure(
        AdminError.unknown,
        'ناموفق: ${r.detail.isNotEmpty ? r.detail : r.error}',
      );
    });
    await Future<void>.delayed(after);
    await load(force: true);
  }

  /// `outbox-sync`.
  Future<void> outboxSync() => online((a) async {
    final pending = await a.outboxCheck(drain: true);
    state = state?.copyWith(outboxPending: pending);
    if (pending > 0) {
      throw AdminFailure(
        AdminError.unknown,
        '${_fa(pending)} ثبت هنوز منتظر است',
      );
    }
    return 'همه‌چیز اعمال شده است';
  });
}

class NetworkScreen extends StatefulWidget {
  const NetworkScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final NetworkController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  /// «باز کردن» — opens a link in the system browser (tests replace it).
  static Future<bool> Function(String url) open = openExternalUrl;

  @override
  State<NetworkScreen> createState() => _NetworkScreenState();
}

class _NetworkScreenState extends State<NetworkScreen> {
  NetworkController get c => widget.controller;
  final url = TextEditingController();
  String? _shown;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    url.dispose();
    super.dispose();
  }

  static const _note = Web.small;

  void _copy(String text) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(const SnackBar(content: Text('آدرس کپی شد')));
  }

  Widget _qr(String text, String k) {
    final a = c.admin;
    return Container(
      key: Key(k),
      width: 150,
      height: 150,
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
      ),
      child: a == null
          ? const SizedBox.shrink()
          : Image.network(
              a.server
                  .resolve(
                    '/api/qr?text=${Uri.encodeQueryComponent(text)}&scale=6',
                  )
                  .toString(),
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
            ),
    );
  }

  /// `.row between` with the QR at the end, wrapping under 520px like the web flex row.
  Widget _withQr(Widget text, Widget? qr) => LayoutBuilder(
    builder: (context, box) {
      if (qr == null) return text;
      if (box.maxWidth < 420) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [text, const SizedBox(height: 10), qr],
        );
      }
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: text),
          const SizedBox(width: 12),
          qr,
        ],
      );
    },
  );

  Widget _head(String title, Widget badge) => Row(
    children: [
      Expanded(child: Text(title, style: Web.b)),
      badge,
    ],
  );

  Future<void> _off() async {
    final ok = await confirmAction(
      context,
      prefix: 'net-off',
      title: 'قطع دسترسی اینترنتی',
      message: 'دسترسی از اینترنت قطع شود؟ بعد از این، برنامه فقط داخل شبکهٔ مدرسه باز می‌شود.',
      confirm: 'قطع',
    );
    if (ok && mounted) await c.tunnelOff();
  }

  Widget _publicCard(NetworkState n) {
    final p = n.public;
    final on = p.publicUrl.isNotEmpty;
    final busy = c.tunnelBusy;
    final (stateText, tone) = on
        ? (
            'فعال — ${RegExp(r'ts\.net$').hasMatch(p.publicUrl) ? 'Tailscale' : 'دستی'}',
            WebTone.green,
          )
        : p.installed && !p.loggedIn
        ? ('Tailscale نصب است، وارد نشده', WebTone.amber)
        : !p.installed
        ? ('ابزاری نصب نیست', WebTone.red)
        : ('خاموش', WebTone.amber);
    Widget buttons(List<Widget> b) => Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(spacing: 6, runSpacing: 6, children: b),
    );
    final refresh = WebBtn(
      busy ? '…' : 'بازبینی',
      key: const Key('net-tunnel-refresh'),
      kind: on ? WebBtnKind.normal : WebBtnKind.ghost,
      onPressed: c.busy ? null : c.tunnelRefresh,
    );
    final login = c.tunnelLogin;
    void download(String u) => NetworkScreen.open(u);
    final List<Widget> body;
    if (on) {
      body = [
        const Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text(
            'آدرس شما، از هر اینترنتی (خانه، مسافرت، موبایل) کار می‌کند:',
            style: _note,
          ),
        ),
        Container(
          margin: const EdgeInsets.only(top: 6),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: Web.soft,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            p.publicUrl,
            key: const Key('net-public-url'),
            textDirection: TextDirection.ltr,
            style: const TextStyle(fontWeight: FontWeight.w700, color: Web.ink),
          ),
        ),
        buttons([
          WebBtn(
            'کپی آدرس',
            key: const Key('net-public-copy'),
            onPressed: () => _copy(p.publicUrl),
          ),
          refresh,
          WebBtn(
            'قطع دسترسی اینترنتی',
            key: const Key('net-tunnel-off'),
            kind: WebBtnKind.ghost,
            onPressed: c.busy ? null : _off,
          ),
        ]),
      ];
    } else if (p.installed && !p.loggedIn) {
      body = [
        const Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text(
            'Tailscale نصب است ولی وارد حساب نشده. یک‌بار وارد شوید (مرورگر باز می‌شود) و بعد دکمهٔ فعال‌سازی را بزنید.',
            style: _note,
          ),
        ),
        buttons([
          WebBtn(
            'ورود به Tailscale',
            key: const Key('net-tunnel-login'),
            kind: WebBtnKind.primary,
            onPressed: c.busy ? null : () => login(download),
          ),
          WebBtn(
            'بازبینی وضعیت',
            key: const Key('net-tunnel-refresh'),
            onPressed: c.busy ? null : c.tunnelRefresh,
          ),
        ]),
      ];
    } else if (p.installed) {
      body = [
        const Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text(
            'Tailscale نصب و آماده است. با یک کلیک آدرس ثابت عمومی ساخته می‌شود (همان آدرسی که بعد از این، همه از هر اینترنتی وارد می‌شوند).',
            style: _note,
          ),
        ),
        buttons([
          WebBtn(
            busy ? 'در حال فعال‌سازی…' : 'فعال‌سازی آدرس عمومی',
            key: const Key('net-tunnel-enable'),
            kind: WebBtnKind.primary,
            onPressed: c.busy ? null : c.tunnelEnable,
          ),
          refresh,
        ]),
      ];
    } else {
      body = [
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: DefaultTextStyle.merge(
            style: const TextStyle(fontSize: 12.5, height: 2, color: Web.ink),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  TextSpan(
                    children: [
                      const TextSpan(text: '1. '),
                      TextSpan(
                        text: 'Tailscale',
                        style: const TextStyle(
                          color: Web.green,
                          decoration: TextDecoration.underline,
                        ),
                        recognizer: TapGestureRecognizer()
                          ..onTap = () => download(p.download),
                      ),
                      const TextSpan(
                        text: ' را روی همین سیستم نصب کنید (رایگان، بدون کارت بانکی).',
                      ),
                    ],
                  ),
                  key: const Key('net-ts-step-1'),
                ),
                const Text(
                  '2. با حساب رایگان وارد شوید و برگردید؛ بقیه‌اش یک کلیک است.',
                ),
              ],
            ),
          ),
        ),
        buttons([
          WebBtn(
            'ورود / نصب Tailscale',
            key: const Key('net-tunnel-login'),
            kind: WebBtnKind.primary,
            onPressed: c.busy ? null : () => login(download),
          ),
          refresh,
        ]),
      ];
    }
    return WebCard(
      key: const Key('net-public'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _head(
            '🌍 دسترسی از هر اینترنتی (تونل)',
            WebBadge(stateText, key: const Key('net-public-state'), tone: tone),
          ),
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              'هیچ کاربری لازم نیست روی مودم مدرسه باشد: سیستم مدرسه یک تونل خروجی می‌سازد و همه با یک آدرس HTTPS ثابت وصل می‌شوند.',
              style: _note,
            ),
          ),
          ...body,
          const Padding(
            padding: EdgeInsets.only(top: 10),
            child: Text(
              '🔒 با فعال شدن آدرس عمومی، سرور از اینترنت دیده می‌شود: رمز عبور همهٔ کاربران را جدی بگیرید و دستگاه‌های ناشناس را از «دستگاه‌ها» باطل کنید.',
              style: _note,
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _cards(NetworkState n) {
    final pub = n.publicUrl;
    final tun = n.probe;
    final lan = n.lanUrls;
    final (status, tone) = pub.isEmpty
        ? ('تنظیم نشده', WebTone.amber)
        : tun.reachable
        ? ('در دسترس از اینترنت', WebTone.green)
        : ('در دسترس نیست', WebTone.red);
    return [
      WebCard(
        key: const Key('net-url-card'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _head(
              'آدرس رسمی (HTTPS)',
              WebBadge(status, key: const Key('net-url-state'), tone: tone),
            ),
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'این آدرس را روی همهٔ گوشی‌ها و رایانه‌ها باز کنید. بدون آن، برنامه فقط داخل Wi-Fi مدرسه کار می‌کند.',
                style: _note,
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              key: const Key('net-url'),
              controller: url,
              textDirection: TextDirection.ltr,
              textAlign: TextAlign.left,
              keyboardType: TextInputType.url,
              autocorrect: false,
              style: const TextStyle(fontSize: 15, color: Web.ink),
              decoration: webInput(hint: 'https://payesh.school.ts.net'),
            ),
            const SizedBox(height: 8),
            WebBtn(
              'ذخیرهٔ آدرس',
              key: const Key('net-url-save'),
              kind: WebBtnKind.primary,
              size: WebBtnSize.normal,
              block: true,
              onPressed: c.busy ? null : () => c.save(url.text),
            ),
            if (tun.reachable)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'آخرین بررسی: ${tun.latencyMs != null ? '${_fa(tun.latencyMs!)} میلی‌ثانیه' : '—'}'
                  '${tun.sameServer == false ? ' · ⚠ پاسخ از سرور دیگری آمد' : ''}',
                  key: const Key('net-url-checked'),
                  style: _note,
                ),
              )
            else if (tun.configured)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'تونل پاسخ نداد (${tun.error.isEmpty ? 'نامشخص' : tun.error}) — Tailscale Funnel روی سیستم روشن است؟',
                  key: const Key('net-url-fail'),
                  style: _note.copyWith(color: Web.deleteInk),
                ),
              ),
          ],
        ),
      ),
      if (pub.isNotEmpty)
        WebCard(
          key: const Key('net-qr-card'),
          child: _withQr(
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('کد QR برای نصب سریع', style: Web.b),
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    'این کد را روی تخته بزنید یا در گروه بفرستید؛ با دوربین گوشی باز می‌شود.',
                    style: _note,
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [
                    WebBtn(
                      'باز کردن',
                      key: const Key('net-pub-open'),
                      onPressed: () => NetworkScreen.open(pub),
                    ),
                    WebBtn(
                      'کپی آدرس',
                      key: const Key('net-pub-copy'),
                      onPressed: () => _copy(pub),
                    ),
                  ],
                ),
              ],
            ),
            _qr(pub, 'net-pub-qr'),
          ),
        ),
      _publicCard(n),
      WebCard(
        key: const Key('net-lan-card'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _withQr(
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('آدرس‌های شبکهٔ محلی', style: Web.b),
                  const SizedBox(height: 6),
                  if (lan.isEmpty)
                    const Text('—', style: _note)
                  else
                    for (final (i, u) in lan.indexed)
                      // `.ltr` = direction ltr, so the address sits on the left of its column
                      SizedBox(
                        width: double.infinity,
                        child: Text(
                          u,
                          key: Key('net-lan-$i'),
                          textDirection: TextDirection.ltr,
                          style: _note,
                        ),
                      ),
                  const Padding(
                    padding: EdgeInsets.only(top: 6),
                    child: Text(
                      'این آدرس‌ها فقط وقتی گوشی به همان Wi-Fi مدرسه وصل است کار می‌کنند.',
                      style: _note,
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text(
                      'اگر گوشی با همین Wi-Fi هم وصل نشد، احتمالاً Wi-Fi مدرسه اجازهٔ ارتباط دستگاه‌ها با هم را نمی‌دهد (Client Isolation) — در این حالت فقط آدرس رسمی HTTPS بالا کار می‌کند.',
                      style: _note,
                    ),
                  ),
                  if (lan.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          WebBtn(
                            'کپی آدرس محلی',
                            key: const Key('net-lan-copy'),
                            onPressed: () => _copy(lan.first),
                          ),
                          WebBtn(
                            'باز کردن',
                            key: const Key('net-lan-open'),
                            onPressed: () => NetworkScreen.open(lan.first),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
              lan.isEmpty ? null : _qr(lan.first, 'net-lan-qr'),
            ),
            if (lan.isNotEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'گوشی داخل مدرسه: این کد را با دوربین گوشی اسکن کنید — بدون تایپ هیچ آدرسی باز می‌شود.',
                  style: _note,
                ),
              ),
          ],
        ),
      ),
      WebCard(
        key: const Key('net-outbox'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _head(
              '📥 صندوقچهٔ آفلاین',
              n.outboxPending > 0
                  ? const WebBadge(
                      'در انتظار اعمال',
                      key: Key('net-outbox-state'),
                      tone: WebTone.amber,
                    )
                  : const WebBadge(
                      'خالی',
                      key: Key('net-outbox-state'),
                      tone: WebTone.green,
                    ),
            ),
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text(
                'وقتی بعضی دستگاه‌ها خاموش‌اند، ثبت‌هایشان این‌جا می‌ماند و اولین دستگاهی که روشن شود (مدرسه، خانه یا گوشیِ کادر) خودکار اعمالشان می‌کند — لازم نیست کسی کاری کند.',
                style: _note,
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: WebBtn(
                  'بررسی و اعمال اکنون',
                  key: const Key('net-outbox-sync'),
                  onPressed: c.busy ? null : c.outboxSync,
                ),
              ),
            ),
          ],
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final n = c.state;
      // the field shows the saved address (web `value="${pub}"`) until the user edits it
      if (n != null && _shown != n.publicUrl) {
        _shown = n.publicUrl;
        url.text = n.publicUrl;
      }
      return SchoolPage(
        prefix: 'net',
        title: 'شبکه و دسترسی',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub:
            'هر کاربر اینترنت خودش را دارد؛ همه باید از یک آدرس ثابت وارد شوند',
        headActions: [
          WebBtn(
            'بازبینی',
            key: const Key('net-refresh'),
            onPressed: c.busy || c.admin == null ? null : c.refresh,
          ),
        ],
        children: [
          if (n == null)
            _CloudEmpty(
              offline: c.admin == null || c.loadError != null,
              text: c.admin == null
                  ? 'این تنظیمات روی سرور مدرسه است؛ این دستگاه الان به سرور مدرسه وصل نیست.'
                  : c.loadError != null
                  ? 'سرور مدرسه جواب نداد، پس تنظیمات شبکه خوانده نشد. سرور مدرسه روشن باشد و این دستگاه به آن وصل باشد، بعد «دوباره» را بزنید.'
                  : 'در حال خواندن تنظیمات شبکه…',
              onRetry: c.admin == null || c.busy ? null : c.load,
            )
          else
            ..._cards(n),
        ],
      );
    },
  );
}
