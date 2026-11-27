// نسخه + چراغ به‌روزرسانی (نوار بالا، همیشه پیدا، بدون نوشتهٔ اضافی):
//   سبز = به‌روز، نارنجی = نسخهٔ تازه آماده، قرمز = خطا، خاکستری = هنوز بررسی نشده.
//   هنگام بررسی، دریافت و نصب چراغ «زنده» است (ردیف ۱۴۸): هاله می‌تپد و حلقه با پیشرفت
//   دریافت پر می‌شود. لمس ⇒ بررسی؛ اگر نسخهٔ تازه هست ⇒ دریافت، نصب و باز شدن دوبارهٔ خودکار.

import 'dart:async';

import 'package:flutter/gestures.dart' show GestureBinding;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HardwareKeyboard;
import 'package:payesh_ui/payesh_ui.dart';

import 'updater.dart';
import 'whats_new.dart';

class UpdateLight extends StatefulWidget {
  const UpdateLight({
    super.key,
    required this.updater,
    this.openUrl,
    this.audience,
  });
  final AppUpdater updater;

  /// Row 180 design 2: with an audience, the minimal look draws the head pill as drawn —
  /// «✦ نسخهٔ x · تازه‌ها»; «تازه‌ها» opens the release history of that audience.
  final NoteAudience? audience;

  /// اندروید بدون نصب‌کنندهٔ بومی: بستهٔ کامل با مرورگر.
  final Future<void> Function(Uri url)? openUrl;

  @override
  State<UpdateLight> createState() => _UpdateLightState();
}

String _pct(double p) => '${faNumber((p * 100).floor())}٪';

