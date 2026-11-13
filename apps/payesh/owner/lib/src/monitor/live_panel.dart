// داشبورد: «پایش زنده زیرساخت» — برای هر زیرساخت سرعت، ترافیک و درصد استفاده از ظرفیت،
// هر ثانیه به‌روز، با نمودار کوچک ۶۰ ثانیهٔ اخیر (ردیف ۱۳۰).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'live_monitor.dart';

class LiveInfraPanel extends StatefulWidget {
  const LiveInfraPanel({
    super.key,
    required this.monitor,
    this.api,
    this.infraEvery = const Duration(seconds: 30),
  });
  final LiveMonitor monitor;

  /// برای فهرست سرویس‌ها/Endpointها (`/infra`)؛ null ⇒ فقط دیتابیس.
  final OwnerApi? api;
  final Duration infraEvery;

  @override
  State<LiveInfraPanel> createState() => _LiveInfraPanelState();
}

class _LiveInfraPanelState extends State<LiveInfraPanel> {
  Timer? _infraTimer;

  @override
  void initState() {
    super.initState();
    widget.monitor.attach();
    unawaited(_loadInfra());
    if (widget.api != null) {
      _infraTimer = Timer.periodic(widget.infraEvery, (_) => _loadInfra());
    }
  }

  Future<void> _loadInfra() async {
    final api = widget.api;
    if (api == null) return;
    final r = await api.infra();
    if (!mounted || !r.ok || r.body == null) return;
    widget.monitor.setInfra(r.body!);
  }

  @override
  void dispose() {
    _infraTimer?.cancel();
    widget.monitor.detach();
    super.dispose();
  }

  Future<void> _editCapacity() async {
    final m = widget.monitor;
    final cur = m.capacityBytes;
    final v = await showDialog<String>(
      context: context,
      builder: (ctx) =>
          _CapacityDialog(initial: cur == null ? '' : _gbText(cur / (1 << 30))),
    );
    if (v == null) return;
    final gb = double.tryParse(normDigits(v).replaceAll('٫', '.').trim());
    await m.setDbCapacity(
      gb == null || gb <= 0 ? null : (gb * (1 << 30)).round(),
    );
  }

  static String _gbText(double gb) => gb == gb.roundToDouble()
      ? gb.round().toString()
      : gb.toStringAsFixed(2).replaceAll(RegExp(r'0+$'), '');

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.monitor,
    builder: (context, _) {
      final items = widget.monitor.items;
      final tk = context.tokens;
      return Column(
        key: const Key('live-infra'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(
                'پایش زنده زیرساخت',
                style: Theme.of(context).textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(width: 8),
              _LivePulse(
                on: widget.monitor.running,
                beat: widget.monitor.beats,
              ),
            ],
          ),
          const SizedBox(height: PayeshTokens.space2),
          if (items.isEmpty)
            Text(
              'هنوز زیرساختی برای پایش نیست؛ دیتابیس را در «تنظیمات» و سرورها را در «زیرساخت» ثبت کنید.',
              style: TextStyle(color: tk.muted),
            )
          else
            LayoutBuilder(
              builder: (context, c) {
                final w = c.maxWidth >= 760
                    ? (c.maxWidth - 12) / 2
                    : c.maxWidth;
                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (final i in items)
                      SizedBox(
                        width: w,
                        child: _InfraCard(
                          key: Key('live-${i.id}'),
                          item: i,
                          onTap: widget.monitor.probeNow,
                          onEditCapacity: _editCapacity,
                        ),
                      ),
                  ],
                );
              },
            ),
        ],
      );
    },
  );
}

/// ظرفیت دیتابیس به گیگابایت (کنترل متن مال خود پنجره است تا پس از بسته شدن هم سالم بماند).
class _CapacityDialog extends StatefulWidget {
  const _CapacityDialog({required this.initial});
  final String initial;
  @override
  State<_CapacityDialog> createState() => _CapacityDialogState();
}

