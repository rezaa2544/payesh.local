// نقطهٔ وضعیت «زنده» (ردیف ۱۴۸): هنگام کار (بررسی، دریافت، نصب) هاله‌ای دور نقطه می‌تپد و
// حلقهٔ پیشرفت می‌چرخد یا پر می‌شود؛ پس دیده می‌شود که برنامه واقعاً در حال کار است. وقتی کاری
// در جریان نیست، هیچ پویانمایی‌ای اجرا نمی‌شود (باتری و آزمون‌ها).

import 'dart:math' as math;

import 'package:flutter/material.dart';

/// یک نقطهٔ رنگی؛ هنگام کار ([busy]) هالهٔ تپنده + حلقهٔ پیشرفت دورش.
///
/// [progress] بین ۰ و ۱ ⇒ حلقهٔ پرشونده؛ null ⇒ حلقهٔ چرخان (پیشرفت نامعلوم).
class StatusDot extends StatefulWidget {
  const StatusDot({
    super.key,
    required this.color,
    this.busy = false,
    this.progress,
    this.size = 20,
    this.period = const Duration(milliseconds: 1100),
  });

  final Color color;
  final bool busy;
  final double? progress;

  /// قطر کل (حلقهٔ پیشرفت)؛ نقطه ۵۵٪ آن است.
  final double size;

  /// طول یک تپش.
  final Duration period;

  @override
  State<StatusDot> createState() => _StatusDotState();
}

class _StatusDotState extends State<StatusDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: widget.period,
  );

  @override
  void didUpdateWidget(covariant StatusDot old) {
    super.didUpdateWidget(old);
    if (old.period != widget.period) _pulse.duration = widget.period;
    _sync();
  }

  void _sync() {
    // «کاهش حرکت» سیستم: تپش نه، فقط حلقهٔ پیشرفت
    if (widget.busy && !_reduceMotion) {
      if (!_pulse.isAnimating) _pulse.repeat();
    } else if (_pulse.isAnimating || _pulse.value != 0) {
      _pulse
        ..stop()
        ..value = 0;
    }
  }

  // initState نه: MediaQuery فقط از didChangeDependencies به بعد خوانده می‌شود
  bool get _reduceMotion =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final size = widget.size;
    final color = widget.color;
    final dot = (size * 0.55).roundToDouble();
    final p = widget.progress;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        clipBehavior: Clip.none,
        children: [
          if (widget.busy)
            // هالهٔ تپنده: از اندازهٔ نقطه تا کمی بیرون از حلقه بزرگ و کم‌رنگ می‌شود
            AnimatedBuilder(
              key: const ValueKey('status-dot-pulse'),
              animation: _pulse,
              builder: (context, _) {
                final t = Curves.easeOut.transform(_pulse.value);
                final d = dot + (size * 1.25 - dot) * t;
                return IgnorePointer(
                  child: Container(
                    width: d,
                    height: d,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color.withValues(alpha: 0.35 * (1 - t)),
                    ),
                  ),
                );
              },
            ),
          if (widget.busy)
            SizedBox(
              key: const ValueKey('status-dot-ring'),
              width: size,
              height: size,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                // حلقهٔ صفرِ نامرئی هرگز: تا اولین بایت، چرخان؛ بعد پرشونده (حداقل ۴٪)
                value: p == null || p <= 0
                    ? null
                    : math.max(0.04, math.min(p, 1)),
                color: color,
                backgroundColor: color.withValues(alpha: 0.18),
              ),
            ),
          AnimatedBuilder(
            animation: _pulse,
            builder: (context, child) {
              // خود نقطه هم آرام کوچک و بزرگ می‌شود
              final s = widget.busy
                  ? 1 + 0.12 * math.sin(_pulse.value * 2 * math.pi)
                  : 1.0;
              return Transform.scale(scale: s, child: child);
            },
            child: Container(
              width: dot,
              height: dot,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: color.withValues(alpha: 0.45),
                    blurRadius: dot / 2,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