class _UpdateLightState extends State<UpdateLight> {
  StreamSubscription<void>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.updater.changes.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  Future<void> _tap() async {
    final u = widget.updater;
    if (!u.isWindows &&
        u.apkInstaller == null &&
        (u.phase == UpdatePhase.ready ||
            (u.phase == UpdatePhase.failed && u.available))) {
      await (widget.openUrl ?? u.openUrl)?.call(u.apkUrl);
      return;
    }
    await u.tap();
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.updater;
    final tk = context.tokens;
    final next = u.plan?.manifest.build;
    final progress = u.progress;
    final (color, label) = switch (u.phase) {
      UpdatePhase.ready || UpdatePhase.staged => (
        tk.warning,
        u.error ??
            'نسخهٔ ${u.channel.versionOf(next ?? 0)} آماده است${u.relaySource == null ? '' : ' (از راه سرور مدرسه)'} — برای نصب لمس کنید',
      ),
      // ردیف ۱۹۷-Q05: مانیفست از راه سرور مدرسه آمد
      UpdatePhase.upToDate => (
        tk.success,
        u.relaySource == null ? 'به‌روز است' : 'به‌روز است (از راه سرور مدرسه)',
      ),
      UpdatePhase.failed => (
        tk.danger,
        '${u.error ?? 'بررسی ناموفق'}${u.available ? ' — برای تلاش دوباره لمس کنید' : ''}',
      ),
      UpdatePhase.checking => (tk.primary, 'در حال بررسی'),
      UpdatePhase.downloading => (
        tk.warning,
        progress == null ? 'در حال دریافت' : 'در حال دریافت ${_pct(progress)}',
      ),
      UpdatePhase.applying => (
        tk.warning,
        u.isWindows
            ? 'در حال نصب — برنامه بسته و دوباره باز می‌شود'
            : u.silentInstall
            ? 'در حال نصب — برنامه چند لحظه بسته می‌شود؛ سپس دوباره بازش کنید'
            : 'در حال نصب — پس از نصب برنامه دوباره باز می‌شود',
      ),
      UpdatePhase.idle => (tk.muted, 'بررسی به‌روزرسانی'),
    };
    final aud = widget.audience;
    if (aud != null &&
        tk.isMinimal &&
        MediaQuery.sizeOf(context).width >= PayeshTokens.mediumMax) {
      final calm =
          u.phase == UpdatePhase.idle || u.phase == UpdatePhase.upToDate;
      final ink = Theme.of(context).colorScheme.onSurface;
      return Semantics(
        button: true,
        label: '${u.channel.version} — $label',
        value: u.phase.name,
        liveRegion: u.busy,
        child: Tooltip(
          message: label,
          child: Container(
            key: ValueKey('update-pill-${u.phase.name}'),
            height: 38,
            decoration: BoxDecoration(
              color: tk.card,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: calm ? tk.line : color.withValues(alpha: 0.7),
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: Material(
              type: MaterialType.transparency,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  InkWell(
                    key: const Key('update-light'),
                    onTap: () => unawaited(_tap()),
                    child: Padding(
                      padding: const EdgeInsetsDirectional.fromSTEB(
                        12,
                        0,
                        4,
                        0,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.auto_awesome_outlined,
                            size: 15,
                            color: tk.link,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            'نسخهٔ ',
                            style: TextStyle(fontSize: 12.5, color: ink),
                          ),
                          Text(
                            u.channel.version,
                            key: const Key('app-version'),
                            textDirection: TextDirection.ltr,
                            style: TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                              color: ink,
                            ),
                          ),
                          const SizedBox(width: 6),
                          StatusDot(
                            key: ValueKey('update-light-${u.phase.name}'),
                            color: color,
                            busy: u.busy,
                            progress: progress,
                            size: calm ? 12 : 18,
                          ),
                        ],
                      ),
                    ),
                  ),
                  InkWell(
                    key: const Key('update-whats-new'),
                    onTap: () => unawaited(showReleaseHistory(context, aud)),
                    child: Padding(
                      padding: const EdgeInsetsDirectional.fromSTEB(
                        2,
                        0,
                        12,
                        0,
                      ),
                      child: Center(
                        child: Text(
                          '· تازه‌ها',
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: ink,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    return Semantics(
      button: true,
      label: '${u.channel.version} — $label',
      value: u.phase.name,
      liveRegion: u.busy,
      child: Tooltip(
        message: label,
        // ردیف ۱۵۱: قاب کپسولی با حاشیهٔ هم‌رنگ وضعیت، مثل کپسول «دیتابیس»
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
          child: Material(
            key: ValueKey('update-pill-${u.phase.name}'),
            color: color.withValues(alpha: 0.12),
            shape: StadiumBorder(
              side: BorderSide(color: color.withValues(alpha: 0.7)),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              key: const Key('update-light'),
              onTap: () => unawaited(_tap()),
              child: Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(12, 4, 8, 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      u.channel.version,
                      key: const Key('app-version'),
                      textDirection: TextDirection.ltr,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: Theme.of(context).colorScheme.onSurface,
                      ),
                    ),
                    const SizedBox(width: 6),
                    StatusDot(
                      key: ValueKey('update-light-${u.phase.name}'),
                      color: color,
                      busy: u.busy,
                      progress: progress,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// بررسی خودکار: نتیجهٔ به‌روزرسانی قبلی خوانده می‌شود، ۳۰ ثانیه پس از باز شدن بررسی (پس از
/// بررسی سلامتِ اسکریپت اعمال) و بعد هر ۳۰ دقیقه — چراغ رنگ عوض می‌کند. نصب فقط با لمس.
class AutoUpdateCheck extends StatefulWidget {
  const AutoUpdateCheck({
    super.key,
    required this.updater,
    required this.child,
    this.first = const Duration(seconds: 10),
    this.every = const Duration(minutes: 10),
    this.idleAfter = const Duration(seconds: 90),
  });
  final AppUpdater updater;
  final Widget child;
  final Duration first;
  final Duration every;

  /// ویندوز: اعمال (بستن و باز شدن دوباره) فقط پس از این مدت بی‌لمس و بی‌کلید.
  final Duration idleAfter;

  @override
  State<AutoUpdateCheck> createState() => _AutoUpdateCheckState();
}

/// ردیف ۱۹۸-U2: آخرین لمس/کلید کاربر در کل برنامه (برای اعمال پنهان به‌روزرسانی ویندوز).
abstract final class UserIdle {
  static DateTime _last = DateTime.now();
  static bool _on = false;

  static void mark() => _last = DateTime.now();

  static Duration get idleFor => DateTime.now().difference(_last);

  static void ensure() {
    if (_on) return;
    _on = true;
    GestureBinding.instance.pointerRouter.addGlobalRoute((_) => mark());
    HardwareKeyboard.instance.addHandler((_) {
      mark();
      return false;
    });
  }
}

class _AutoUpdateCheckState extends State<AutoUpdateCheck> {
  Timer? _timer;
  Timer? _applyRetry;

  bool _idle() => UserIdle.idleFor >= widget.idleAfter;

  Future<void> _run() async {
    final u = widget.updater;
    await u.autoUpdate(idle: _idle);
    // ویندوز: آماده ولی کاربر مشغول بود ⇒ هر دقیقه دوباره، تا بیکار شود
    _applyRetry?.cancel();
    if (u.phase == UpdatePhase.staged) {
      _applyRetry = Timer.periodic(const Duration(minutes: 1), (t) {
        if (u.phase != UpdatePhase.staged) {
          t.cancel();
          return;
        }
        if (_idle()) unawaited(u.applyAndRestart());
      });
    }
  }

  @override
  void initState() {
    super.initState();
    UserIdle.ensure();
    final u = widget.updater;
    u.readLastApply();
    _timer = Timer(widget.first, () {
      u.readLastApply();
      unawaited(_run());
      _timer = Timer.periodic(widget.every, (_) => unawaited(_run()));
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _applyRetry?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// ردیف ۱۶۵: کارت «نسخهٔ تازه» در صفحهٔ اصلی — وقتی نسخهٔ تازه پیدا شده (یا دریافت/نصب در جریان
/// است) با یک دکمهٔ روشن «نصب»؛ پیش‌تر فقط چراغ کوچک نارنجی بود و کاربر نمی‌دانست باید لمسش کند.
/// به‌روز یا هنوز بررسی‌نشده ⇒ هیچ.
class UpdateBanner extends StatefulWidget {
  const UpdateBanner({super.key, required this.updater, this.openUrl});
  final AppUpdater updater;
  final Future<void> Function(Uri url)? openUrl;

  @override
  State<UpdateBanner> createState() => _UpdateBannerState();
}

class _UpdateBannerState extends State<UpdateBanner> {
  StreamSubscription<void>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.updater.changes.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  Future<void> _install() async {
    final u = widget.updater;
    if (!u.isWindows && u.apkInstaller == null) {
      await (widget.openUrl ?? u.openUrl)?.call(u.apkUrl);
      return;
    }
    await u.tap();
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.updater;
    final show = switch (u.phase) {
      UpdatePhase.ready ||
      UpdatePhase.staged ||
      UpdatePhase.downloading ||
      UpdatePhase.applying => true,
      UpdatePhase.failed => u.available,
      _ => false,
    };
    if (!show) return const SizedBox.shrink(key: Key('update-banner-none'));
    final tk = context.tokens;
    final next = u.plan?.manifest.build;
    final progress = u.progress;
    final title = next == null
        ? 'نسخهٔ تازهٔ برنامه آماده است'
        : 'نسخهٔ ${u.channel.versionOf(next)} آماده است';
    final sub = switch (u.phase) {
      UpdatePhase.downloading =>
        progress == null ? 'در حال دریافت…' : 'در حال دریافت ${_pct(progress)}',
      UpdatePhase.applying =>
        u.isWindows
            ? 'در حال نصب — برنامه بسته و دوباره باز می‌شود'
            : u.silentInstall
            ? 'در حال نصب — برنامه چند لحظه بسته می‌شود؛ سپس دوباره بازش کنید'
            : 'نصب‌کنندهٔ اندروید باز شد — «نصب» را بزنید',
      UpdatePhase.failed => '${u.error ?? 'نصب ناموفق بود'} — دوباره بزنید',
      _ =>
        u.error ??
            'نسخهٔ فعلی ${u.channel.version} است. با «نصب» دریافت و نصب می‌شود؛ داده‌ها می‌مانند.',
    };
    final busy = u.busy;
    return Container(
      key: const Key('update-banner'),
      margin: const EdgeInsets.only(bottom: PayeshTokens.space4),
      padding: const EdgeInsets.all(PayeshTokens.space3),
      decoration: BoxDecoration(
        color: tk.warningBg,
        borderRadius: BorderRadius.circular(tk.cardRadius),
        border: Border.all(color: tk.warning.withValues(alpha: 0.5)),
      ),
      child: Row(
        children: [
          Icon(Icons.system_update_alt_rounded, color: tk.warning, size: 28),
          const SizedBox(width: PayeshTokens.space3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    color: tk.ink,
                    fontSize: 14.5,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  sub,
                  key: const Key('update-banner-text'),
                  style: TextStyle(
                    color: tk.muted,
                    fontSize: 12.5,
                    height: 1.5,
                  ),
                ),
                if (u.phase == UpdatePhase.downloading) ...[
                  const SizedBox(height: 6),
                  LinearProgressIndicator(value: progress),
                ],
              ],
            ),
          ),
          const SizedBox(width: PayeshTokens.space2),
          FilledButton(
            key: const Key('update-banner-install'),
            onPressed: busy ? null : () => unawaited(_install()),
            child: Text(u.phase == UpdatePhase.failed ? 'دوباره' : 'نصب'),
          ),
        ],
      ),
    );
  }
}
