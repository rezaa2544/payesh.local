// «پشتیبان دیتابیس» (ردیف ۱۵۵): پشتیبان کامل، خودکار و افزایشی کل دیتابیس مالک.
//   • کلید «پشتیبان خودکار (هر ۱۵ دقیقه)» و کلید «نگهداری روی دیتابیس»؛ دیسک این سیستم همیشه؛
//   • وضعیت: آخرین بررسی، آخرین پشتیبان موفق، خطا، پیشرفت زنده؛
//   • «پشتیبان‌گیری اکنون»؛
//   • فهرست پشتیبان‌ها با جای نگهداری و «بازیابی» یک‌کلیکی (با تأیید).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../backup/backup_engine.dart';
import '../widgets.dart';

class BackupPage extends StatelessWidget {
  const BackupPage({super.key});

  @override
  Widget build(BuildContext context) {
    final b = OwnerScope.of(context).backup;
    if (b == null) {
      return const StateBox.empty('پشتیبان دیتابیس روی این دستگاه فعال نیست.');
    }
    return BackupView(engine: b);
  }
}

String _stamp(DateTime? t) {
  if (t == null) return '—';
  final l = t.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return faDigits(
    '${jalaliText(l.toIso8601String())} ${two(l.hour)}:${two(l.minute)}',
  );
}

String backupSizeFa(int bytes) {
  if (bytes < 1024) return '${faNumber(bytes)} بایت';
  if (bytes < 1 << 20) return '${faNumber((bytes / 1024).ceil())} کیلوبایت';
  return '${faDigits((bytes / (1 << 20)).toStringAsFixed(1))} مگابایت';
}

const Map<String, String> backupTargetFa = {
  'disk': 'دیسک این سیستم',
  'db': 'دیتابیس',
};

class BackupView extends StatefulWidget {
  const BackupView({super.key, required this.engine});
  final OwnerBackupEngine engine;

  @override
  State<BackupView> createState() => _BackupViewState();
}

class _BackupViewState extends State<BackupView> {
  String? _note;
  bool _noteOk = true;

  OwnerBackupEngine get e => widget.engine;

  @override
  void initState() {
    super.initState();
    unawaited(e.refresh());
  }

  void _flash(bool ok, String t) {
    if (mounted) {
      setState(() {
        _noteOk = ok;
        _note = t;
      });
    }
  }

  Future<void> _runNow() async {
    final r = await e.run();
    if (!r.ok) {
      _flash(false, r.error ?? 'پشتیبان ساخته نشد.');
    } else if (r.count == 0) {
      _flash(true, 'دیتابیس خالی است؛ پشتیبان تازه‌ای لازم نبود.');
    } else {
      _flash(
        true,
        r.created
            ? 'پشتیبان ساخته شد: ${faNumber(r.count)} فایل '
                  '(${faNumber(r.fetched)} فایل تازه یا تغییرکرده).'
            : 'تغییری نبود؛ آخرین پشتیبان همچنان کامل است.',
      );
    }
  }