class _CapacityDialogState extends State<_CapacityDialog> {
  late final _c = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('ظرفیت دیتابیس'),
    content: TextField(
      key: const Key('db-capacity-input'),
      controller: _c,
      autofocus: true,
      textDirection: TextDirection.ltr,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: const InputDecoration(
        labelText: 'گیگابایت (خالی = تعیین نشده)',
        hintText: '100',
      ),
      onSubmitted: (t) => Navigator.pop(context, t),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('انصراف'),
      ),
      FilledButton(
        key: const Key('db-capacity-save'),
        onPressed: () => Navigator.pop(context, _c.text),
        child: const Text('ذخیره'),
      ),
    ],
  );
}

/// نشان «زنده» که با هر به‌روزرسانی یک بار می‌تپد.
class _LivePulse extends StatefulWidget {
  const _LivePulse({required this.on, required this.beat});
  final bool on;
  final int beat;
  @override
  State<_LivePulse> createState() => _LivePulseState();
}

class _LivePulseState extends State<_LivePulse>
    with SingleTickerProviderStateMixin {
  // یک تپش کوتاه با هر به‌روزرسانی (نه انیمیشن بی‌پایان)
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 500),
    value: 1,
  );

  @override
  void didUpdateWidget(_LivePulse old) {
    super.didUpdateWidget(old);
    if (widget.on && widget.beat != old.beat) _c.forward(from: 0);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.on ? context.tokens.danger : context.tokens.muted;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        FadeTransition(
          opacity: Tween(begin: 0.35, end: 1.0).animate(_c),
          child: Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
        ),
        const SizedBox(width: 4),
        Text(
          'زنده',
          style: TextStyle(
            color: color,
            fontSize: 12,
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

Color _pctColor(PayeshTokens tk, double pct) => pct >= 90
    ? tk.danger
    : pct >= 70
    ? tk.warning
    : tk.success;

class _InfraCard extends StatelessWidget {
  const _InfraCard({
    super.key,
    required this.item,
    required this.onTap,
    required this.onEditCapacity,
  });
  final InfraLive item;
  final Future<void> Function() onTap;
  final Future<void> Function() onEditCapacity;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final i = item;
    final dot = i.up == true
        ? tk.success
        : i.up == false
        ? tk.danger
        : tk.muted;
    final small = TextStyle(color: tk.muted, fontSize: 12);
    return Material(
      color: tk.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PayeshTokens.radius),
        side: BorderSide(color: tk.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(PayeshTokens.space3),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  StatusDot(color: dot),
                  const SizedBox(width: 6),
                  Icon(
                    i.kind == 'db'
                        ? Icons.storage_outlined
                        : Icons.dns_outlined,
                    size: 18,
                    color: tk.muted,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      i.name,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  if (i.detail != null)
                    Flexible(
                      child: Text(
                        i.detail!,
                        overflow: TextOverflow.ellipsis,
                        textDirection: TextDirection.ltr,
                        style: small,
                      ),
                    ),
                ],
              ),
              if (i.error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    faDigits(i.error!),
                    style: TextStyle(
                      color: i.up == false ? tk.danger : tk.muted,
                      fontSize: 12,
                    ),
                  ),
                ),
              const SizedBox(height: PayeshTokens.space2),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: _Metric(
                      key: Key('live-${i.id}-speed'),
                      label: 'سرعت',
                      value: i.latencyMs == null
                          ? '—'
                          : faDigits('${i.latencyMs} ms'),
                      sub: i.downBps == null
                          ? 'تأخیر پاسخ'
                          : faDigits('دانلود ${rateText(i.downBps)}'),
                    ),
                  ),
                  Expanded(
                    child: _Metric(
                      key: Key('live-${i.id}-traffic'),
                      label: 'ترافیک',
                      value: i.hasTraffic
                          ? faDigits(
                              '↓ ${rateText(i.rxBps)}  ↑ ${rateText(i.txBps)}',
                            )
                          : '—',
                      sub: i.hasTraffic
                          ? faDigits(
                              'مجموع ↓ ${bytesText(i.rxTotal)} · ↑ ${bytesText(i.txTotal)}'
                              '${i.reqPs == null ? '' : ' · ${i.reqPs!.toStringAsFixed(1)} درخواست/ث'}',
                            )
                          : 'برای ترافیک، Endpoint ‎/metrics ثبت کنید',
                    ),
                  ),
                ],
              ),
              const SizedBox(height: PayeshTokens.space2),
              SizedBox(
                height: 46,
                child: CustomPaint(
                  key: Key('live-${i.id}-chart'),
                  painter: _SparkPainter(
                    a: i.hasTraffic ? i.rx.values : i.latency.values,
                    b: i.hasTraffic ? i.tx.values : const [],
                    ca: tk.primary,
                    cb: tk.info,
                    grid: tk.line,
                  ),
                ),
              ),
              const SizedBox(height: PayeshTokens.space2),
              if (i.capacity.isEmpty)
                Text('درصد استفاده از ظرفیت: داده‌ای نیست', style: small)
              else
                for (final c in i.capacity)
                  _CapacityBar(
                    key: Key('live-${i.id}-cap-${c.label}'),
                    use: c,
                    onTap: c.editable ? onEditCapacity : null,
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({
    super.key,
    required this.label,
    required this.value,
    required this.sub,
  });
  final String label;
  final String value;
  final String sub;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(color: tk.muted, fontSize: 12)),
        Text(
          value,
          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
        ),
        Text(sub, style: TextStyle(color: tk.muted, fontSize: 11)),
      ],
    );
  }
}

