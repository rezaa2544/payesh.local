// «حالت معماری» در «زیرساخت» و «بار لحظه‌ای» در داشبورد (ردیف ۱۵۳).
//
//   • سه حالت قابل تعویض: فقط دیتابیس · دیتابیس + سیستم‌های پنل مالک (کمکی) · سرور بیرونی.
//     تغییر در سیاست زیرساخت دیتابیس ثبت می‌شود و همهٔ پنل‌ها و سرورهای مدرسه حداکثر ۶۰ ثانیه
//     بعد پیروی می‌کنند. بدون اینترنت روی همین دستگاه می‌ماند و با وصل شدن ثبت می‌شود.
//   • زنجیرهٔ زندهٔ مسیر بار: کدام زیرساخت اصلی است و کدام‌ها الان به کمک آمده‌اند و چرا.
//   • بار لحظه‌ای واقعی همین دستگاه: درخواست در دقیقه، p95 و میانگین زمان پاسخ، نرخ خطا.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'infra_policy.dart';
import 'load_route.dart';

String _ms(int v) => '${faNumber(v)} میلی‌ثانیه';
String _pct(double v) => '${faNumber((v * 100).round())}٪';

/// زنجیرهٔ مسیر بار: اصلی ← کمکی‌ها؛ فعال‌ها رنگی.
class RouteChainView extends StatelessWidget {
  const RouteChainView({super.key, required this.state});
  final RouteState state;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final active = state.active;
    final children = <Widget>[];
    for (var i = 0; i < state.chain.length; i++) {
      final tier = state.chain[i];
      if (i > 0) {
        children.add(Icon(Icons.chevron_left, size: 18, color: tk.muted));
      }
      final on = active.contains(tier);
      children.add(
        StatusBadge(
          '${routeTierTitles[tier] ?? tier}${i == 0 ? ' (اصلی)' : ''}'
          '${on ? '' : ' · آماده'}',
          key: Key('route-tier-$tier'),
          tone: !on
              ? PayeshTone.neutral
              : i == 0
              ? PayeshTone.success
              : PayeshTone.warning,
          icon: on ? Icons.bolt : Icons.pause_circle_outline,
        ),
      );
    }
    return Wrap(
      key: const Key('route-chain'),
      spacing: 6,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: children,
    );
  }
}

/// کارت «حالت معماری» بالای صفحهٔ «زیرساخت».
class ArchCard extends StatefulWidget {
  const ArchCard({
    super.key,
    required this.policy,
    required this.router,
    this.margin = EdgeInsets.zero,
  });

  final InfraPolicyStore policy;
  final LoadRouter router;
  final EdgeInsetsGeometry margin;

  @override
  State<ArchCard> createState() => _ArchCardState();
}

class _ArchCardState extends State<ArchCard> {
  late final TextEditingController _ext = TextEditingController(
    text: widget.policy.value.external,
  );
  String? _extError;
  String? _extNote;

  @override
  void initState() {
    super.initState();
    widget.policy.addListener(_redraw);
    widget.router.addListener(_redraw);
  }

