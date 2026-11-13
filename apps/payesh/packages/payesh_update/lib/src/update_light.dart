// نسخه + چراغ به‌روزرسانی (نوار بالا، همیشه پیدا، بدون نوشتهٔ اضافی):
//   سبز = به‌روز، نارنجی = نسخهٔ تازه آماده، قرمز = خطا، خاکستری = هنوز بررسی نشده.
//   هنگام بررسی، دریافت و نصب چراغ «زنده» است (ردیف ۱۴۸): هاله می‌تپد و حلقه با پیشرفت
//   دریافت پر می‌شود. لمس ⇒ بررسی؛ اگر نسخهٔ تازه هست ⇒ دریافت، نصب و باز شدن دوبارهٔ خودکار.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'updater.dart';

class UpdateLight extends StatefulWidget {
  const UpdateLight({super.key, required this.updater, this.openUrl});
  final AppUpdater updater;

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
      await (widget.openUrl ?? u.openUrl)?.call(u.channel.apkUrl);
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
            'نسخهٔ ${u.channel.versionOf(next ?? 0)} آماده است — برای نصب لمس کنید',
      ),
      UpdatePhase.upToDate => (tk.success, 'به‌روز است'),
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
            : 'در حال نصب — پس از نصب برنامه دوباره باز می‌شود',
      ),
      UpdatePhase.idle => (tk.muted, 'بررسی به‌روزرسانی'),
    };
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
    this.first = const Duration(seconds: 30),
    this.every = const Duration(minutes: 30),
  });
  final AppUpdater updater;
  final Widget child;
  final Duration first;
  final Duration every;

  @override
  State<AutoUpdateCheck> createState() => _AutoUpdateCheckState();
}

class _AutoUpdateCheckState extends State<AutoUpdateCheck> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    final u = widget.updater;
    u.readLastApply();
    _timer = Timer(widget.first, () {
      u.readLastApply();
      unawaited(u.check());
      _timer = Timer.periodic(widget.every, (_) => unawaited(u.check()));
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
