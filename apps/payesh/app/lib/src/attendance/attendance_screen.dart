import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../sync_badge.dart';
import 'attendance_controller.dart';

/// Tone + icon per status — colour is never the only signal (label text is always shown).
(PayeshTone, IconData) attendanceLook(AttendanceStatus s) => switch (s) {
  AttendanceStatus.present => (PayeshTone.success, Icons.check_circle_outline),
  AttendanceStatus.absent => (PayeshTone.danger, Icons.cancel_outlined),
  AttendanceStatus.late => (PayeshTone.warning, Icons.schedule),
  AttendanceStatus.earlyExit => (PayeshTone.warning, Icons.logout),
  AttendanceStatus.excused => (
    PayeshTone.info,
    Icons.assignment_turned_in_outlined,
  ),
};

/// Native attendance page (row 74, wave 2): the teacher's classes with «ثبت شده / ثبت نشده»,
/// then the roster with one status chip group per student and a single save. Works offline:
/// saving writes to the device and the always-visible badge shows what is still queued.
class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final AttendanceController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  AttendanceController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<bool> _confirmDiscard() async {
    if (c.changes == 0 || c.draft.isEmpty) return true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تغییرات ذخیره نشده'),
        content: const Text(
          'تغییرات این کلاس هنوز ذخیره نشده است. بدون ذخیره برمی‌گردید؟',
        ),
        actions: [
          TextButton(
            key: const Key('att-discard-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('ماندن'),
          ),
          FilledButton(
            key: const Key('att-discard-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('برگشت بدون ذخیره'),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _back() async {
    if (c.open == null) {
      Navigator.maybePop(context);
      return;
    }
    if (await _confirmDiscard()) c.closeClass();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final open = c.open;
        return PopScope(
          canPop: open == null,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _back();
          },
          child: Scaffold(
            appBar: AppBar(
              leading: IconButton(
                key: const Key('att-back'),
                tooltip: 'بازگشت',
                icon: const BackButtonIcon(),
                onPressed: _back,
              ),
              title: Text(open == null ? 'حضور و غیاب' : open.name),
              actions: [
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    end: PayeshTokens.space2,
                  ),
                  child: Center(
                    child: SyncBadge(
                      status: widget.sync,
                      onRetry: widget.onRetry,
                    ),
                  ),
                ),
              ],
            ),
            body: open == null ? _classList(context) : _sheet(context),
            bottomNavigationBar: open == null ? null : _saveBar(context),
          ),
        );
      },
    );
  }

  Widget _messages() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (c.error != null)
        Padding(
          padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
          child: Text(
            c.error!,
            key: const Key('att-error'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ),
      if (c.notice != null)
        Padding(
          padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
          child: Semantics(
            liveRegion: true,
            child: Text(faDigits(c.notice!), key: const Key('att-notice')),
          ),
        ),
    ],
  );

  Widget _classList(BuildContext context) {
    if (c.loading && c.classes.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(key: Key('att-loading')),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        Row(
          children: [
            const Text('امروز: '),
            JalaliDateText(c.date, key: const Key('att-date')),
          ],
        ),
        const SizedBox(height: PayeshTokens.space3),
        _messages(),
        if (c.error == null && c.classes.isEmpty)
          const Text(
            'کلاسی برای شما ثبت نشده است. پس از همگام‌سازی برنامهٔ هفتگی دوباره ببینید.',
            key: Key('att-no-classes'),
          ),
        for (final k in c.classes)
          Card(
            child: ListTile(
              key: Key('att-class-${k.id}'),
              title: Text(k.name),
              trailing: c.recorded[k.id] == true
                  ? const StatusBadge(
                      'ثبت شده',
                      tone: PayeshTone.success,
                      icon: Icons.check,
                    )
                  : const StatusBadge('ثبت نشده', tone: PayeshTone.warning),
              onTap: c.busy ? null : () => c.openClass(k),
            ),
          ),
      ],
    );
  }

  Widget _sheet(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        _messages(),
        if (c.roster.isEmpty)
          const Text(
            'دانش‌آموزی در این کلاس ثبت نشده است',
            key: Key('att-empty'),
          ),
        for (final r in c.roster) _StudentRow(controller: c, entry: r),
      ],
    );
  }

  Widget _saveBar(BuildContext context) {
    final n = c.changes;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: FilledButton.icon(
          key: const Key('att-save'),
          onPressed: c.busy ? null : c.save,
          icon: const Icon(Icons.save_outlined),
          label: Text(n == 0 ? 'ذخیره' : 'ذخیره (${faDigits(n)} تغییر)'),
        ),
      ),
    );
  }
}

