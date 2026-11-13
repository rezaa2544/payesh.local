// «زیرساخت‌ها» (ردیف ۱۳۱): هر زیرساخت با کلید روشن/خاموش و چراغ وضعیت کنارش.
//   • دیتابیس: مسیر اصلی و همیشگی همهٔ برنامه‌ها (کاربران و پنل مدیریت) — خاموش‌شدنی نیست.
//   • پردازش کمکی: سیستم‌هایی که پنل مدیریت روی آن‌ها نصب است، فقط هنگام نیاز (سیاست مشترک
//     در دیتابیس؛ همهٔ پنل‌ها و سرورهای مدرسه پیروی می‌کنند).
//   • همین سیستم: آیا این دستگاه کار پردازشی دیگران را بردارد (ماندگار روی همین دستگاه).
//   • هر سرویس ثبت‌شده در «زیرساخت»: غیرفعال ⇒ پایش و بررسی نمی‌شود.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../helper/helper_box.dart';
import '../helper/helper_service.dart';
import '../local/s3_client.dart';
import '../status/status_lights.dart';

class InfraCard extends StatefulWidget {
  const InfraCard({
    super.key,
    this.helper,
    this.db,
    this.loadInfra,
    this.now,
    this.margin = EdgeInsets.zero,
  });

  final OwnerHelperService? helper;
  final DbMonitor? db;

  /// فهرست سرویس‌ها و Endpointها (همان پاسخ `/infra`).
  final Future<ApiResult> Function()? loadInfra;
  final DateTime Function()? now;
  final EdgeInsetsGeometry margin;

  @override
  State<InfraCard> createState() => _InfraCardState();
}

class _InfraCardState extends State<InfraCard> {
  StreamSubscription<void>? _sub;
  List<HelperPresence>? _helpers;
  List<Map<String, Object?>> _services = const [];
  List<Map<String, Object?>> _endpoints = const [];
  String? _infraError;
  bool _loading = false;
  Timer? _timer;

  OwnerHelperService? get _svc => widget.helper;

  @override
  void initState() {
    super.initState();
    widget.db?.addListener(_redraw);
    unawaited(_attach());
    unawaited(_load());
    // تعداد سرورهای کمکی فعال تازه بماند (فقط تا وقتی کارت باز است)
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _load());
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

  Future<void> _attach() async {
    final s = _svc;
    if (s == null) return;
    await s.ready;
    if (!mounted) return;
    s.policy.addListener(_redraw);
    _sub = s.node?.changes.listen((_) => _redraw());
    _redraw();
  }

