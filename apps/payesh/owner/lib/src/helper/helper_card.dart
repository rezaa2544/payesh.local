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
import '../monitor/net_meter.dart';
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
    this.procCpu,
    this.liveEvery,
    this.memory,
    this.compact = false,
  });

  /// Row 180 design 2: the dashboard's compact card as drawn — title + status line, the
  /// segmented «شروع | توقف», «مقدار پردازش» with its slider (۱۰٪ … کامل) and three stats
  /// (row 191: مصرف این برنامه · کل سیستم · انجام‌شده). The full card stays on «زیرساخت».
  final bool compact;
  final OwnerHelperService service;
  final DateTime Function()? now;

  /// ردیف ۱۶۵ — مصرف زندهٔ پردازندهٔ همین رایانه (پیش‌فرض: [HostCpuMeter]).
  final HostCpuMeter? cpu;

  /// ردیف ۱۹۱ — مصرف واقعی همین برنامه (پیش‌فرض: [ProcessCpuMeter]).
  final ProcessCpuMeter? procCpu;

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
  // ردیف ۲۱۰: وضعیت صف؛ ردیف ۲۰۹: صدور/ابطال توکن مدرسه.
  HelperQueueStatus? _queue;
  final TextEditingController _schoolIdCtl = TextEditingController();
  String? _issuedToken;
  String? _tokenMsg;
  bool _tokenOk = true;
  List<String> _revokedSchools = const [];

  late final ProcessCpuMeter _proc = widget.procCpu ?? ProcessCpuMeter();
  Map<String, Object?> Function()? _diagFn;
  PacedTimer? _live;
  int _quietTicks = 0;
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
    // ردیف ۱۹۸-U4: همان درصدهای نشان‌داده‌شده در پروندهٔ عیب‌یابی (مقایسه با Task Manager)
    NetMeter.diagExtra = _diagFn = () => {
      'cpu': {
        'system_pct': _cpu.last,
        'utility_based': _cpu.utilityBased,
        'scale': _cpu.scale,
        'app_pct_raw': _proc.last,
        'app_pct_shown': _cpu.asTaskManager(_proc.last),
        'done': widget.service.node?.done,
        'local_done': widget.service.node?.localDone,
      },
    };
    if (every != null) {
      _live = PacedTimer.periodic(every, () {
        // ردیف ۱۹۱: وقتی همین سیستم «متوقف» است خودِ پایش هم کم‌کار می‌شود (هر ۵ ثانیه)
        // تا عدد نشان‌داده‌شده مصرف واقعیِ برنامهٔ متوقف باشد، نه هزینهٔ اندازه‌گیری.
        if (widget.service.stopped && ++_quietTicks % 5 != 0) return;
        _sampleLive();
        if (mounted) setState(() {});
      }, idleEvery: every * 10);
    }
  }

  void _sampleLive() {
    _cpu.sample();
    _proc.sample();
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
    _schoolIdCtl.dispose();
    if (identical(NetMeter.diagExtra, _diagFn)) NetMeter.diagExtra = null;
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

  /// ردیف ۲۱۰ — خط وضعیت یک اجراکننده در نمای یکپارچه (کلاس/توانایی/مدرسه).
  String _helperSubtitle(HelperPresence h) {
    final parts = <String>[
      h.onlineAt(_clock())
          ? 'فعال'
          : h.paused
          ? 'متوقف'
          : 'خاموش',
      '${h.done} کار',
      h.version,
      'کلاس: ${h.cls}',
      if (h.schoolId != null) 'مدرسه: ${h.schoolId}',
      'توانایی‌ها: ${h.caps.join('، ')}',
    ];
    return parts.join(' · ');
  }

  /// ردیف ۲۱۰ — خواندن وضعیت صف و فهرست ابطال‌ها برای نمای یکپارچه.
  Future<void> _loadQueue() async {
    setState(() => _busy = true);
    try {
      final q = await widget.service.queueStatus();
      final r = await widget.service.revokedSchools();
      if (mounted) {
        setState(() {
          _queue = q;
          _revokedSchools = r;
        });
      }
    } on S3Failure catch (e) {
      if (mounted) setState(() => _helpersError = e.messageFa);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// ردیف ۲۰۹ — صدور توکن مدرسه (فقط توکن مشتق‌شده نشان داده می‌شود).
  void _issueToken() {
    try {
      final t = widget.service.issueSchoolToken(_schoolIdCtl.text);
      setState(() {
        _issuedToken = t;
        _tokenOk = true;
        _tokenMsg = 'توکن مدرسه صادر شد؛ فقط همین را به مدرسه بدهید.';
      });
    } on S3Failure catch (e) {
      setState(() {
        _issuedToken = null;
        _tokenOk = false;
        _tokenMsg = e.messageFa;
      });
    }
  }

  /// ردیف ۲۰۹ — ابطال توکن مدرسهٔ نوشته‌شده در کادر شناسه.
  Future<void> _revokeToken() async {
    setState(() => _busy = true);
    try {
      final id = _schoolIdCtl.text.trim();
      await widget.service.revokeSchoolToken(id);
      final r = await widget.service.revokedSchools();
      if (mounted) {
        setState(() {
          _revokedSchools = r;
          _issuedToken = null;
          _tokenOk = true;
          _tokenMsg = 'توکن مدرسهٔ $id باطل شد.';
        });
      }
    } on S3Failure catch (e) {
      if (mounted) {
        setState(() {
          _tokenOk = false;
          _tokenMsg = e.messageFa;
        });
      }
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
          const SizedBox(height: 6),
          _capLine(context, eff),
        ],
      ),
    );
  }

  /// ردیف ۱۹۱: درصد با یک رقم اعشار زیر ۱۰ (۰٫۴٪)، بی‌اعشار بالاتر؛ نامعلوم ⇒ «—».
  static String _pctFa(double? v) {
    if (v == null) return '—';
    final t = v < 10 ? v.toStringAsFixed(1) : v.round().toString();
    return '${faDigits(t).replaceAll('.', '٫')}٪';
  }

  /// ردیف ۱۹۱/۱۹۶: سقف چطور اعمال می‌شود. ردیف ۱۹۶: سقف فقط کارهای پس‌زمینه را محدود
  /// می‌کند؛ خود صفحه هیچ‌وقت محدود نمی‌شود تا روان بماند.
  Widget _capLine(BuildContext context, int? eff) {
    final tk = context.tokens;
    final stopped = widget.service.stopped;
    final String text;
    final Color color;
    if (eff == null) {
      text = 'بدون سقف: کارهای پس‌زمینه هر قدر لازم باشد از پردازنده استفاده می‌کنند.';
      color = tk.muted;
    } else {
      text =
          'سقف ${faDigits(eff)}٪ فقط برای کارهای پس‌زمینه (پردازش کمکی، پشتیبان خودکار، '
          'پایش): کارهای هم‌زمان کمتر و استراحت بین کارها. خود صفحه هیچ‌وقت محدود '
          'نمی‌شود تا روان بماند.';
      color = tk.success;
    }
    return Text(
      stopped
          ? '$text پردازش این سیستم متوقف است: کار کمکی، پشتیبان خودکار و سنجش‌های '
                'سنگین اجرا نمی‌شوند؛ آنچه می‌ماند فقط خود صفحه است.'
          : text,
      key: const Key('helper-cap'),
      style: TextStyle(color: color, fontSize: 11.5),
    );
  }

  /// Row 180 — the compact dashboard card (design 2).
  Widget _compactCard(BuildContext context, HelperNode? node) {
    final tk = context.tokens;
    final svc = widget.service;
    final ready = node != null && node.configured;
    final stop = node == null ? null : _stopReason(node);
    final running = ready && stop == null;
    final local = svc.localCpu;
    final global = svc.policy.value.cpuPercent;
    final shown = (_cpuDrag ?? (local ?? 100).toDouble()).round();
    final eff = minCpu(shown >= 100 ? null : shown, global);
    final cpu = _cpu.last;
    final mine = _cpu.asTaskManager(_proc.last);

    final String line;
    if (node == null) {
      line = 'در حال آماده‌سازی…';
    } else if (!node.configured) {
      line = 'اول دیتابیس را تنظیم کنید';
    } else if (stop != null) {
      line = 'متوقف';
    } else if (node.lastError != null) {
      line = 'به دیتابیس نرسیدیم';
    } else {
      line = node.activeJobs > 0
          ? 'در حال کار · ${faNumber(node.activeJobs)} کار در جریان'
          : 'آماده · کاری در صف نیست';
    }
    final lineTone = !ready || node.lastError != null
        ? tk.danger
        : stop != null
        ? tk.warning
        : tk.success;
    Widget seg(String key, String label, IconData icon, bool on, bool start) {
      return Expanded(
        child: Material(
          color: on ? tk.card : Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(6),
            side: BorderSide(color: on ? tk.line : Colors.transparent),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            key: Key(key),
            onTap: !ready || _toggling || on
                ? null
                : () => unawaited(_toggle(!start)),
            child: SizedBox(
              height: 36,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    label,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                      color: on ? tk.ink : tk.muted,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Icon(icon, size: 16, color: on ? tk.ink : tk.muted),
                ],
              ),
            ),
          ),
        ),
      );
    }

    Widget stat(String key, String label, String value) => Expanded(
      child: Container(
        key: Key(key),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: tk.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(fontSize: 11.5, color: tk.muted)),
            const SizedBox(height: 2),
            Text(
              value,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: tk.ink,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      ),
    );
    final small = TextStyle(fontSize: 11, color: tk.muted);
    return Card(
      key: const Key('helper-compact'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: 'پردازش کمکی',
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                                color: tk.ink,
                              ),
                            ),
                            TextSpan(
                              text: ' (همین سیستم)',
                              style: TextStyle(fontSize: 12.5, color: tk.muted),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: lineTone,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              line,
                              key: const Key('helper-run-state'),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12, color: tk.muted),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: tk.line),
                  ),
                  child: Icon(Icons.memory_rounded, size: 18, color: tk.ink2),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: tk.soft,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: tk.line),
              ),
              child: Row(
                children: [
                  seg(
                    'helper-start',
                    'شروع',
                    Icons.play_arrow_outlined,
                    running,
                    true,
                  ),
                  const SizedBox(width: 3),
                  seg('helper-stop', 'توقف', Icons.pause, !running, false),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'مقدار پردازش',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: tk.ink,
                    ),
                  ),
                ),
                Text(
                  shown >= 100 ? 'کامل' : '${faDigits(shown)}٪',
                  key: const Key('helper-cpu-value'),
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: tk.ink,
                  ),
                ),
              ],
            ),
            SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 4,
                activeTrackColor: tk.link,
                inactiveTrackColor: tk.track,
                thumbColor: tk.card,
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                thumbShape: const RoundSliderThumbShape(
                  enabledThumbRadius: 8,
                  elevation: 0,
                  pressedElevation: 0,
                ),
              ),
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
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                children: [
                  Text('${faDigits(minCpuPercent)}٪', style: small),
                  const Spacer(),
                  Text('${faDigits(50)}٪', style: small),
                  const Spacer(),
                  Text('کامل', style: small),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                // ردیف ۱۹۱: عدد واقعی همین برنامه (همان ستون CPU در Task Manager)،
                // جدا از مصرف کل رایانه که برنامه‌های دیگر هم در آن هستند
                stat('helper-stat-cpu', 'مصرف این برنامه', _pctFa(mine)),
                const SizedBox(width: 8),
                stat('helper-stat-host', 'کل سیستم', _pctFa(cpu)),
                const SizedBox(width: 8),
                stat(
                  'helper-stat-done',
                  'انجام‌شده',
                  faNumber(node?.doneTotal ?? 0),
                ),
              ],
            ),
            const SizedBox(height: 8),
            _capLine(context, eff),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.service.node;
    final tk = context.tokens;
    if (widget.compact && tk.isMinimal) return _compactCard(context, node);
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
          'فعال — ${node.doneTotal} کار انجام شد'
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
            OutlinedButton(
              key: const Key('helper-queue'),
              onPressed: _busy || node == null || !node.configured
                  ? null
                  : _loadQueue,
              child: const Text('وضعیت صف کارها'),
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
              subtitle: Text(_helperSubtitle(h)),
            ),
        ],
        if (_queue != null) ...[
          const SizedBox(height: 12),
          Text(_queueLine(_queue!), key: const Key('helper-queue-result')),
        ],
        const SizedBox(height: 16),
        const Text('توکن مدرسه (ردیف ۲۰۹):'),
        const SizedBox(height: 8),
        TextField(
          key: const Key('helper-school-id'),
          controller: _schoolIdCtl,
          decoration: const InputDecoration(
            labelText: 'شناسهٔ مدرسه (مثل school-01)',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton(
              key: const Key('helper-token-issue'),
              onPressed: _busy || node == null || !node.configured
                  ? null
                  : _issueToken,
              child: const Text('صدور توکن مدرسه'),
            ),
            OutlinedButton(
              key: const Key('helper-token-revoke'),
              onPressed: _busy || node == null || !node.configured
                  ? null
                  : _revokeToken,
              child: const Text('ابطال توکن مدرسه'),
            ),
          ],
        ),
        if (_tokenMsg != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _tokenMsg!,
              key: const Key('helper-token-status'),
              style: TextStyle(color: _tokenOk ? tk.success : tk.danger),
            ),
          ),
        if (_issuedToken != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SelectableText(
              _issuedToken!,
              key: const Key('helper-token-result'),
            ),
          ),
        if (_revokedSchools.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'توکن باطل‌شده: ${_revokedSchools.join('، ')}',
              key: const Key('helper-token-revoked'),
              style: TextStyle(color: tk.muted),
            ),
          ),
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
                'helper-live-proc',
                'مصرف این برنامه',
                _pctFa(_cpu.asTaskManager(_proc.last)),
              ),
              stat(
                'helper-live-cpu',
                'کل رایانه',
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
                    : faNumber(node.doneTotal) +
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
