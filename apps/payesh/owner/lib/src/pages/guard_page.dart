// «نگهبان هوشمند» (ردیف ۱۵۴): نتیجهٔ زندهٔ موتور هوشمند مالک.
//   • وضعیت کلی، آخرین بررسی و «بررسی اکنون»؛
//   • یافته‌ها به ترتیب شدت (رفع‌شده‌ها با برچسب «رفع خودکار»)؛
//   • تراکنش‌های مشکوک اشتراک با «بررسی شد» (و برداشتن آن)؛
//   • گزارش کارهایی که موتور خودش انجام داده.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../guard/guard_engine.dart';
import '../widgets.dart';

class GuardPage extends StatelessWidget {
  const GuardPage({super.key});

  @override
  Widget build(BuildContext context) {
    final g = OwnerScope.of(context).guard;
    if (g == null) {
      return const StateBox.empty('موتور هوشمند روی این دستگاه فعال نیست.');
    }
    return GuardView(engine: g);
  }
}

/// «۱۹ آبان ۱۴۰۵ ۱۴:۰۵» به وقت محلی.
String _stamp(DateTime t) {
  final l = t.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return faDigits(
    '${jalaliText(l.toIso8601String())} ${two(l.hour)}:${two(l.minute)}',
  );
}

class GuardView extends StatelessWidget {
  const GuardView({super.key, required this.engine});
  final GuardEngine engine;

  static PayeshTone toneOf(String level) => switch (level) {
    GuardLevel.danger => PayeshTone.danger,
    GuardLevel.warning => PayeshTone.warning,
    GuardLevel.info => PayeshTone.info,
    _ => PayeshTone.success,
  };

  static String levelFa(String level) => switch (level) {
    GuardLevel.danger => 'نیاز به توجه فوری',
    GuardLevel.warning => 'هشدار',
    GuardLevel.info => 'اطلاع',
    _ => 'همه‌چیز سالم است',
  };

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: engine,
    builder: (context, _) {
      final tk = context.tokens;
      final t = Theme.of(context).textTheme;
      final last = engine.lastRun;
      final fraud = [
        for (final f in engine.findings)
          if (f.fraud != null) f,
      ];
      final others = [
        for (final f in engine.findings)
          if (f.fraud == null) f,
      ];
      return ListView(
        key: const Key('guard-page'),
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(PayeshTokens.space4),
              child: Row(
                children: [
                  Icon(Icons.shield_outlined, color: tk.primary, size: 32),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('نگهبان هوشمند', style: t.titleMedium),
                        Text(
                          last == null
                              ? 'هنوز بررسی نشده'
                              : 'آخرین بررسی: ${_stamp(last)} · '
                                    'هر دقیقه خودکار',
                          key: const Key('guard-last'),
                          style: t.bodySmall?.copyWith(color: tk.muted),
                        ),
                      ],
                    ),
                  ),
                  StatusBadge(
                    levelFa(engine.level),
                    key: const Key('guard-level'),
                    tone: toneOf(engine.level),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.tonalIcon(
                    key: const Key('guard-run'),
                    onPressed: engine.running
                        ? null
                        : () => unawaited(engine.run()),
                    icon: engine.running
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh),
                    label: const Text('بررسی اکنون'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          PayeshSection(
            title: 'داده، ترافیک، کارها و دستورها',
            child: others.isEmpty
                ? Text(
                    'خطایی پیدا نشد؛ هیچ داده، کار یا دستوری در انتظار نیست.',
                    key: const Key('guard-clean'),
                    style: TextStyle(color: tk.success),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [for (final f in others) _row(context, f)],
                  ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          PayeshSection(
            title: 'تراکنش‌های مشکوک اشتراک',
            trailing: StatusBadge(
              '${faNumber(engine.openFraud.length)} بررسی‌نشده',
              key: const Key('guard-fraud-count'),
              tone: engine.openFraud.isEmpty
                  ? PayeshTone.success
                  : PayeshTone.danger,
            ),
            child: fraud.isEmpty
                ? const Text(
                    'تراکنش مشکوکی دیده نشد.',
                    key: Key('guard-fraud-empty'),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [for (final f in fraud) _row(context, f)],
                  ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          PayeshSection(
            title: 'کارهایی که موتور خودش انجام داد',
            child: engine.log.isEmpty
                ? const Text(
                    'هنوز کاری لازم نشده است.',
                    key: Key('guard-log-empty'),
                  )
                : Column(
                    key: const Key('guard-log'),
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final e in engine.log.reversed.take(30))
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(
                            '${_stamp(e.at)} · ${e.textFa}',
                            style: t.bodySmall,
                          ),
                        ),
                    ],
                  ),
          ),
        ],
      );
    },
  );

  Widget _row(BuildContext context, GuardFinding f) {
    final tk = context.tokens;
    final fr = f.fraud;
    final acked = fr != null && engine.isAcked(fr);
    return ListTile(
      key: Key('guard-finding-${f.id}'),
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        f.level == GuardLevel.ok
            ? Icons.check_circle_outline
            : f.level == GuardLevel.info
            ? Icons.info_outline
            : Icons.warning_amber_rounded,
        color: acked ? tk.muted : tk.tone(toneOf(f.level)).$1,
      ),
      title: Text(f.titleFa),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(f.detailFa),
          if (f.fixedFa != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: StatusBadge(
                'رفع خودکار: ${f.fixedFa}',
                key: Key('guard-fixed-${f.id}'),
                tone: PayeshTone.success,
                icon: Icons.auto_fix_high,
              ),
            ),
        ],
      ),
      trailing: fr == null
          ? null
          : TextButton(
              key: Key('guard-ack-${fr.id}'),
              onPressed: () => unawaited(engine.acknowledge(fr, acked: !acked)),
              child: Text(acked ? 'بررسی شد ✓' : 'بررسی شد'),
            ),
    );
  }
}
