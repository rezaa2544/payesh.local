import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'session_controller.dart';

/// Row 163 — the look of the login screens: a brand gradient with soft light shapes, the Payesh
/// mark and name, a short promise of what the app does, and a floating card with the form. On a
/// wide window the brand side and the card sit side by side (RTL: brand on the right); on a phone
/// the brand header sits above the card.
class LoginBrandFrame extends StatelessWidget {
  const LoginBrandFrame({
    super.key,
    required this.title,
    required this.children,
    this.subtitle,
    this.status,
  });

  final String title;
  final String? subtitle;

  /// The database connection line at the top of the card (row 163).
  final Widget? status;
  final List<Widget> children;

  static const _deep = Color(0xFF0B1E5B);
  static const _indigo = Color(0xFF3730A3);
  static const _teal = Color(0xFF0D9488);

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final card = Container(
      constraints: const BoxConstraints(maxWidth: 440),
      decoration: BoxDecoration(
        color: t.card,
        borderRadius: BorderRadius.circular(28),
        border: Border.all(
          color: Colors.white.withValues(alpha: dark ? 0.06 : 0.5),
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF020617).withValues(alpha: 0.28),
            blurRadius: 48,
            offset: const Offset(0, 24),
          ),
        ],
      ),
      padding: const EdgeInsets.fromLTRB(28, 26, 28, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          ?status,
          if (status != null) const SizedBox(height: 18),
          Text(
            title,
            key: const Key('login-title'),
            style: Theme.of(context).textTheme.headlineSmall
                ?.copyWith(fontWeight: FontWeight.w800, color: t.ink),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 6),
            Text(
              subtitle!,
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: t.muted, height: 1.6),
            ),
          ],
          const SizedBox(height: 20),
          ...children,
        ],
      ),
    );
    return Scaffold(
      body: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: AlignmentDirectional.topEnd,
            end: AlignmentDirectional.bottomStart,
            colors: dark
                ? const [
                    Color(0xFF050B24),
                    Color(0xFF1E1B4B),
                    Color(0xFF064E48),
                  ]
                : const [_deep, _indigo, _teal],
          ),
        ),
        child: Stack(
          children: [
            const Positioned.fill(child: _Glow()),
            SafeArea(
              child: LayoutBuilder(
                builder: (context, box) {
                  final wide = box.maxWidth >= 900;
                  // a short window (phone in landscape, small laptop) keeps only the card
                  final tall = box.maxHeight >= 720;
                  return Center(
                    child: SingleChildScrollView(
                      padding: EdgeInsets.symmetric(
                        horizontal: wide ? 48 : 18,
                        vertical: tall ? 28 : 12,
                      ),
                      child: wide
                          ? ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 1080),
                              child: Row(
                                children: [
                                  const Expanded(child: _BrandSide()),
                                  const SizedBox(width: 56),
                                  Flexible(child: card),
                                ],
                              ),
                            )
                          : Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (tall) ...[
                                  const _BrandHeader(),
                                  const SizedBox(height: 22),
                                ],
                                card,
                                if (tall) ...[
                                  const SizedBox(height: 18),
                                  const _Footer(),
                                ],
                              ],
                            ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Soft light shapes over the gradient (decoration only; no image files).
class _Glow extends StatelessWidget {
  const _Glow();

  @override
  Widget build(BuildContext context) =>
      IgnorePointer(child: CustomPaint(painter: _GlowPainter()));
}

class _GlowPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    void blob(Offset c, double r, Color color) {
      canvas.drawCircle(
        c,
        r,
        Paint()
          ..shader = RadialGradient(colors: [color, color.withValues(alpha: 0)])
              .createShader(Rect.fromCircle(center: c, radius: r)),
      );
    }

    final w = size.width, h = size.height;
    blob(Offset(w * 0.85, h * 0.12), w * 0.32, const Color(0x5538BDF8));
    blob(Offset(w * 0.1, h * 0.9), w * 0.38, const Color(0x5534D399));
    blob(Offset(w * 0.5, h * 0.55), w * 0.22, const Color(0x22A78BFA));
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = const Color(0x22FFFFFF);
    canvas.drawCircle(Offset(w * 0.92, h * 0.86), 120, ring);
    canvas.drawCircle(Offset(w * 0.92, h * 0.86), 190, ring);
    canvas.drawCircle(Offset(w * 0.06, h * 0.08), 90, ring);
    canvas.drawCircle(Offset(w * 0.06, h * 0.08), 150, ring);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// The mark: a glassy rounded tile with the app pulse icon.
class _Mark extends StatelessWidget {
  const _Mark({this.size = 64});
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(size * 0.3),
      gradient: const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xFF5EEAD4), Color(0xFF6366F1)],
      ),
      border: Border.all(
        color: Colors.white.withValues(alpha: 0.55),
        width: 1.5,
      ),
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF0F172A).withValues(alpha: 0.35),
          blurRadius: 24,
          offset: const Offset(0, 10),
        ),
      ],
    ),
    child: Icon(
      Icons.monitor_heart_outlined,
      color: Colors.white,
      size: size * 0.56,
    ),
  );
}