  Future<void> _restore(BackupItem it) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('بازیابی کامل دیتابیس'),
        content: Text(
          'همهٔ ${faNumber(it.count)} فایلِ پشتیبان ${_stamp(it.at)} در دیتابیسِ '
          'تنظیم‌شده نوشته می‌شود. پیش از آن از وضع فعلی پشتیبان «پیش از بازیابی» '
          'گرفته می‌شود و فایل‌های تازه‌تر دست نمی‌خورند.\n\n'
          'برای انتقال به دیتابیس تازه، اول آن را در «تنظیمات» وارد کنید.',
        ),
        actions: [
          TextButton(
            key: const Key('backup-restore-cancel'),
            onPressed: () => Navigator.pop(c, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: const Key('backup-restore-confirm'),
            onPressed: () => Navigator.pop(c, true),
            child: const Text('بازیابی'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final r = await e.restore(it.id);
    if (!r.ok) {
      _flash(false, r.error ?? 'بازیابی انجام نشد.');
      return;
    }
    _flash(
      true,
      'بازیابی کامل شد: ${faNumber(r.written)} فایل نوشته شد، '
      '${faNumber(r.same)} فایل از قبل یکسان بود'
      '${r.newer > 0 ? '، ${faNumber(r.newer)} فایل تازه‌تر دست نخورد' : ''}.',
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: e,
    builder: (context, _) {
      final tk = context.tokens;
      final t = Theme.of(context).textTheme;
      final healthy =
          e.lastError == null &&
          e.lastSuccess != null &&
          DateTime.now().difference(e.lastSuccess!) < const Duration(hours: 1);
      return ListView(
        key: const Key('backup-page'),
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          if (_note != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                _note!,
                key: const Key('backup-note'),
                style: TextStyle(color: _noteOk ? tk.success : tk.danger),
              ),
            ),
          PayeshSection(
            title: 'پشتیبان کامل دیتابیس',
            trailing: StatusBadge(
              e.running
                  ? 'در حال کار'
                  : healthy
                  ? 'به‌روز'
                  : e.lastError != null
                  ? 'خطا'
                  : 'منتظر',
              key: const Key('backup-status'),
              tone: e.running
                  ? PayeshTone.info
                  : healthy
                  ? PayeshTone.success
                  : e.lastError != null
                  ? PayeshTone.danger
                  : PayeshTone.warning,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'همهٔ داده‌های دیتابیس (مدارس، کاربران، پرداخت‌ها، پشتیبانی، سیاست‌ها و '
                  'به‌روزرسانی‌ها) هر ۱۵ دقیقه بررسی و فقط تغییرها افزوده می‌شود. جدا از '
                  'پشتیبان روزانهٔ هر مدرسه در پنل مدیر است.',
                  style: t.bodySmall?.copyWith(color: tk.muted),
                ),
                SwitchListTile(
                  key: const Key('backup-auto'),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('پشتیبان خودکار (هر ۱۵ دقیقه)'),
                  subtitle: const Text('روی همهٔ سیستم‌های پنل مالک'),
                  value: e.autoOn,
                  onChanged: (v) => unawaited(e.setAuto(v)),
                ),
                SwitchListTile(
                  key: const Key('backup-db'),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('نگهداری روی دیتابیس هم'),
                  subtitle: const Text(
                    'علاوه بر دیسک هر سیستم مالک، در بخش جدای پشتیبان دیتابیس',
                  ),
                  value: e.dbOn,
                  onChanged: (v) => unawaited(e.setDb(v)),
                ),
                const SizedBox(height: 4),
                Text(
                  'آخرین بررسی: ${_stamp(e.lastCheck)} · '
                  'آخرین پشتیبان موفق: ${_stamp(e.lastSuccess)}',
                  key: const Key('backup-times'),
                ),
                for (final u in e.usage.entries)
                  Text(
                    'حجم روی ${backupTargetFa[u.key] ?? u.key}: ${backupSizeFa(u.value)}',
                    key: Key('backup-usage-${u.key}'),
                    style: t.bodySmall,
                  ),
                if (e.lastError != null)
                  Text(
                    e.lastError!,
                    key: const Key('backup-error'),
                    style: TextStyle(color: tk.danger),
                  ),
                if (e.running) ...[
                  const SizedBox(height: 8),
                  Text(e.phaseFa, key: const Key('backup-phase')),
                  LinearProgressIndicator(
                    value: e.progressTotal == 0
                        ? null
                        : e.progressDone / e.progressTotal,
                  ),
                ],
                const SizedBox(height: 8),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: FilledButton.icon(
                    key: const Key('backup-run'),
                    onPressed: e.running ? null : () => unawaited(_runNow()),
                    icon: const Icon(Icons.backup_outlined),
                    label: const Text('پشتیبان‌گیری اکنون'),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          PayeshSection(
            title: 'پشتیبان‌ها و بازیابی',
            child: e.items.isEmpty
                ? const Text(
                    'هنوز پشتیبانی ساخته نشده است.',
                    key: Key('backup-empty'),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final it in e.items.take(60))
                        ListTile(
                          key: Key('backup-item-${it.id}'),
                          contentPadding: EdgeInsets.zero,
                          leading: const Icon(Icons.inventory_2_outlined),
                          title: Text(
                            '${_stamp(it.at)}'
                            '${it.label.isEmpty ? '' : ' — ${it.label}'}',
                          ),
                          subtitle: Text(
                            '${faNumber(it.count)} فایل · ${backupSizeFa(it.bytes)} · '
                            '${[for (final x in it.targets) backupTargetFa[x] ?? x].join(' + ')}',
                          ),
                          trailing: OutlinedButton(
                            key: Key('backup-restore-${it.id}'),
                            onPressed: e.running
                                ? null
                                : () => unawaited(_restore(it)),
                            child: const Text('بازیابی'),
                          ),
                        ),
                    ],
                  ),
          ),
        ],
      );
    },
  );
}
