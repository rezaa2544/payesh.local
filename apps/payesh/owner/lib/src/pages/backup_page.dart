// «پشتیبان دیتابیس» (ردیف ۱۵۵): پشتیبان کامل، خودکار و افزایشی کل دیتابیس مالک.
//   • کلید «پشتیبان خودکار (هر ۱۵ دقیقه)» و کلید «نگهداری روی دیتابیس»؛ دیسک این سیستم همیشه؛
//   • وضعیت: آخرین بررسی، آخرین پشتیبان موفق، خطا، پیشرفت زنده؛
//   • «پشتیبان‌گیری اکنون»؛
//   • ردیف ۱۶۶: به‌جای فهرست بلند پشتیبان‌ها، فقط «یک فایل جامع» روی هر مقصد (دیسک این سیستم،
//     دیتابیس) که هر تغییر در آن ادغام می‌شود؛ هر نسخه «بازیابی» یک‌کلیکی و «حذف» (با تأیید) دارد.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../backup/backup_engine.dart';
import '../backup/backup_store.dart' show BackupFileInfo;
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

/// ردیف ۱۶۶ — یک خط برای همان یک فایل.
String backupFileFa(BackupFileInfo f) =>
    'به‌روز تا ${_stamp(f.at)} · ${faNumber(f.count)} فایل دیتابیس '
    '(${backupSizeFa(f.bytes)}) · حجم فایل پشتیبان ${backupSizeFa(f.size)}';

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
    final r = await e.run(force: true);
    if (!r.ok) {
      _flash(false, r.error ?? 'پشتیبان ساخته نشد.');
    } else if (r.count == 0) {
      _flash(true, 'دیتابیس خالی است؛ پشتیبان تازه‌ای لازم نبود.');
    } else {
      _flash(
        true,
        r.created
            ? 'تغییرها در فایل پشتیبان ادغام شد: ${faNumber(r.fetched)} فایل تازه یا '
                  'تغییرکرده دانلود شد (از کل ${faNumber(r.count)} فایل).'
            : 'تغییری نبود؛ چیزی دانلود نشد و فایل پشتیبان همچنان کامل است.',
      );
    }
  }

  Future<void> _restore(BackupFileInfo f) async {
    final where = backupTargetFa[f.target] ?? f.target;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('بازیابی کامل دیتابیس'),
        content: Text(
          'همهٔ ${faNumber(f.count)} فایل پشتیبان «$where» (به‌روز تا ${_stamp(f.at)}) در '
          'دیتابیسِ تنظیم‌شده نوشته می‌شود؛ فایل‌هایی که پس از آن عوض شده‌اند به نسخهٔ پشتیبان '
          'برمی‌گردند و فایل‌هایی که در پشتیبان نیستند دست نمی‌خورند.\n\n'
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
    final r = await e.restore(f.target);
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

  Future<void> _delete(String target) async {
    final where = backupTargetFa[target] ?? target;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('حذف پشتیبان «$where»'),
        content: Text(
          'فایل پشتیبان روی «$where» پاک می‌شود و برنمی‌گردد. '
          '${e.autoOn ? 'چون پشتیبان خودکار روشن است، در دور بعد (حداکثر ۱۵ دقیقه) از نو ساخته می‌شود؛ برای جلوگیری، اول پشتیبان خودکار را خاموش کنید.' : 'پشتیبان خودکار خاموش است؛ تا «پشتیبان‌گیری اکنون» را نزنید ساخته نمی‌شود.'}',
        ),
        actions: [
          TextButton(
            key: const Key('backup-delete-cancel'),
            onPressed: () => Navigator.pop(c, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: const Key('backup-delete-confirm'),
            style: FilledButton.styleFrom(
              backgroundColor: context.tokens.danger,
            ),
            onPressed: () => Navigator.pop(c, true),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final err = await e.deleteBackup(target);
    _flash(err == null, err ?? 'پشتیبان «$where» حذف شد.');
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
                  'به‌روزرسانی‌ها) در یک فایل پشتیبان جامع نگه داشته می‌شود؛ هر ۱۵ دقیقه بررسی '
                  'و فقط تغییرها در همان فایل ادغام می‌شود. جدا از پشتیبان روزانهٔ هر مدرسه در '
                  'پنل مدیر است.',
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
            title: 'فایل پشتیبان، بازیابی و حذف',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (e.files.isEmpty && e.fileErrors.isEmpty)
                  const Text(
                    'هنوز پشتیبانی ساخته نشده است.',
                    key: Key('backup-empty'),
                  ),
                for (final f in e.files)
                  ListTile(
                    key: Key('backup-file-${f.target}'),
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      f.target == 'db'
                          ? Icons.cloud_done_outlined
                          : Icons.inventory_2_outlined,
                    ),
                    title: Text(
                      'پشتیبان جامع روی ${backupTargetFa[f.target] ?? f.target}',
                    ),
                    subtitle: Text(
                      backupFileFa(f),
                      key: Key('backup-file-text-${f.target}'),
                    ),
                    trailing: Wrap(
                      spacing: 6,
                      children: [
                        OutlinedButton(
                          key: Key('backup-restore-${f.target}'),
                          onPressed: e.running
                              ? null
                              : () => unawaited(_restore(f)),
                          child: const Text('بازیابی'),
                        ),
                        OutlinedButton(
                          key: Key('backup-delete-${f.target}'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: tk.danger,
                          ),
                          onPressed: e.running
                              ? null
                              : () => unawaited(_delete(f.target)),
                          child: const Text('حذف'),
                        ),
                      ],
                    ),
                  ),
                for (final x in e.fileErrors.entries)
                  ListTile(
                    key: Key('backup-file-error-${x.key}'),
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(Icons.error_outline, color: tk.danger),
                    title: Text(
                      'پشتیبان روی ${backupTargetFa[x.key] ?? x.key}',
                    ),
                    subtitle: Text(x.value, style: TextStyle(color: tk.danger)),
                    trailing: OutlinedButton(
                      key: Key('backup-delete-${x.key}'),
                      onPressed: e.running
                          ? null
                          : () => unawaited(_delete(x.key)),
                      child: const Text('حذف'),
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
