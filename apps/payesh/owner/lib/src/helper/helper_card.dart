import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../local/s3_client.dart';
import '../local/settings_page.dart';
import 'helper_box.dart';
import 'helper_service.dart';

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
};

/// «سرور کمکی»: روشن/خاموش (پیش‌فرض روشن)، وضعیت همین دستگاه، سرورهای کمکی فعال و یک
/// کار نمونه (محاسبهٔ مصرف فضای دیتابیس) که از سرور کمکی یا همین دستگاه انجام می‌شود.
class HelperCard extends StatefulWidget {
  const HelperCard({super.key, required this.service, this.now});
  final OwnerHelperService service;
  final DateTime Function()? now;

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

  @override
  void initState() {
    super.initState();
    unawaited(_attach());
  }

  Future<void> _attach() async {
    await widget.service.ready;
    if (!mounted) return;
    _sub = widget.service.node?.changes.listen((_) {
      if (mounted) setState(() {});
    });
    setState(() {});
  }

  @override
  void dispose() {
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
    } else if (node.paused) {
      status = 'متوقف (موقت). کاری به این دستگاه داده نمی‌شود.';
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
      title: 'سرور کمکی (همین دستگاه)',
      subtitle:
          'هر سیستمی که پنل مدیریت روی آن نصب است، به‌طور پیش‌فرض سرور کمکی هم هست: '
          'سرورهای مدرسه کارهای پردازشی را در دیتابیس می‌گذارند و هر سرور کمکیِ روشن آن را '
          'انجام می‌دهد. اگر هیچ سرور کمکی روشن نباشد، همان سیستم کار را خودش انجام می‌دهد؛ '
          'پس پردازش هیچ‌وقت متوقف نمی‌شود. محتوای مدارس به سرور کمکی داده نمی‌شود.',
      children: [
        SwitchListTile(
          key: const Key('helper-switch'),
          contentPadding: EdgeInsets.zero,
          title: const Text('سرور کمکی روشن باشد (پیش‌فرض)'),
          subtitle: const Text(
            'تا وقتی برنامه باز است (حتی کوچک‌شده) کار می‌کند؛ با اولویت پایین و حداکثر نصف هسته‌ها.',
          ),
          value: node != null && !node.paused,
          onChanged: node == null
              ? null
              : (v) async {
                  await widget.service.setPaused(!v);
                  if (mounted) setState(() {});
                },
        ),
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
              '${j.ok ? '✓' : '✗'} ${j.kind} · ${j.ms} میلی‌ثانیه',
              key: Key('helper-job-${j.jobId}'),
              style: TextStyle(color: tk.muted),
            ),
        ],
      ],
    );
  }
}

/// برای صفحهٔ «زیرساخت»: خلاصهٔ یک‌خطی.
class HelperSummary extends StatefulWidget {
  const HelperSummary({super.key, required this.service});
  final OwnerHelperService service;

  @override
  State<HelperSummary> createState() => _HelperSummaryState();
}

class _HelperSummaryState extends State<HelperSummary> {
  StreamSubscription<void>? _sub;

  @override
  void initState() {
    super.initState();
    unawaited(
      widget.service.ready.then((_) {
        if (!mounted) return;
        _sub = widget.service.node?.changes.listen((_) {
          if (mounted) setState(() {});
        });
        setState(() {});
      }),
    );
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final n = widget.service.node;
    final on = n != null && n.configured && !n.paused && n.lastError == null;
    return Card(
      key: const Key('helper-summary'),
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: ListTile(
        leading: Icon(
          Icons.hub_outlined,
          color: on ? context.tokens.success : context.tokens.muted,
        ),
        title: const Text('سرور کمکی (همین دستگاه)'),
        subtitle: Text(
          n == null
              ? 'در حال آماده‌سازی…'
              : !n.configured
              ? 'بدون دیتابیس غیرفعال است.'
              : n.paused
              ? 'متوقف (موقت) — از «تنظیمات» روشن کنید.'
              : n.lastError != null
              ? 'به دیتابیس نرسیدیم.'
              : 'فعال — ${n.done} کار انجام شد؛ هم‌زمان حداکثر ${n.slots} کار.',
        ),
      ),
    );
  }
}
