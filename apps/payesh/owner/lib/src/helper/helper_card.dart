import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../local/s3_client.dart';
import '../local/settings_page.dart';
import 'helper_box.dart';
import 'helper_node.dart';
import 'helper_service.dart';
import 'host_cpu.dart';
import '../power/activity.dart';

String fmtBytesFa(int b) {
  if (b < 1024) return '$b بایت';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} کیلوبایت';
  if (b < 1024 * 1024 * 1024) {
    return '${(b / (1024 * 1024)).toStringAsFixed(1)} مگابایت';
  }
  return '${(b / (1024 * 1024 * 1024)).toStringAsFixed(2)} گیگابایت';
}

const _whyFa = {
  'no_helper': 'سرور کمکیِ دیگری روشن نبود',
  'not_claimed': 'سرور کمکی کار را برنداشت',
  'lease_expired': 'سرور کمکی وسط کار خاموش شد',
  'lease_lost': 'سرور کمکی وسط کار خاموش شد',
  'helper_failed': 'سرور کمکی نتوانست انجام دهد',
  'bucket_unreachable': 'دیتابیس در دسترس نبود',
  'deadline': 'مهلت تمام شد',
  'not_needed': 'مسیر عادی؛ نیازی به سیستم کمکی نبود',
  'helpers_disabled': 'پردازش کمکی خاموش است',
};

/// «سرور کمکی»: روشن/خاموش (پیش‌فرض روشن)، وضعیت همین دستگاه، سرورهای کمکی فعال و یک
/// کار نمونه (محاسبهٔ مصرف فضای دیتابیس) که از سرور کمکی یا همین دستگاه انجام می‌شود.
class HelperCard extends StatefulWidget {
  const HelperCard({
    super.key,
    required this.service,
    this.now,
    this.cpu,
    this.liveEvery,
    this.memory,
  });
  final OwnerHelperService service;
  final DateTime Function()? now;

  /// ردیف ۱۶۵ — مصرف زندهٔ پردازندهٔ همین رایانه (پیش‌فرض: [HostCpuMeter]).
  final HostCpuMeter? cpu;

  /// فاصلهٔ نمونه‌گیری زنده؛ پیش‌فرض ۱ ثانیه (در آزمون‌ها خاموش مگر صریحاً داده شود).
  final Duration? liveEvery;

  /// حافظهٔ برنامه (بایت)؛ پیش‌فرض ProcessInfo.currentRss.
  final int Function()? memory;

  @override
  State<HelperCard> createState() => _HelperCardState();
}

class _HelperCardState extends State<HelperCard> {
  StreamSubscription<void>? _sub;
  List<HelperPresence>? _helpers;
  String? _helpersError;
  bool _busy = false;
  String? _usage;
  bool _usageOk = true;
  late final HostCpuMeter _cpu = widget.cpu ?? HostCpuMeter();
  PacedTimer? _live;
  int? _rss;
  double? _cpuDrag;
  bool _toggling = false;

  @override
  void initState() {
    super.initState();
    widget.service.policy.addListener(_redraw);
    unawaited(_attach());
    final every =
        widget.liveEvery ??
        (Platform.environment.containsKey('FLUTTER_TEST')
            ? null
            : const Duration(seconds: 1));
    _sampleLive();
    if (every != null) {
      _live = PacedTimer.periodic(every, () {
        _sampleLive();
        if (mounted) setState(() {});
      }, idleEvery: every * 10);
    }
  }

  void _sampleLive() {
    _cpu.sample();
    try {
      _rss = (widget.memory ?? () => ProcessInfo.currentRss)();
    } on Object {
      _rss = null;
    }
  }

  Future<void> _attach() async {
    await widget.service.ready;
    if (!mounted) return;
    _sub = widget.service.node?.changes.listen((_) {
      if (mounted) setState(() {});
    });
    setState(() {});
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.service.policy.removeListener(_redraw);
    _live?.cancel();
    unawaited(_sub?.cancel());
    super.dispose();
  }

  DateTime _clock() => (widget.now ?? DateTime.now)();