  Future<void> _load() async {
    if (_loading) return;
    _loading = true;
    try {
      final s = _svc;
      final load = widget.loadInfra;
      final results = await Future.wait<Object?>([
        if (s != null && (s.node?.configured ?? false))
          s.helpers().then<Object?>((h) => h, onError: (_) => null)
        else
          Future.value(),
        if (load != null)
          load().then<Object?>((r) => r, onError: (_) => null)
        else
          Future.value(),
      ]);
      if (!mounted) return;
      setState(() {
        final h = results[0];
        if (h is List<HelperPresence>) _helpers = h;
        final r = results[1];
        if (r is ApiResult) {
          if (r.ok) {
            _services = r.list('services');
            _endpoints = r.list('endpoints');
            _infraError = null;
          } else {
            _infraError = r.message;
          }
        }
      });
    } on S3Failure {
      // فقط شمارش؛ خطای دیتابیس را چراغ دیتابیس نشان می‌دهد
    } finally {
      _loading = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.db?.removeListener(_redraw);
    _svc?.policy.removeListener(_redraw);
    unawaited(_sub?.cancel());
    super.dispose();
  }

  DateTime _clock() => (widget.now ?? DateTime.now)();

  Widget _row({
    required String id,
    required Color light,
    required String title,
    required String status,
    Widget? trailing,
    bool busy = false,
  }) => ListTile(
    key: Key('infra-row-$id'),
    contentPadding: EdgeInsets.zero,
    leading: StatusDot(
      key: Key('infra-light-$id'),
      color: light,
      busy: busy,
      size: 22,
    ),
    title: Text(title),
    subtitle: Text(status, key: Key('infra-status-$id')),
    trailing: trailing,
  );

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final s = _svc;
    final policy = s?.policy;
    final p = policy?.value;
    final node = s?.node;

    // دیتابیس
    final dbState = widget.db?.state?.state;
    final (dbColor, dbText) = switch (dbState) {
      'synced' => (tk.success, 'وصل — مسیر اصلی همهٔ برنامه‌ها'),
      'error' => (tk.danger, 'قطع — ${widget.db?.state?.error ?? ''}'),
      'not_configured' => (tk.muted, 'تنظیم نشده'),
      _ => (tk.muted, 'در حال بررسی…'),
    };

    // پردازش کمکی (همهٔ سیستم‌ها)
    final online = _helpers?.where((h) => h.onlineAt(_clock())).length;
    final helpersOn = p?.helpers ?? true;
    final Color hColor;
    final String hText;
    if (!helpersOn) {
      hColor = tk.muted;
      hText = 'خاموش — همهٔ کارها روی همان سیستم انجام می‌شود';
    } else if (online == null) {
      hColor = tk.muted;
      hText = 'روشن — فقط هنگام نیاز';
    } else if (online == 0) {
      hColor = tk.warning;
      hText = 'روشن — فعلاً سیستم کمکی فعالی نیست (کارها روی همان سیستم انجام می‌شود)';
    } else {
      hColor = tk.success;
      hText = 'روشن — $online سیستم کمکی فعال؛ فقط هنگام نیاز';
    }
    final syncNote = policy == null
        ? null
        : policy.pending
        ? 'تغییر روی همین دستگاه ذخیره شد؛ با وصل شدن دیتابیس برای همه ثبت می‌شود.'
        : policy.error != null
        ? 'خواندن از دیتابیس ناموفق بود: ${policy.error}'
        : null;

    // همین سیستم
    final Color selfColor;
    final String selfText;
    if (node == null) {
      selfColor = tk.muted;
      selfText = 'در حال آماده‌سازی…';
    } else if (!node.configured) {
      selfColor = tk.muted;
      selfText = 'بدون دیتابیس غیرفعال است';
    } else if (node.paused) {
      selfColor = tk.muted;
      selfText = 'خاموش — این سیستم کار پردازشی نمی‌گیرد';
    } else if (!helpersOn) {
      selfColor = tk.muted;
      selfText = 'منتظر — پردازش کمکی برای همه خاموش است';
    } else if (node.lastError != null) {
      selfColor = tk.danger;
      selfText = 'به دیتابیس نرسیدیم';
    } else {
      selfColor = tk.success;
      selfText =
          'فعال — ${node.done} کار انجام شد'
          '${node.activeJobs > 0 ? '، ${node.activeJobs} در حال انجام' : ''}';
    }

    return Card(
      key: const Key('infra-card'),
      margin: widget.margin,
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('زیرساخت‌ها', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'همهٔ برنامه‌ها (کاربران و پنل مدیریت) همیشه مستقیم با دیتابیس کار می‌کنند. '
              'سیستم‌هایی که پنل مدیریت روی آن‌ها نصب است فقط هنگام نیاز به پردازش '
              '(سیستم شلوغ است یا بررسی از بیرون لازم است) کمک می‌کنند.',
              style: TextStyle(color: tk.muted),
            ),
            const SizedBox(height: 8),
            _row(
              id: 'db',
              light: dbColor,
              title: 'دیتابیس',
              status: dbText,
              busy: widget.db?.checking ?? false,
              trailing: const Switch(
                key: Key('infra-db-switch'),
                value: true,
                onChanged: null,
              ),
            ),
            if (s != null) ...[
              _row(
                id: 'helpers',
                light: hColor,
                title: 'پردازش کمکی (همهٔ سیستم‌های پنل مدیریت)',
                status: hText,
                trailing: Switch(
                  key: const Key('infra-helpers-switch'),
                  value: helpersOn,
                  onChanged: policy == null || !policy.configured
                      ? null
                      : (v) => unawaited(policy.setHelpers(v)),
                ),
              ),
              _row(
                id: 'self',
                light: selfColor,
                title: 'استفاده از این سیستم برای پردازش کمکی',
                status: selfText,
                trailing: Switch(
                  key: const Key('helper-switch'),
                  value: node != null && !node.paused,
                  onChanged: node == null
                      ? null
                      : (v) async {
                          await s.setPaused(!v);
                          _redraw();
                        },
                ),
              ),
            ],
            for (final svc in _services) _serviceRow(svc, tk),
            if (_infraError != null)
              Text(
                _infraError!,
                key: const Key('infra-card-error'),
                style: TextStyle(color: tk.danger),
              ),
            if (syncNote != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  syncNote,
                  key: const Key('infra-policy-note'),
                  style: TextStyle(
                    color: policy!.pending ? tk.warning : tk.danger,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _serviceRow(Map<String, Object?> svc, PayeshTokens tk) {
    final id = '${svc['id']}';
    final store = _svc?.policy;
    final on = store?.value.serviceOn(id) ?? true;
    final eps = [
      for (final e in _endpoints)
        if ('${e['service_id']}' == id && e['enabled'] != false) e,
    ];
    final states = [
      for (final e in eps)
        e['health'] is Map ? '${(e['health']! as Map)['state']}' : 'unknown',
    ];
    final Color c;
    final String t;
    if (!on) {
      c = tk.muted;
      t = 'غیرفعال — پایش و بررسی نمی‌شود';
    } else if (eps.isEmpty) {
      c = tk.muted;
      t = 'فعال — Endpoint ثبت نشده';
    } else if (states.contains('up')) {
      c = states.contains('down') ? tk.warning : tk.success;
      t = 'فعال — وصل';
    } else if (states.contains('down')) {
      c = tk.danger;
      t = 'فعال — در دسترس نیست';
    } else {
      c = tk.muted;
      t = 'فعال — هنوز بررسی نشده';
    }
    return _row(
      id: 'svc-$id',
      light: c,
      title: '${svc['name'] ?? id}',
      status: t,
      trailing: Switch(
        key: Key('infra-svc-switch-$id'),
        value: on,
        onChanged: store == null || !store.configured
            ? null
            : (v) => unawaited(store.setService(id, v)),
      ),
    );
  }
}
