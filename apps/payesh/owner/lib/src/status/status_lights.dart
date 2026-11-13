// دو چراغ همیشه‌پیدای نوار بالا (بدون نوشتهٔ اضافی):
//   • چراغ دیتابیس (بالا-چپ): سبز = وصل، قرمز = قطع، خاکستری = تنظیم نشده. لمس ⇒ سنجش دوباره.
//     در پس‌زمینه هم مدام سنجیده می‌شود و اگر قطع شد، با فاصلهٔ کوتاه و رو به افزایش خودش
//     دوباره وصل می‌شود — بدون دست زدن به آدرس.
//   • نسخه + چراغ به‌روزرسانی: سبز = به‌روز، نارنجی = نسخهٔ تازه آماده. لمس ⇒ بررسی؛ اگر نسخهٔ
//     تازه هست ⇒ دریافت فقط تغییرات، نصب و راه‌اندازی دوبارهٔ خودکار. هنگام کار «زنده» است
//     (ردیف ۱۴۸؛ کد در payesh_update، مشترک با برنامهٔ مدرسه).

import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../local/local_platform.dart';

// نقطهٔ وضعیت زنده (payesh_ui) و چراغ نسخه/به‌روزرسانی (payesh_update) — ردیف ۱۴۸
export 'package:payesh_ui/payesh_ui.dart' show StatusDot;
export 'package:payesh_update/payesh_update.dart' show UpdateLight;

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
          // چراغ بزرگ‌تر با نوشتهٔ «دیتابیس» (ردیف ۱۳۱)
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
            child: Material(
              color: color.withValues(alpha: 0.12),
              shape: StadiumBorder(
                side: BorderSide(color: color.withValues(alpha: 0.7)),
              ),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                key: const Key('db-light'),
                onTap: () => unawaited(monitor.refresh()),
                child: Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(8, 4, 12, 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      StatusDot(
                        key: ValueKey('db-light-${st ?? 'unknown'}'),
                        color: color,
                        busy: monitor.checking,
                        size: 24,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        'دیتابیس',
                        key: const Key('db-light-label'),
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
