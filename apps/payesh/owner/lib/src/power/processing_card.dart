// ردیف ۱۷۷ — «کنترل پردازش» در پنل مالک: توقف کارهای سنگین پس‌زمینه و سقف درصد CPU برای
// همهٔ سیستم‌ها (سرور کمکی، سرور دادهٔ مدرسه، کارهای پس‌زمینهٔ همین پنل). تنظیم در همان
// «سیاست زیرساخت» رمزشدهٔ دیتابیس (proc) ثبت می‌شود و همهٔ سیستم‌ها حداکثر ظرف ۱ دقیقه
// پیرو می‌شوند؛ روی همین دستگاه همان لحظه اعمال می‌شود.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../infra/infra_policy.dart';
import 'activity.dart';

class ProcessingCard extends StatefulWidget {
  const ProcessingCard({
    super.key,
    required this.policy,
    this.cores,
    this.margin = EdgeInsets.zero,
  });

  final InfraPolicyStore policy;

  /// تعداد هسته‌های همین سیستم (آزمون‌ها مقدار ثابت می‌دهند).
  final int? cores;
  final EdgeInsetsGeometry margin;

  @override
  State<ProcessingCard> createState() => _ProcessingCardState();
}

class _ProcessingCardState extends State<ProcessingCard> {
  double? _drag;

  @override
  void initState() {
    super.initState();
    widget.policy.addListener(_redraw);
  }

  @override
  void dispose() {
    widget.policy.removeListener(_redraw);
    super.dispose();
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final p = widget.policy;
    final v = p.value;
    final can = p.configured;
    final cpu = v.cpuPercent;
    final shown = (_drag ?? (cpu ?? 100).toDouble()).round();
    final slots = slotsForCpu(cpu, widget.cores);
    final note = p.pending
        ? 'روی همین دستگاه اعمال شد؛ با وصل شدن دیتابیس برای همهٔ سیستم‌ها ثبت می‌شود.'
        : !can
        ? 'برای ثبت برای همهٔ سیستم‌ها، اول دیتابیس را در «تعریف دیتابیس» وصل کنید.'
        : 'همهٔ سیستم‌ها حداکثر ظرف ۱ دقیقه پیرو می‌شوند.';
    return Card(
      key: const Key('processing-card'),
      margin: widget.margin,
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'کنترل پردازش',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              'برای همهٔ سیستم‌ها: سرور کمکی، سرور دادهٔ مدرسه و کارهای پس‌زمینهٔ همین پنل.',
              style: TextStyle(color: tk.muted),
            ),
            SwitchListTile(
              key: const Key('proc-pause'),
              contentPadding: EdgeInsets.zero,
              value: v.procPaused,
              title: const Text('توقف پردازش'),
              subtitle: const Text(
                'کارهای سنگین پس‌زمینه (صف کارهای کمکی، بکاپ خودکار، شمارش فضای دیتابیس، '
                'پایش امنیت) متوقف می‌شوند. کار کاربران و همگام‌سازی داده ادامه دارد.',
              ),
              onChanged: (on) => unawaited(p.setProcessing(paused: on)),
            ),
            SwitchListTile(
              key: const Key('proc-cpu-on'),
              contentPadding: EdgeInsets.zero,
              value: cpu != null,
              title: const Text('سقف مصرف CPU'),
              subtitle: Text(
                cpu == null
                    ? 'بدون سقف (پیش‌فرض)'
                    : 'حداکثر ${faDigits(cpu)}٪ از توان هر سیستم',
              ),
              onChanged: (on) =>
                  unawaited(p.setProcessing(cpu: on ? (cpu ?? 50) : 0)),
            ),
            if (cpu != null)
              Row(
                children: [
                  Expanded(
                    child: Slider(
                      key: const Key('proc-cpu'),
                      min: minCpuPercent.toDouble(),
                      max: 100,
                      divisions: 9,
                      value: shown.toDouble().clamp(
                        minCpuPercent.toDouble(),
                        100,
                      ),
                      label: '${faDigits(shown)}٪',
                      onChanged: (x) => setState(() => _drag = x),
                      onChangeEnd: (x) {
                        setState(() => _drag = null);
                        unawaited(p.setProcessing(cpu: x.round()));
                      },
                    ),
                  ),
                  SizedBox(
                    width: 48,
                    child: Text(
                      '${faDigits(shown)}٪',
                      key: const Key('proc-cpu-value'),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ],
              ),
            Text(
              v.procPaused
                  ? 'همین سیستم: پردازش متوقف است.'
                  : 'همین سیستم: حداکثر ${faDigits(slots)} کار هم‌زمان.',
              key: const Key('proc-local'),
              style: TextStyle(color: tk.muted),
            ),
            const SizedBox(height: 4),
            Text(
              note,
              key: const Key('proc-note'),
              style: TextStyle(color: p.pending ? tk.warning : tk.muted),
            ),
          ],
        ),
      ),
    );
  }
}