class _CapacityBar extends StatelessWidget {
  const _CapacityBar({super.key, required this.use, this.onTap});
  final CapacityUse use;
  final Future<void> Function()? onTap;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final pct = use.pct;
    final color = pct == null ? tk.muted : _pctColor(tk, pct);
    final body = Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  use.estimated ? '${use.label} [E]' : use.label,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
              Text(
                pct == null ? '—' : faDigits('${pct.toStringAsFixed(1)}٪'),
                style: TextStyle(
                  color: color,
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                ),
              ),
              if (onTap != null) ...[
                const SizedBox(width: 4),
                Icon(Icons.edit_outlined, size: 14, color: tk.muted),
              ],
            ],
          ),
          const SizedBox(height: 3),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: pct == null ? 0 : pct / 100,
              minHeight: 7,
              color: color,
              backgroundColor: tk.line,
            ),
          ),
          if (use.text != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                faDigits(use.text!),
                style: TextStyle(color: tk.muted, fontSize: 11),
              ),
            ),
        ],
      ),
    );
    if (onTap == null) return body;
    return InkWell(onTap: onTap, child: body);
  }
}

/// نمودار کوچک دو سری (↓ و ↑) در ۶۰ ثانیهٔ اخیر؛ مقیاس با بیشینهٔ همان پنجره.
class _SparkPainter extends CustomPainter {
  _SparkPainter({
    required this.a,
    required this.b,
    required this.ca,
    required this.cb,
    required this.grid,
  });
  final List<double> a;
  final List<double> b;
  final Color ca;
  final Color cb;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final g = Paint()
      ..color = grid
      ..strokeWidth = 1;
    canvas.drawLine(
      Offset(0, size.height - 0.5),
      Offset(size.width, size.height - 0.5),
      g,
    );
    var peak = 0.0;
    for (final v in [...a, ...b]) {
      if (v > peak) peak = v;
    }
    if (peak <= 0) return;
    void series(List<double> s, Color c) {
      if (s.length < 2) return;
      final dx = size.width / 59;
      // آخرین نمونه سمت چپ (راست‌به‌چپ: زمان از راست به چپ جلو می‌رود)
      Offset at(int i) => Offset(
        (s.length - 1 - i) * dx,
        size.height - 2 - (s[i] / peak) * (size.height - 6),
      );
      final line = Path()..moveTo(at(0).dx, at(0).dy);
      for (var i = 1; i < s.length; i++) {
        line.lineTo(at(i).dx, at(i).dy);
      }
      final fill = Path.from(line)
        ..lineTo(at(s.length - 1).dx, size.height)
        ..lineTo(at(0).dx, size.height)
        ..close();
      canvas.drawPath(fill, Paint()..color = c.withValues(alpha: 0.12));
      canvas.drawPath(
        line,
        Paint()
          ..color = c
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6
          ..strokeJoin = StrokeJoin.round,
      );
    }

    series(a, ca);
    series(b, cb);
  }

  @override
  bool shouldRepaint(_SparkPainter old) => true;
}