const _white = Colors.white;
final _white70 = Colors.white.withValues(alpha: 0.78);

class _BrandHeader extends StatelessWidget {
  const _BrandHeader();

  @override
  Widget build(BuildContext context) => Column(
    children: [
      const _Mark(size: 68),
      const SizedBox(height: 14),
      Text(
        'پایش',
        style: Theme.of(context).textTheme.headlineMedium?.copyWith(
          color: _white,
          fontWeight: FontWeight.w900,
          letterSpacing: 0.5,
        ),
      ),
      const SizedBox(height: 4),
      Text(
        'سامانهٔ هوشمند مدیریت مدرسه',
        style: Theme.of(context).textTheme.bodyMedium
            ?.copyWith(color: _white70),
      ),
    ],
  );
}

class _BrandSide extends StatelessWidget {
  const _BrandSide();

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    Widget feature(IconData icon, String title, String text) => Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Colors.white.withValues(alpha: 0.18)),
            ),
            child: Icon(icon, color: _white, size: 22),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: tt.titleSmall?.copyWith(
                    color: _white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  text,
                  style: tt.bodySmall?.copyWith(color: _white70, height: 1.6),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            const _Mark(size: 60),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'پایش',
                    style: tt.headlineMedium?.copyWith(
                      color: _white,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  Text(
                    'سامانهٔ هوشمند مدیریت مدرسه',
                    style: tt.bodyMedium?.copyWith(color: _white70),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 36),
        Text(
          'همهٔ مدرسه، در یک نگاه',
          style: tt.displaySmall?.copyWith(
            color: _white,
            fontWeight: FontWeight.w800,
            height: 1.3,
            fontSize: 34,
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'حضور و غیاب، نمره‌ها، برنامهٔ هفتگی و ارتباط با اولیا — روی رایانه و گوشی، از هر اینترنتی، همگام با دیتابیس پایش.',
          style: tt.bodyLarge?.copyWith(color: _white70, height: 1.8),
        ),
        const SizedBox(height: 32),
        feature(
          Icons.fact_check_outlined,
          'حضور و غیاب لحظه‌ای',
          'ثبت در کلاس و پیام فوری به اولیا',
        ),
        feature(
          Icons.insights_outlined,
          'کارنامه و گزارش',
          'نمره‌ها و روند هر دانش‌آموز در یک صفحه',
        ),
        feature(
          Icons.lock_outline,
          'امن و مستقل',
          'یک دیتابیس برای همه؛ دادهٔ هر مدرسه در بخش جدای خودش',
        ),
        const SizedBox(height: 8),
        const _Footer(start: true),
      ],
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({this.start = false});
  final bool start;

  @override
  Widget build(BuildContext context) => Text(
    '© پایش — ساخته‌شده برای مدرسه‌های ایران',
    textAlign: start ? TextAlign.start : TextAlign.center,
    style: Theme.of(context).textTheme.bodySmall
        ?.copyWith(color: Colors.white.withValues(alpha: 0.6)),
  );
}

/// Row 163 — the database connection line at the top of the card: looking (spinner), connected
/// (green; row 164: no school name — one database for all) or not found (red, «تلاش دوباره»). Text always says it; colour only helps.
class LoginConnectionPill extends StatelessWidget {
  const LoginConnectionPill({
    super.key,
    required this.state,
    required this.onRetry,
    this.busy = false,
  });

  final NeedLan state;
  final VoidCallback onRetry;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final info = state.info;
    final (Color fg, Color bg, String text, Widget lead) = info != null
        ? (t.success, t.successBg, 'وصل به دیتابیس', _Dot(color: t.success))
        : state.notFound
        ? (
            t.danger,
            t.dangerBg,
            state.vpn
                ? 'اتصال برقرار نشد — VPN روشن است'
                : 'اتصال به دیتابیس برقرار نشد',
            _Dot(color: t.danger),
          )
        : (
            t.primary,
            t.soft,
            'در حال اتصال به دیتابیس…',
            SizedBox.square(
              dimension: 12,
              child: CircularProgressIndicator(
                key: const Key('lan-searching'),
                strokeWidth: 2,
                color: t.primary,
              ),
            ),
          );
    return Semantics(
      liveRegion: true,
      child: Container(
        key: const Key('lan-connection'),
        padding: const EdgeInsetsDirectional.fromSTEB(12, 8, 8, 8),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                lead,
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    text,
                    key: const Key('lan-connection-text'),
                    style: TextStyle(
                      color: fg,
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                ),
                if (info == null && state.notFound)
                  TextButton.icon(
                    key: const Key('lan-retry'),
                    onPressed: busy ? null : onRetry,
                    style: TextButton.styleFrom(
                      foregroundColor: fg,
                      visualDensity: VisualDensity.compact,
                    ),
                    icon: const Icon(Icons.refresh, size: 18),
                    label: const Text('تلاش دوباره'),
                  ),
              ],
            ),
            // row 186: a VPN is up and nothing answered — say what to do (the app keeps
            // searching by itself, so nothing else has to be pressed afterwards)
            if (info == null && state.notFound && state.vpn)
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 4, 4, 4),
                child: Text(
                  SessionController.lanVpnFa,
                  key: const Key('lan-vpn-hint'),
                  style: TextStyle(color: fg, fontSize: 12.5, height: 1.6),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 10,
    height: 10,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      boxShadow: [
        BoxShadow(color: color.withValues(alpha: 0.45), blurRadius: 8),
      ],
    ),
  );
}