  @override
  void dispose() {
    widget.policy.removeListener(_redraw);
    widget.router.removeListener(_redraw);
    _ext.dispose();
    super.dispose();
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

  Future<void> _setMode(String m) async {
    await widget.policy.setMode(m);
    unawaited(widget.router.tick());
  }

  Future<void> _saveExternal() async {
    final ok = await widget.policy.setExternal(_ext.text);
    if (!mounted) return;
    setState(() {
      _extError = ok
          ? null
          : 'نشانی درست نیست؛ مثل https://server.example.ir (بدون ? و #).';
      _extNote = ok ? 'نشانی ذخیره شد.' : null;
    });
    if (ok) unawaited(widget.router.tick());
  }

  Widget _modeTile(String m, String detail, IconData icon) {
    final tk = context.tokens;
    final sel = widget.policy.value.mode == m;
    final can = widget.policy.configured;
    return ListTile(
      key: Key('arch-mode-$m'),
      contentPadding: EdgeInsets.zero,
      selected: sel,
      enabled: can,
      leading: Icon(
        sel ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        color: sel ? tk.primary : tk.muted,
      ),
      title: Row(
        children: [
          Icon(icon, size: 18, color: sel ? tk.primary : tk.muted),
          const SizedBox(width: 6),
          Flexible(child: Text(archModeTitles[m]!)),
        ],
      ),
      subtitle: Text(detail),
      onTap: can && !sel ? () => unawaited(_setMode(m)) : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final p = widget.policy;
    final r = widget.router;
    final st = r.state;
    final db = r.db;
    final ext = r.external;
    final note = p.pending
        ? 'تغییر روی همین دستگاه ذخیره شد؛ با وصل شدن دیتابیس برای همه ثبت می‌شود.'
        : !p.configured
        ? 'برای تغییر حالت، اول دیتابیس را در «تنظیمات» وصل کنید.'
        : null;
    return Card(
      key: const Key('arch-card'),
      margin: widget.margin,
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('حالت معماری', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'برای کل پروژه (پنل مالک، سرورهای مدرسه و برنامه‌های کاربران). '
              'جابه‌جایی بین پله‌ها خودکار و بر اساس زمان پاسخ و نرخ خطاست.',
              style: TextStyle(color: tk.muted),
            ),
            _modeTile(
              ArchModes.db,
              'همه‌چیز مستقیم با دیتابیس؛ سیستم‌های پنل مالک هیچ پردازشی نمی‌گیرند.',
              Icons.storage_outlined,
            ),
            _modeTile(
              ArchModes.helpers,
              'دیتابیس اصلی است. سیستم‌های پنل مالک (هر کدام با کلید خودش در «زیرساخت‌ها») '
              'فقط وقتی دیتابیس کند شود یا خطا بدهد به کمک می‌آیند.',
              Icons.hub_outlined,
            ),
            _modeTile(
              ArchModes.external,
              'سرور بیرونی اصلی است ← زیر بار: دیتابیس هم ← باز زیر بار: سیستم‌های کمکی. '
              'وقتی بار عادی شد به سرور بیرونی برمی‌گردد. بدون سرور بیرونیِ در دسترس، همان حالت دوم.',
              Icons.cloud_outlined,
            ),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('arch-external'),
                      controller: _ext,
                      enabled: p.configured,
                      textDirection: TextDirection.ltr,
                      keyboardType: TextInputType.url,
                      decoration: InputDecoration(
                        labelText: 'نشانی سرور بیرونی (برای آینده)',
                        hintText: 'https://server.example.ir',
                        errorText: _extError,
                        helperText: _extNote,
                      ),
                      onSubmitted: (_) => unawaited(_saveExternal()),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: FilledButton.tonal(
                      key: const Key('arch-external-save'),
                      onPressed: p.configured
                          ? () => unawaited(_saveExternal())
                          : null,
                      child: const Text('ذخیره'),
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 24),
            Text('مسیر فعلی', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 6),
            RouteChainView(state: st),
            const SizedBox(height: 6),
            Text(
              routeReasonFa(st.reason),
              key: const Key('arch-route-reason'),
              style: TextStyle(color: tk.muted),
            ),
            const SizedBox(height: 6),
            Text(
              'دیتابیس: p95 ${_ms(db.p95)} · میانگین ${_ms(db.avg)} · '
              '${faNumber(db.perMin)} درخواست در دقیقه · خطا ${_pct(db.err)}',
              key: const Key('arch-db-stats'),
            ),
            if (ext != null)
              Text(
                'سرور بیرونی: ${ext.ok ? 'در دسترس' : 'در دسترس نیست'} · '
                'p95 ${_ms(ext.p95)}',
                key: const Key('arch-ext-stats'),
                style: TextStyle(color: ext.ok ? null : tk.danger),
              ),
            const SizedBox(height: 6),
            Text(
              'بالا رفتن پله: p95 بیش از ${_ms(routeThresholds.hiMs)} یا خطای بیش از '
              '${_pct(routeThresholds.errHi)} (فوری). برگشت: یک دقیقه پیوسته زیر '
              '${_ms(routeThresholds.loMs)} و خطای کمتر از ${_pct(routeThresholds.errLo)} '
              '(بدون نوسان).',
              key: const Key('arch-thresholds'),
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: tk.muted),
            ),
            if (note != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  note,
                  key: const Key('arch-note'),
                  style: TextStyle(color: tk.warning),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// کارت «بار لحظه‌ای» داشبورد. [embedded] ⇒ بدون کارت جدا، برای نشستن داخل کادر
/// «نبض پلتفرم» (ردیف ۱۵۶).
class LoadCard extends StatelessWidget {
  const LoadCard({super.key, required this.router, this.embedded = false});
  final LoadRouter router;
  final bool embedded;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: router,
    builder: (context, _) {
      final tk = context.tokens;
      final db = router.db;
      final st = router.state;
      final t = Theme.of(context).textTheme;
      Widget metric(String key, String label, String value, PayeshTone tone) {
        final (fg, bg) = tk.tone(tone);
        return Container(
          key: Key('load-$key'),
          width: 150,
          padding: const EdgeInsets.all(PayeshTokens.space3),
          decoration: BoxDecoration(
            color: embedded
                ? Color.alphaBlend(bg.withValues(alpha: 0.7), tk.card)
                : bg,
            borderRadius: BorderRadius.circular(PayeshTokens.radiusSmall),
            border: embedded ? Border.all(color: tk.line) : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: t.bodySmall?.copyWith(color: tk.muted)),
              Text(
                value,
                style: t.titleMedium?.copyWith(
                  color: fg,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        );
      }

      PayeshTone msTone(int v) => v > routeThresholds.hiMs
          ? PayeshTone.danger
          : v > routeThresholds.loMs
          ? PayeshTone.warning
          : PayeshTone.success;
      final body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.speed, color: tk.primary),
              const SizedBox(width: 6),
              Expanded(child: Text('بار لحظه‌ای', style: t.titleMedium)),
              StatusBadge(
                archModeTitles[router.policy().mode] ?? '',
                key: const Key('load-mode'),
                tone: PayeshTone.info,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              metric(
                'rpm',
                'درخواست در دقیقه',
                faNumber(db.perMin),
                PayeshTone.info,
              ),
              metric('p95', 'زمان پاسخ p95', _ms(db.p95), msTone(db.p95)),
              metric('avg', 'میانگین پاسخ', _ms(db.avg), msTone(db.avg)),
              metric(
                'err',
                'نرخ خطا',
                _pct(db.err),
                db.err > routeThresholds.errHi
                    ? PayeshTone.danger
                    : db.err > 0
                    ? PayeshTone.warning
                    : PayeshTone.success,
              ),
            ],
          ),
          const SizedBox(height: 10),
          RouteChainView(state: st),
          const SizedBox(height: 4),
          Text(
            routeReasonFa(st.reason),
            key: const Key('load-reason'),
            style: t.bodySmall?.copyWith(color: tk.muted),
          ),
        ],
      );
      if (embedded) {
        return KeyedSubtree(key: const Key('load-card'), child: body);
      }
      return Card(
        key: const Key('load-card'),
        child: Padding(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          child: body,
        ),
      );
    },
  );
}
