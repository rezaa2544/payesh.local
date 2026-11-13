// دو چراغ همیشه‌پیدای نوار بالا (بدون نوشتهٔ اضافی):
//   • چراغ دیتابیس (بالا-چپ): سبز = وصل، قرمز = قطع، خاکستری = تنظیم نشده. لمس ⇒ سنجش دوباره.
//     در پس‌زمینه هم مدام سنجیده می‌شود و اگر قطع شد، با فاصلهٔ کوتاه و رو به افزایش خودش
//     دوباره وصل می‌شود — بدون دست زدن به آدرس.
//   • نسخه + چراغ به‌روزرسانی: سبز = به‌روز، نارنجی = نسخهٔ تازه آماده. لمس ⇒ بررسی؛ اگر نسخهٔ
//     تازه هست ⇒ دریافت فقط تغییرات، نصب و راه‌اندازی دوبارهٔ خودکار.

import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../local/local_platform.dart';
import '../update/owner_update.dart';
import '../update/update_service.dart';

/// سنجش دوره‌ای اتصال دیتابیس با وصل شدن خودکار.
final class DbMonitor extends ChangeNotifier {
  DbMonitor({
    required this.probe,
    Stream<PlatformSync>? updates,
    this.okEvery = const Duration(seconds: 60),
    this.retryBase = const Duration(seconds: 3),
    this.retryMax = const Duration(seconds: 60),
    Random? random,
  }) : _rnd = random ?? Random() {
    _sub = updates?.listen(_observe);
  }

  final Future<PlatformSync> Function() probe;
  final Duration okEvery;
  final Duration retryBase;
  final Duration retryMax;
  final Random _rnd;

  PlatformSync? state;
  bool checking = false;
  int failures = 0;
  Timer? _timer;
  Future<void>? _inflight;
  StreamSubscription<PlatformSync>? _sub;
  bool _disposed = false;

  bool get connected => state?.state == 'synced';

  /// زمان سنجش بعدی (برای آزمون‌ها).
  Duration? nextIn;

  /// سنجش خودکار (دوره‌ای + وصل شدن دوباره) فقط پس از [start].
  bool get auto => _auto;
  bool _auto = false;

  void start({Duration first = const Duration(seconds: 1)}) {
    _auto = true;
    _schedule(first);
  }

  void _observe(PlatformSync s) {
    if (_disposed) return;
    final was = state?.state;
    state = s;
    // قطعی که هنگام خواندن صفحه‌ها دیده شد ⇒ وصل شدن دوباره زودتر از نوبت عادی
    if (s.state == 'error' && was != 'error' && !checking) {
      failures = max(failures, 1);
      _schedule(_backoff());
    }
    notifyListeners();
  }

  Duration _backoff() {
    final n = min(failures, 8);
    final exp = retryBase.inMilliseconds * pow(2, n - 1);
    final capped = min(exp.toDouble(), retryMax.inMilliseconds.toDouble());
    // لرزش ±۲۰٪ تا چند دستگاه هم‌زمان نکوبند
    final jitter = capped * (0.8 + 0.4 * _rnd.nextDouble());
    return Duration(milliseconds: jitter.round());
  }

  void _schedule(Duration d) {
    if (_disposed || !_auto) return;
    _timer?.cancel();
    nextIn = d;
    _timer = Timer(d, () => unawaited(refresh()));
  }

  /// سنجش همین حالا (لمس چراغ). اگر سنجشی در جریان است، همان را منتظر می‌ماند.
  Future<void> refresh() => _inflight ??= _run().whenComplete(() {
    _inflight = null;
  });

  Future<void> _run() async {
    if (_disposed) return;
    _timer?.cancel();
    checking = true;
    notifyListeners();
    try {
      state = await probe();
    } on Object catch (e) {
      state = PlatformSync(state: 'error', error: '$e');
    }
    if (_disposed) return;
    checking = false;
    if (state!.state == 'error') {
      failures++;
      _schedule(_backoff());
    } else {
      failures = 0;
      _schedule(okEvery);
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    unawaited(_sub?.cancel());
    super.dispose();
  }
}

/// یک نقطهٔ رنگی؛ هنگام کار، حلقهٔ پیشرفت دورش.
class StatusDot extends StatelessWidget {
  const StatusDot({
    super.key,
    required this.color,
    this.busy = false,
    this.progress,
  });
  final Color color;
  final bool busy;
  final double? progress;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 20,
    height: 20,
    child: Stack(
      alignment: Alignment.center,
      children: [
        if (busy)
          SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              value: progress,
              color: color,
            ),
          ),
        Container(
          width: 11,
          height: 11,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(color: color.withValues(alpha: 0.45), blurRadius: 5),
            ],
          ),
        ),
      ],
    ),
  );
}