  Future<void> _loadHelpers() async {
    setState(() {
      _busy = true;
      _helpersError = null;
    });
    try {
      final h = await widget.service.helpers();
      if (mounted) setState(() => _helpers = h);
    } on S3Failure catch (e) {
      if (mounted) setState(() => _helpersError = e.messageFa);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _runUsage() async {
    setState(() {
      _busy = true;
      _usage = null;
    });
    try {
      final r = await widget.service.submit('storage.usage');
      if (!mounted) return;
      if (!r.ok) {
        setState(() {
          _usage = 'کار انجام نشد (${r.error}).';
          _usageOk = false;
        });
        return;
      }
      final res = r.result ?? const {};
      final who = r.byHelper
          ? 'انجام‌شده توسط سرور کمکی ${r.by}'
          : 'انجام‌شده روی همین دستگاه (${_whyFa[r.why] ?? r.why ?? ''})';
      setState(() {
        _usage =
            'مصرف دیتابیس: ${res['objects']} فایل، '
            '${fmtBytesFa((res['bytes'] as int?) ?? 0)} — $who';
        _usageOk = true;
      });
    } on S3Failure catch (e) {
      if (mounted) {
        setState(() {
          _usage = e.messageFa;
          _usageOk = false;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// ردیف ۱۷۸ — چیزی که جلوی کار همین سیستم را گرفته (null ⇒ در حال کار).
  String? _stopReason(HelperNode node) {
    final p = widget.service.policy.value;
    if (p.procPaused) {
      return 'پردازش همهٔ سیستم‌ها از «کنترل پردازش» متوقف است.';
    }
    if (node.paused) return 'متوقف. کاری به این دستگاه داده نمی‌شود.';
    if (!p.helpers) return 'پردازش کمکی خاموش است (حالت «فقط دیتابیس»).';
    if (!p.helperOn(node.helperId)) {
      return 'پردازش کمکی برای همین سیستم خاموش است.';
    }
    return null;
  }

  Future<void> _toggle(bool running) async {
    setState(() => _toggling = true);
    try {
      if (running) {
        await widget.service.setPaused(true);
      } else {
        await widget.service.startHelper();
      }
    } finally {
      if (mounted) setState(() => _toggling = false);
    }
  }

  /// ردیف ۱۷۸ — «شروع/توقف» و «مقدار پردازش» همین سیستم، داخل همین کارت.
  Widget _controls(BuildContext context, HelperNode? node, bool running) {
    final tk = context.tokens;
    final svc = widget.service;
    final local = svc.localCpu;
    final global = svc.policy.value.cpuPercent;
    final shown = (_cpuDrag ?? (local ?? 100).toDouble()).round();
    final eff = minCpu(shown >= 100 ? null : shown, global);
    final slots = svc.slots ?? slotsForCpu(eff);
    final ready = node != null && node.configured;
    return Container(
      key: const Key('helper-controls'),
      padding: const EdgeInsets.all(PayeshTokens.space3),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(tk.cardRadius - 4),
        border: Border.all(color: tk.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  running
                      ? 'پردازش کمکی این سیستم در حال کار است'
                      : 'پردازش کمکی این سیستم متوقف است',
                  key: const Key('helper-run-state'),
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: running ? tk.success : tk.warning,
                  ),
                ),
              ),
              running
                  ? OutlinedButton.icon(
                      key: const Key('helper-toggle'),
                      onPressed: !ready || _toggling
                          ? null
                          : () => unawaited(_toggle(true)),
                      icon: const Icon(Icons.stop_circle_outlined),
                      label: const Text('توقف'),
                    )
                  : FilledButton.icon(
                      key: const Key('helper-toggle'),
                      onPressed: !ready || _toggling
                          ? null
                          : () => unawaited(_toggle(false)),
                      icon: const Icon(Icons.play_arrow_rounded),
                      label: const Text('شروع'),
                    ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'مقدار پردازش این سیستم',
            style: TextStyle(color: tk.muted, fontSize: 12),
          ),
          Row(
            children: [
              Expanded(
                child: Slider(
                  key: const Key('helper-cpu'),
                  min: minCpuPercent.toDouble(),
                  max: 100,
                  divisions: 9,
                  value: shown.toDouble().clamp(minCpuPercent.toDouble(), 100),
                  label: '${faDigits(shown)}٪',
                  onChanged: ready ? (x) => setState(() => _cpuDrag = x) : null,
                  onChangeEnd: (x) {
                    setState(() => _cpuDrag = null);
                    unawaited(svc.setLocalCpu(x.round()));
                  },
                ),
              ),
              SizedBox(
                width: 56,
                child: Text(
                  shown >= 100 ? 'کامل' : '${faDigits(shown)}٪',
                  key: const Key('helper-cpu-value'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          Text(
            '${eff == null ? 'بدون سقف' : 'حداکثر ${faDigits(eff)}٪ از توان این رایانه'}'
            ' — هم‌زمان حداکثر ${faDigits(slots)} کار'
            '${eff == null ? '' : '، با استراحت کوتاه بین کارها'}.'
            '${global != null && (local == null || global < local) ? ' سقف کلی «کنترل پردازش» ${faDigits(global)}٪ است و کمترینِ دو سقف اعمال می‌شود.' : ''}',
            key: const Key('helper-cpu-note'),
            style: TextStyle(color: tk.muted, fontSize: 12),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.service.node;
    final tk = context.tokens;
    final String status;
    var ok = true;
    if (node == null) {
      status = 'در حال آماده‌سازی…';
    } else if (!node.configured) {
      status = 'اول دیتابیس را تنظیم و ذخیره کنید؛ بعد این دستگاه خودکار سرور کمکی می‌شود.';
      ok = false;
    } else if (_stopReason(node) != null) {
      status = _stopReason(node)!;
      ok = false;
    } else if (node.lastError != null) {
      status = 'به دیتابیس نرسیدیم: ${node.lastError}';
      ok = false;
    } else {
      status =
          'فعال — ${node.done} کار انجام شد'
          '${node.failed > 0 ? '، ${node.failed} ناموفق' : ''}'
          '${node.activeJobs > 0 ? '، ${node.activeJobs} در حال انجام' : ''}'
          '؛ هم‌زمان حداکثر ${node.slots} کار.';
    }
    return SettingsSection(
      title: 'پردازش کمکی (همین سیستم)',
      subtitle:
          'شروع/توقف و مقدار پردازش همین سیستم در همین کارت است. هر کاری اول روی همان سیستمی انجام می‌شود که '
          'آن را لازم دارد؛ فقط وقتی آن سیستم شلوغ است یا بررسی «از بیرون» لازم است، کار در '
          'دیتابیس گذاشته می‌شود تا یک سیستم کمکیِ روشن انجام دهد. اگر هیچ سیستم کمکی روشن '
          'نباشد، همان سیستم خودش انجام می‌دهد؛ پس پردازش هیچ‌وقت متوقف نمی‌شود. محتوای مدارس '
          'به سیستم کمکی داده نمی‌شود.',
      children: [
        _livePanel(context, node, ok),
        const SizedBox(height: 12),
        _controls(
          context,
          node,
          node != null && node.configured && _stopReason(node) == null,
        ),
        const SizedBox(height: 12),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(
            status,
            key: const Key('helper-status'),
            style: TextStyle(color: ok ? tk.success : tk.danger),
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton(
              key: const Key('helper-list'),
              onPressed: _busy || node == null || !node.configured
                  ? null
                  : _loadHelpers,
              child: const Text('سرورهای کمکی فعال'),
            ),
            OutlinedButton(
              key: const Key('helper-usage'),
              onPressed: _busy || node == null || !node.configured
                  ? null
                  : _runUsage,
              child: const Text('محاسبهٔ مصرف فضای دیتابیس'),
            ),
          ],
        ),
        if (_busy)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: LinearProgressIndicator(),
          ),
        if (_usage != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              _usage!,
              key: const Key('helper-usage-result'),
              style: TextStyle(color: _usageOk ? tk.success : tk.danger),
            ),
          ),
        if (_helpersError != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              _helpersError!,
              key: const Key('helper-list-error'),
              style: TextStyle(color: tk.danger),
            ),
          ),
        if (_helpers != null) ...[
          const SizedBox(height: 12),
          Text(
            'سرورهای کمکی (${_helpers!.where((h) => h.onlineAt(_clock())).length} فعال از ${_helpers!.length}):',
            key: const Key('helper-count'),
          ),
          for (final h in _helpers!)
            ListTile(
              key: Key('helper-${h.helperId}'),
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                h.onlineAt(_clock())
                    ? Icons.check_circle_outline
                    : Icons.pause_circle_outline,
                color: h.onlineAt(_clock()) ? tk.success : tk.muted,
              ),
              title: Text(
                '${h.host.isEmpty ? h.helperId : h.host}'
                '${h.helperId == node?.helperId ? ' (همین دستگاه)' : ''}',
              ),
              subtitle: Text(
                '${h.onlineAt(_clock())
                    ? 'فعال'
                    : h.paused
                    ? 'متوقف'
                    : 'خاموش'} · ${h.done} کار · ${h.version}',
              ),
            ),
        ],
        if (node != null && node.recent.isNotEmpty) ...[
          const SizedBox(height: 12),
          const Text('آخرین کارهای این دستگاه:'),
          for (final j in node.recent.take(5))
            Text(
              '${j.ok ? '✓' : '✗'} ${helperJobKindsFa[j.kind] ?? j.kind} · '
              '${faNumber(j.ms)} میلی‌ثانیه',
              key: Key('helper-job-${j.jobId}'),
              style: TextStyle(color: tk.muted),
            ),
        ],
      ],
    );
  }

  /// ردیف ۱۶۵ — «زنده»: پردازندهٔ همین رایانه (درصد + نمودار ۶۰ ثانیه)، حافظهٔ برنامه، جاهای
  /// کار در حال استفاده و گزارش کار لحظه‌ای همین سرور کمکی.
  Widget _livePanel(BuildContext context, HelperNode? node, bool active) {
    final tk = context.tokens;
    final cpu = _cpu.last;
    final cpuTone = cpu == null
        ? tk.muted
        : cpu >= 85
        ? tk.danger
        : cpu >= 60
        ? tk.warning
        : tk.success;
    final events = node?.activity ?? const <HelperEvent>[];
    String hms(DateTime t) => faDigits(
      '${t.hour.toString().padLeft(2, '0')}:'
      '${t.minute.toString().padLeft(2, '0')}:'
      '${t.second.toString().padLeft(2, '0')}',
    );
    Widget stat(String key, String label, String value, {Color? color}) =>
        Expanded(
          child: Column(
            key: Key(key),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: TextStyle(color: tk.muted, fontSize: 12)),
              const SizedBox(height: 2),
              Text(
                value,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                  color: color ?? tk.ink,
                ),
              ),
            ],
          ),
        );
    return Container(
      key: const Key('helper-live'),
      padding: const EdgeInsets.all(PayeshTokens.space3),
      decoration: BoxDecoration(
        color: tk.soft,
        borderRadius: BorderRadius.circular(tk.cardRadius - 4),
        border: Border.all(color: tk.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                Icons.circle,
                size: 10,
                color: active && node != null && !node.paused
                    ? tk.success
                    : tk.muted,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  active && node != null && !node.paused
                      ? 'زنده — این سیستم سرور کمکی فعال است'
                      : 'زنده — این سیستم الان کار کمکی نمی‌گیرد',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              stat(
                'helper-live-cpu',
                'پردازندهٔ این رایانه',
                cpu == null ? '—' : '${faNumber(cpu.round())}٪',
                color: cpuTone,
              ),
              stat(
                'helper-live-mem',
                'حافظهٔ پنل',
                _rss == null ? '—' : fmtBytesFa(_rss!),
              ),
              stat(
                'helper-live-jobs',
                'کار در حال انجام',
                node == null
                    ? '—'
                    : '${faNumber(node.activeJobs)} از ${faNumber(node.slots)}',
              ),
              stat(
                'helper-live-done',
                'انجام‌شده',
                node == null
                    ? '—'
                    : faNumber(node.done) +
                          (node.failed > 0
                              ? ' · ${faNumber(node.failed)} ناموفق'
                              : ''),
              ),
            ],
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 44,
            child: CustomPaint(
              key: const Key('helper-live-chart'),
              painter: _SparkPainter(List.of(_cpu.history), cpuTone, tk.line),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'گزارش کار لحظه‌ای',
            style: TextStyle(color: tk.muted, fontSize: 12),
          ),
          const SizedBox(height: 4),
          if (events.isEmpty)
            Text(
              'هنوز رخدادی نیست.',
              key: const Key('helper-log-empty'),
              style: TextStyle(color: tk.muted),
            )
          else
            for (final (i, e) in events.take(8).indexed)
              Padding(
                key: Key('helper-log-$i'),
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      hms(e.at),
                      textDirection: TextDirection.ltr,
                      style: TextStyle(
                        color: tk.muted,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Icon(
                      e.ok ? Icons.check_circle_outline : Icons.error_outline,
                      size: 16,
                      color: e.ok ? tk.success : tk.danger,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        e.count > 1
                            ? '${e.text} (×${faNumber(e.count)})'
                            : e.text,
                      ),
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

class _SparkPainter extends CustomPainter {
  _SparkPainter(this.values, this.color, this.grid);
  final List<double> values;
  final Color color;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final g = Paint()
      ..color = grid
      ..strokeWidth = 1;
    canvas.drawLine(Offset(0, size.height), Offset(size.width, size.height), g);
    canvas.drawLine(
      Offset(0, size.height / 2),
      Offset(size.width, size.height / 2),
      g..color = grid.withValues(alpha: 0.5),
    );
    if (values.length < 2) return;
    const slots = 60;
    final dx = size.width / (slots - 1);
    final start = slots - values.length;
    final path = Path();
    for (var i = 0; i < values.length; i++) {
      // RTL: تازه‌ترین سمت چپ نیست؛ زمان از راست به چپ جلو می‌رود
      final x = size.width - (start + i) * dx;
      final y = size.height - (values[i] / 100) * size.height;
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    final fill = Path.from(path)
      ..lineTo(size.width - (slots - 1) * dx, size.height)
      ..lineTo(size.width - start * dx, size.height)
      ..close();
    canvas.drawPath(fill, Paint()..color = color.withValues(alpha: 0.15));
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(_SparkPainter old) => true;
}
