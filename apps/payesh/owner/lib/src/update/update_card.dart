import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../helper/helper_card.dart' show fmtBytesFa;
import '../local/settings_page.dart';
import 'update_service.dart';

/// «به‌روزرسانی برنامه»: فقط فایل‌های تغییرکرده دانلود می‌شوند (مثل پنل کاربران).
class UpdateCard extends StatefulWidget {
  const UpdateCard({super.key, required this.updater});
  final OwnerUpdater updater;

  @override
  State<UpdateCard> createState() => _UpdateCardState();
}

class _UpdateCardState extends State<UpdateCard> {
  StreamSubscription<void>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.updater.changes.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.updater;
    final tk = context.tokens;
    final p = u.plan;
    final last = u.lastApply;
    String? text;
    var ok = true;
    switch (u.phase) {
      case UpdatePhase.idle:
        text = null;
      case UpdatePhase.checking:
        text = 'در حال بررسی…';
      case UpdatePhase.upToDate:
        text = 'برنامه به‌روز است (ساخت ${p?.manifest.build ?? ownerBuild}).';
      case UpdatePhase.ready:
        if (!u.isWindows) {
          final apk = p?.manifest.apk;
          text =
              'ساخت ${p!.manifest.build} آماده است. در اندروید بستهٔ کامل'
              '${apk == null ? '' : ' (${fmtBytesFa(apk.size)})'} درون برنامه دریافت و نصب می‌شود.';
        } else {
          text =
              'ساخت ${p!.manifest.build} آماده است: ${p.changed.length} فایل تغییر کرده — '
              'دانلود ${fmtBytesFa(p.downloadBytes)} به‌جای ${fmtBytesFa(p.totalBytes)}.';
        }
      case UpdatePhase.downloading:
        text =
            'در حال دریافت… ${fmtBytesFa(u.progressDone)} از ${fmtBytesFa(u.progressTotal)}';
      case UpdatePhase.staged:
        final s = u.staged!;
        text =
            'همهٔ ${s.plan.changed.length} فایل دریافت و بررسی شد'
            '${s.fromMirror > 0 ? ' (${s.fromMirror} فایل از آینهٔ دیتابیس آروان)' : ''}. '
            'برای نصب، برنامه بسته و دوباره باز می‌شود.';
      case UpdatePhase.applying:
        text = u.isWindows
            ? 'در حال نصب… برنامه بسته و پس از جایگزینی فایل‌ها خودکار دوباره باز می‌شود.'
            : 'نصب‌کنندهٔ اندروید باز شد؛ پس از نصب، برنامه دوباره باز می‌شود.';
      case UpdatePhase.failed:
        text = u.error;
        ok = false;
    }
    return SettingsSection(
      title: 'به‌روزرسانی برنامه',
      subtitle:
          'فقط بخش‌های تغییرکرده دانلود می‌شوند، نه کل برنامه. هش هر فایل بررسی می‌شود و '
          'نسخهٔ قبلی نگه داشته می‌شود تا اگر نسخهٔ تازه بالا نیامد، خودکار برگردد.'
          '${ownerBuild > 0 ? ' نسخهٔ نصب‌شده: ساخت $ownerBuild.' : ''}',
      children: [
        if (last != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              last.ok
                  ? 'به‌روزرسانی به ساخت ${last.build} انجام شد.'
                  : last.rolledBack
                  ? 'به‌روزرسانی به ساخت ${last.build} انجام نشد و نسخهٔ قبلی برگردانده شد (${last.message}).'
                  : 'به‌روزرسانی انجام نشد (${last.message}).',
              key: const Key('upd-last'),
              style: TextStyle(color: last.ok ? tk.success : tk.danger),
            ),
          ),
        if (text != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              text,
              key: const Key('upd-status'),
              style: TextStyle(color: ok ? tk.success : tk.danger),
            ),
          ),
        if (u.phase == UpdatePhase.downloading ||
            u.phase == UpdatePhase.applying)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: LinearProgressIndicator(
              value: u.phase == UpdatePhase.applying ? null : u.progress,
            ),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton(
              key: const Key('upd-check'),
              onPressed: u.busy ? null : u.check,
              child: const Text('بررسی به‌روزرسانی'),
            ),
            if (u.phase == UpdatePhase.ready ||
                (u.phase == UpdatePhase.failed && u.available))
              FilledButton(
                key: const Key('upd-download'),
                onPressed: u.tap,
                child: Text(
                  u.isWindows
                      ? 'دریافت، نصب و باز کردن دوباره'
                      : 'دریافت و نصب',
                ),
              ),
            if (u.phase == UpdatePhase.staged)
              FilledButton(
                key: const Key('upd-apply'),
                onPressed: u.applyAndRestart,
                child: const Text('نصب و راه‌اندازی دوباره'),
              ),
          ],
        ),
      ],
    );
  }
}