/// چراغ دیتابیس.
class DbLight extends StatelessWidget {
  const DbLight({super.key, required this.monitor});
  final DbMonitor monitor;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: monitor,
    builder: (context, _) {
      final tk = context.tokens;
      final st = monitor.state?.state;
      final (color, label) = switch (st) {
        'synced' => (tk.success, 'دیتابیس وصل است'),
        'error' => (tk.danger, 'دیتابیس قطع است'),
        'not_configured' => (tk.muted, 'دیتابیس تنظیم نشده'),
        _ => (tk.muted, 'وضعیت دیتابیس'),
      };
      final detail = st == 'error' && monitor.state?.error != null
          ? '$label: ${monitor.state!.error}'
          : label;
      return Semantics(
        button: true,
        label: detail,
        value: st ?? 'unknown',
        child: Tooltip(
          message: detail,
          child: InkResponse(
            key: const Key('db-light'),
            radius: 20,
            onTap: () => unawaited(monitor.refresh()),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: StatusDot(
                key: ValueKey('db-light-${st ?? 'unknown'}'),
                color: color,
                busy: monitor.checking,
              ),
            ),
          ),
        ),
      );
    },
  );
}

/// نسخه + چراغ به‌روزرسانی.
class UpdateLight extends StatefulWidget {
  const UpdateLight({super.key, required this.updater, this.openUrl});
  final OwnerUpdater updater;

  /// اندروید: بستهٔ کامل (APK) با مرورگر دانلود و نصب می‌شود.
  final Future<void> Function(Uri url)? openUrl;

  @override
  State<UpdateLight> createState() => _UpdateLightState();
}

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
    switch (u.phase) {
      case UpdatePhase.checking || UpdatePhase.downloading:
        return;
      case UpdatePhase.staged:
        await u.applyAndRestart();
      case UpdatePhase.ready:
        if (!u.isWindows) {
          await widget.openUrl?.call(defaultApkUrl);
          return;
        }
        await u.download();
        if (u.phase == UpdatePhase.staged) await u.applyAndRestart();
      case UpdatePhase.idle || UpdatePhase.upToDate || UpdatePhase.failed:
        await u.check();
    }
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.updater;
    final tk = context.tokens;
    final next = u.plan?.manifest.build;
    final (color, label) = switch (u.phase) {
      UpdatePhase.ready || UpdatePhase.staged => (
        tk.warning,
        'نسخهٔ ${versionOf(next ?? 0)} آماده است — برای نصب لمس کنید',
      ),
      UpdatePhase.upToDate => (tk.success, 'به‌روز است'),
      UpdatePhase.failed => (tk.danger, u.error ?? 'بررسی ناموفق'),
      UpdatePhase.checking => (tk.muted, 'در حال بررسی'),
      UpdatePhase.downloading => (tk.warning, 'در حال دریافت'),
      UpdatePhase.idle => (tk.muted, 'بررسی به‌روزرسانی'),
    };
    final busy =
        u.phase == UpdatePhase.checking || u.phase == UpdatePhase.downloading;
    final progress = u.phase == UpdatePhase.downloading && u.progressTotal > 0
        ? u.progressDone / u.progressTotal
        : null;
    return Semantics(
      button: true,
      label: '$ownerVersion — $label',
      value: u.phase.name,
      child: Tooltip(
        message: label,
        child: InkWell(
          key: const Key('update-light'),
          borderRadius: BorderRadius.circular(16),
          onTap: () => unawaited(_tap()),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  ownerVersion,
                  key: const Key('app-version'),
                  textDirection: TextDirection.ltr,
                  style: TextStyle(fontSize: 13, color: tk.muted),
                ),
                const SizedBox(width: 6),
                StatusDot(
                  key: ValueKey('update-light-${u.phase.name}'),
                  color: color,
                  busy: busy,
                  progress: progress,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