class _StudentRow extends StatelessWidget {
  const _StudentRow({required this.controller, required this.entry});

  final AttendanceController controller;
  final RosterEntry entry;

  @override
  Widget build(BuildContext context) {
    final current = controller.statusOf(entry);
    final changed = current != entry.recorded;
    return Card(
      key: Key('att-row-${entry.studentId}'),
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    entry.name,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                if (entry.recorded == null)
                  const Text('ثبت نشده', key: Key('att-row-new'))
                else if (changed)
                  const Text('تغییر ذخیره نشده'),
              ],
            ),
            const SizedBox(height: PayeshTokens.space2),
            Wrap(
              spacing: PayeshTokens.space2,
              runSpacing: PayeshTokens.space2,
              children: [
                for (final s in AttendanceStatus.values)
                  Semantics(
                    inMutuallyExclusiveGroup: true,
                    child: ChoiceChip(
                      key: Key('att-${entry.studentId}-${s.wire}'),
                      avatar: Icon(attendanceLook(s).$2, size: 18),
                      label: Text(s.labelFa),
                      selected: current == s,
                      tooltip: '${entry.name}: ${s.labelFa}',
                      onSelected: controller.busy
                          ? null
                          : (_) => controller.mark(entry.studentId, s),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Entry on the signed-in home: shown only when the build ships the attendance wave, the user
/// may take attendance and the device knows who the user is. Otherwise a short line says
/// where attendance lives (the old web client) — never a dead button.
class AttendanceEntry extends StatelessWidget {
  const AttendanceEntry({
    super.key,
    required this.enabled,
    required this.role,
    required this.uid,
    required this.open,
  });

  final bool enabled;
  final String? role;
  final int? uid;
  final VoidCallback open;

  @override
  Widget build(BuildContext context) {
    if (role == null || !AttendanceBook.writers.contains(role)) {
      return const SizedBox.shrink(key: Key('att-entry-none'));
    }
    if (!enabled) {
      return const Text(
        'ثبت حضور و غیاب فعلاً در نسخهٔ وب انجام می‌شود.',
        key: Key('att-entry-legacy'),
      );
    }
    if (uid == null) {
      return const Text(
        'برای حضور و غیاب یک بار به اینترنت وصل شوید.',
        key: Key('att-entry-wait'),
      );
    }
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: FilledButton.tonalIcon(
        key: const Key('att-entry'),
        onPressed: open,
        icon: const Icon(Icons.fact_check_outlined),
        label: const Text('حضور و غیاب'),
      ),
    );
  }
}

/// Route that owns the page controller for one visit.
class AttendanceRoute extends StatefulWidget {
  const AttendanceRoute({
    super.key,
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    this.onRetry,
    this.now,
  });

  final AttendanceSource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
  final DateTime Function()? now;

  @override
  State<AttendanceRoute> createState() => _AttendanceRouteState();
}

class _AttendanceRouteState extends State<AttendanceRoute> {
  late final AttendanceController controller = AttendanceController(
    source: widget.source,
    role: widget.role,
    uid: widget.uid,
    now: widget.now,
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AttendanceScreen(
    controller: controller,
    sync: widget.sync,
    onRetry: widget.onRetry,
  );
}