/// Row 163 — the two login methods as one segmented switch. The method that is NOT shown carries
/// the `lan-switch-method` key (pressing it switches), so the order of the owner panel stays.
class LoginMethodTabs extends StatelessWidget {
  const LoginMethodTabs({
    super.key,
    required this.mobile,
    required this.onChange,
    this.enabled = true,
  });

  final bool mobile;
  final ValueChanged<bool> onChange;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    Widget tab(bool isMobile, IconData icon, String label) {
      final active = isMobile == mobile;
      return Expanded(
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            key: active ? null : const Key('lan-switch-method'),
            borderRadius: BorderRadius.circular(12),
            onTap: active || !enabled ? null : () => onChange(isMobile),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                color: active ? t.card : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
                boxShadow: active
                    ? [
                        BoxShadow(
                          color: const Color(0xFF0F172A)
                              .withValues(alpha: 0.10),
                          blurRadius: 10,
                          offset: const Offset(0, 3),
                        ),
                      ]
                    : null,
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, size: 18, color: active ? t.primary : t.muted),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      label,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: active ? t.primary : t.muted,
                        fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                        fontSize: 13,
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

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: t.bg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: t.line),
      ),
      child: Row(
        children: [
          tab(false, Icons.key_outlined, 'نام کاربری و رمز'),
          const SizedBox(width: 4),
          tab(true, Icons.sms_outlined, 'شماره و کد پیامکی'),
        ],
      ),
    );
  }
}

/// Row 163 — the main button of the card: full width, tall, on the brand gradient.
class LoginPrimaryButton extends StatelessWidget {
  const LoginPrimaryButton({
    super.key,
    required this.buttonKey,
    required this.onPressed,
    required this.child,
  });

  /// Key of the button itself (tests and screen readers find it by this key).
  final Key buttonKey;
  final VoidCallback? onPressed;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final on = onPressed != null;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: LinearGradient(
          begin: AlignmentDirectional.centerEnd,
          end: AlignmentDirectional.centerStart,
          colors: on
              ? const [Color(0xFF4338CA), Color(0xFF0D9488)]
              : [Colors.grey.shade400, Colors.grey.shade400],
        ),
        boxShadow: on
            ? [
                BoxShadow(
                  color: const Color(0xFF4338CA).withValues(alpha: 0.35),
                  blurRadius: 18,
                  offset: const Offset(0, 8),
                ),
              ]
            : null,
      ),
      child: SizedBox(
        height: 54,
        child: FilledButton(
          key: buttonKey,
          onPressed: onPressed,
          style: FilledButton.styleFrom(
            backgroundColor: Colors.transparent,
            disabledBackgroundColor: Colors.transparent,
            shadowColor: Colors.transparent,
            foregroundColor: Colors.white,
            disabledForegroundColor: Colors.white70,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            textStyle: const TextStyle(
              fontFamily: PayeshTokens.fontFamily,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
          ),
          child: child,
        ),
      ),
    );
  }
}
