import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../sync_badge.dart';
import 'family_controller.dart';

/// Average badge — web `avg >= 15 ? green : avg >= 10 ? amber : red`; no grade → neutral «—».
PayeshTone averageTone(double? avg) => switch (avg) {
  null => PayeshTone.neutral,
  final a when a >= 15 => PayeshTone.success,
  final a when a >= 10 => PayeshTone.warning,
  _ => PayeshTone.danger,
};

/// Attendance badge — web `pct >= 90 ? green : amber`; no record → neutral «—».
PayeshTone attendanceTone(int? pct) => switch (pct) {
  null => PayeshTone.neutral,
  final p when p >= 90 => PayeshTone.success,
  _ => PayeshTone.warning,
};

/// One attendance record — web `present ? green : absent ? red : amber`.
PayeshTone attendanceStatusTone(AttendanceStatus? s) => switch (s) {
  AttendanceStatus.present => PayeshTone.success,
  AttendanceStatus.absent => PayeshTone.danger,
  _ => PayeshTone.warning,
};

/// Leave request — web `approved ? green : rejected ? red : amber`.
PayeshTone leaveTone(LeaveState s) => switch (s) {
  LeaveState.approved => PayeshTone.success,
  LeaveState.rejected => PayeshTone.danger,
  LeaveState.pending => PayeshTone.warning,
};

String averageLabel(double? avg) =>
    'معدل ${avg == null ? '—' : faDigits(avg.toStringAsFixed(1))}';

String attendanceLabel(int? pct) =>
    'حضور ${pct == null ? '—' : '${faDigits(pct)}٪'}';

String _score(num n) => faDigits(n % 1 == 0 ? n.toInt() : n);

Widget _error(BuildContext context, String text, String key) => Padding(
  padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
  child: Text(
    text,
    key: Key(key),
    style: TextStyle(color: Theme.of(context).colorScheme.error),
  ),
);

AppBar _bar(
  BuildContext context,
  String title,
  String backKey,
  ValueListenable<SyncStatus> sync,
  VoidCallback? onRetry,
) => AppBar(
  leading: IconButton(
    key: Key(backKey),
    tooltip: 'بازگشت',
    icon: const BackButtonIcon(),
    onPressed: () => Navigator.maybePop(context),
  ),
  title: Text(title),
  actions: [
    Padding(
      padding: const EdgeInsetsDirectional.only(end: PayeshTokens.space2),
      child: Center(
        child: SyncBadge(status: sync, onRetry: onRetry),
      ),
    ),
  ],
);

/// Native parents home (row 74, wave 5) — web `parentHome`: one card per linked child with
/// the class, the average of the approved grades and the attendance share; a tap opens the
/// child page. Works offline on the pulled copy; the badge shows the sync state.
class FamilyScreen extends StatefulWidget {
  const FamilyScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final FamilyController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends State<FamilyScreen> {
  FamilyController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _openChild(ChildSummary k) async {
    unawaited(c.openChild(k.id));
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChildScreen(
          controller: c,
          sync: widget.sync,
          onRetry: widget.onRetry,
        ),
      ),
    );
    c.closeChild();
  }

  Future<void> _openLeaves() => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => LeavesScreen(
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => Scaffold(
        appBar: _bar(
          context,
          'فرزندان من',
          'fam-back',
          widget.sync,
          widget.onRetry,
        ),
        body: c.loading && c.children.isEmpty && c.error == null
            ? const Center(
                child: CircularProgressIndicator(key: Key('fam-loading')),
              )
            : ListView(
                padding: const EdgeInsets.all(PayeshTokens.space4),
                children: [
                  if (c.error != null) _error(context, c.error!, 'fam-error'),
                  if (c.error == null) ...[
                    Text(
                      '${faDigits(c.children.length)} فرزند',
                      key: const Key('fam-count'),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: PayeshTokens.space2),
                    if (c.children.isEmpty)
                      const Text(
                        'فرزندی به حساب شما متصل نیست — با دفتر مدرسه تماس بگیرید.',
                        key: Key('fam-empty'),
                      ),
                    for (final k in c.children) _card(context, k),
                    const SizedBox(height: PayeshTokens.space3),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: FilledButton.tonalIcon(
                        key: const Key('fam-leaves'),
                        onPressed: _openLeaves,
                        icon: const Icon(Icons.outgoing_mail),
                        label: const Text('درخواست مرخصی'),
                      ),
                    ),
                  ],
                ],
              ),
      ),
    );
  }

  Widget _card(BuildContext context, ChildSummary k) {
    final t = Theme.of(context).textTheme;
    return Card(
      key: Key('fam-card-${k.id}'),
      child: InkWell(
        key: Key('fam-open-${k.id}'),
        onTap: () => _openChild(k),
        child: Padding(
          padding: const EdgeInsets.all(PayeshTokens.space3),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(k.name, style: t.titleMedium),
                    if (k.className.isNotEmpty)
                      Text(
                        k.className,
                        key: Key('fam-class-${k.id}'),
                        style: t.bodySmall,
                      ),
                  ],
                ),
              ),
              Wrap(
                spacing: PayeshTokens.space2,
                runSpacing: PayeshTokens.space1,
                children: [
                  StatusBadge(
                    averageLabel(k.average),
                    key: Key('fam-avg-${k.id}'),
                    tone: averageTone(k.average),
                  ),
                  StatusBadge(
                    attendanceLabel(k.attendancePercent),
                    key: Key('fam-att-${k.id}'),
                    tone: attendanceTone(k.attendancePercent),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Child page — web `PAGES.child`: average / attendance / number of grades, every grade with
/// its review state, the latest 12 attendance records and the internships.
class ChildScreen extends StatelessWidget {
  const ChildScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final FamilyController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final r = c.child;
        return Scaffold(
          appBar: _bar(
            context,
            r?.summary.name ?? 'پرونده',
            'chd-back',
            sync,
            onRetry,
          ),
          body: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space4),
            children: [
              if (c.childError != null)
                _error(context, c.childError!, 'chd-error'),
              if (r == null && c.childError == null)
                const Center(
                  child: CircularProgressIndicator(key: Key('chd-loading')),
                ),
              if (r != null) ..._body(context, r),
            ],
          ),
        );
      },
    );
  }

  List<Widget> _body(BuildContext context, ChildRecord r) {
    final t = Theme.of(context).textTheme;
    final s = r.summary;
    return [
      if (s.className.isNotEmpty) Text(s.className, style: t.bodySmall),
      const SizedBox(height: PayeshTokens.space2),
      Wrap(
        spacing: PayeshTokens.space2,
        runSpacing: PayeshTokens.space1,
        children: [
          StatusBadge(
            averageLabel(s.average),
            key: const Key('chd-avg'),
            tone: averageTone(s.average),
          ),
          StatusBadge(
            attendanceLabel(s.attendancePercent),
            key: const Key('chd-att'),
            tone: attendanceTone(s.attendancePercent),
          ),
          StatusBadge(
            '${faDigits(r.grades.length)} نمره ثبت‌شده',
            key: const Key('chd-count'),
          ),
        ],
      ),
      const SizedBox(height: PayeshTokens.space4),
      Text('نمرات', style: t.titleMedium),
      if (r.grades.isEmpty)
        const Text('نمره‌ای ثبت نشده', key: Key('chd-grades-empty')),
      for (final g in r.grades)
        ListTile(
          key: Key('chd-grade-${g.id}'),
          contentPadding: EdgeInsets.zero,
          title: Text('${g.subject} · ${g.term}'),
          subtitle: g.practicalScore == null
              ? null
              : Text('عملی ${_score(g.practicalScore!)}'),
          leading: Text(
            _score(g.score),
            key: Key('chd-score-${g.id}'),
            style: t.titleMedium,
          ),
          trailing: StatusBadge(
            g.approved ? 'تأییدشده' : 'در انتظار',
            key: Key('chd-state-${g.id}'),
            tone: g.approved ? PayeshTone.success : PayeshTone.warning,
          ),
        ),
      const SizedBox(height: PayeshTokens.space4),
      Text('حضور و غیاب', style: t.titleMedium),
      if (r.attendance.isEmpty)
        const Text('ثبت نشده', key: Key('chd-att-empty')),
      for (final a in r.attendance)
        ListTile(
          key: Key('chd-day-${a.id}'),
          contentPadding: EdgeInsets.zero,
          title: JalaliDateText(a.date),
          trailing: StatusBadge(
            a.status?.labelFa ?? a.raw,
            key: Key('chd-day-state-${a.id}'),
            tone: attendanceStatusTone(a.status),
          ),
        ),
      if (r.internships.isNotEmpty) ...[
        const SizedBox(height: PayeshTokens.space4),
        Text('کارآموزی', style: t.titleMedium),
        for (final i in r.internships)
          ListTile(
            key: Key('chd-int-${i.id}'),
            contentPadding: EdgeInsets.zero,
            title: JalaliDateText(i.date),
            subtitle: Text(
              [
                if (i.hours != null) '${_score(i.hours!)} ساعت',
                if (i.location.isNotEmpty) i.location,
              ].join(' · '),
            ),
            trailing: StatusBadge(
              i.approved ? 'تأییدشده' : 'در انتظار',
              tone: i.approved ? PayeshTone.success : PayeshTone.warning,
            ),
          ),
      ],
    ];
  }
}

/// Leave requests of the children — web `PAGES.leaves` (parent view: no approve / reject /
/// delete) — and the «+ درخواست» button.
class LeavesScreen extends StatelessWidget {
  const LeavesScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final FamilyController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  Future<void> _openForm(BuildContext context) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LeaveForm(controller: controller),
      ),
    );
    controller.clearForm();
  }

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => Scaffold(
        appBar: _bar(context, 'مرخصی و غیبت موجه', 'lvs-back', sync, onRetry),
        floatingActionButton: FloatingActionButton.extended(
          key: const Key('lvs-add'),
          onPressed: c.busy || c.children.isEmpty
              ? null
              : () => _openForm(context),
          icon: const Icon(Icons.add),
          label: const Text('درخواست'),
        ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                PayeshTokens.space4,
                PayeshTokens.space4,
                PayeshTokens.space4,
                0,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (c.error != null) _error(context, c.error!, 'lvs-error'),
                  if (c.notice != null)
                    Padding(
                      padding: const EdgeInsets.only(
                        bottom: PayeshTokens.space3,
                      ),
                      child: Semantics(
                        liveRegion: true,
                        child: Text(c.notice!, key: const Key('lvs-notice')),
                      ),
                    ),
                  if (c.error == null)
                    Text(
                      '${faDigits(c.leaves.length)} درخواست',
                      key: const Key('lvs-count'),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                  PayeshTokens.space4,
                  PayeshTokens.space2,
                  PayeshTokens.space4,
                  96, // room above the add button
                ),
                children: [
                  if (c.error == null && c.leaves.isEmpty)
                    const Text('درخواستی ثبت نشده.', key: Key('lvs-empty')),
                  for (final l in c.leaves) _card(context, l),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card(BuildContext context, LeaveRequest l) => Card(
    key: Key('lvs-card-${l.id}'),
    child: Padding(
      padding: const EdgeInsets.all(PayeshTokens.space3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  l.studentName,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              StatusBadge(
                l.state.labelFa,
                key: Key('lvs-state-${l.id}'),
                tone: leaveTone(l.state),
              ),
            ],
          ),
          const SizedBox(height: PayeshTokens.space1),
          Row(
            children: [
              JalaliDateText(l.date, key: Key('lvs-date-${l.id}')),
              if (l.reason.isNotEmpty)
                Expanded(
                  child: Text(
                    ' · ${l.reason}',
                    key: Key('lvs-reason-${l.id}'),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
          ),
          if (l.queued) ...[
            const SizedBox(height: PayeshTokens.space1),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: StatusBadge(
                'در صف ارسال',
                key: Key('lvs-queued-${l.id}'),
                tone: PayeshTone.warning,
                icon: Icons.schedule,
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

/// Request form — web modal «درخواست مرخصی»: child, Jalali day (default today), optional
/// reason. Stays open with the typed values when refused; leaving with typed text asks first.
class LeaveForm extends StatefulWidget {
  const LeaveForm({super.key, required this.controller});

  final FamilyController controller;

  @override
  State<LeaveForm> createState() => _LeaveFormState();
}

class _LeaveFormState extends State<LeaveForm> {
  FamilyController get c => widget.controller;
  late int? _student = c.children.isEmpty ? null : c.children.first.id;
  late final TextEditingController _day = TextEditingController(
    text: c.todayJalali,
  );
  final TextEditingController _reason = TextEditingController();

  bool get _dirty => _reason.text.trim().isNotEmpty;

  @override
  void dispose() {
    _day.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final res = await c.requestLeave(
      studentId: _student,
      jalaliDay: _day.text,
      reason: _reason.text,
    );
    if (res != null && mounted) Navigator.of(context).pop();
  }

  Future<void> _leave() async {
    if (!_dirty) {
      Navigator.of(context).pop();
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('درخواست ارسال نشده'),
        content: const Text('متن نوشته‌شده ذخیره نمی‌شود. خارج می‌شوید؟'),
        actions: [
          TextButton(
            key: const Key('lvf-discard-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('ماندن'),
          ),
          FilledButton(
            key: const Key('lvf-discard-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('خروج'),
          ),
        ],
      ),
    );
    if (ok == true && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _leave();
        },
        child: Scaffold(
          appBar: AppBar(
            leading: IconButton(
              key: const Key('lvf-back'),
              tooltip: 'بازگشت',
              icon: const BackButtonIcon(),
              onPressed: _leave,
            ),
            title: const Text('درخواست مرخصی'),
          ),
          body: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space4),
            children: [
              if (c.formError != null)
                _error(context, c.formError!, 'lvf-error'),
              DropdownButtonFormField<int>(
                key: const Key('lvf-student'),
                initialValue: _student,
                decoration: const InputDecoration(labelText: 'دانش‌آموز'),
                items: [
                  for (final k in c.children)
                    DropdownMenuItem(value: k.id, child: Text(k.name)),
                ],
                onChanged: (v) => setState(() => _student = v),
              ),
              const SizedBox(height: PayeshTokens.space3),
              TextField(
                key: const Key('lvf-date'),
                controller: _day,
                keyboardType: TextInputType.datetime,
                decoration: const InputDecoration(
                  labelText: 'تاریخ شمسی',
                  hintText: '۱۴۰۵/۰۸/۲۱',
                ),
              ),
              const SizedBox(height: PayeshTokens.space3),
              TextField(
                key: const Key('lvf-reason'),
                controller: _reason,
                minLines: 2,
                maxLines: 5,
                decoration: const InputDecoration(
                  labelText: 'علت',
                  hintText: 'مثلاً مراجعه به پزشک',
                ),
              ),
              const SizedBox(height: PayeshTokens.space4),
              FilledButton.icon(
                key: const Key('lvf-submit'),
                onPressed: c.busy ? null : _submit,
                icon: const Icon(Icons.send_outlined),
                label: const Text('ثبت درخواست'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Entry on the signed-in home: shown to a parent when the build ships the parents wave and the
/// device knows who the user is. Otherwise a short line says where the page lives (the old web
/// client) — never a dead button. Other roles see nothing.
class FamilyEntry extends StatelessWidget {
  const FamilyEntry({
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
    if (role != 'parent') {
      return const SizedBox.shrink(key: Key('fam-entry-none'));
    }
    if (!enabled) {
      return const Text(
        'صفحهٔ فرزندان فعلاً در نسخهٔ وب نمایش داده می‌شود.',
        key: Key('fam-entry-legacy'),
      );
    }
    if (uid == null) {
      return const Text(
        'برای دیدن فرزندان یک بار به اینترنت وصل شوید.',
        key: Key('fam-entry-wait'),
      );
    }
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: FilledButton.tonalIcon(
        key: const Key('fam-entry'),
        onPressed: open,
        icon: const Icon(Icons.family_restroom),
        label: const Text('فرزندان من'),
      ),
    );
  }
}

/// Route that owns the page controller for one visit.
class FamilyRoute extends StatefulWidget {
  const FamilyRoute({
    super.key,
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    this.onRetry,
  });

  final FamilySource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<FamilyRoute> createState() => _FamilyRouteState();
}

class _FamilyRouteState extends State<FamilyRoute> {
  late final FamilyController c = FamilyController(
    source: widget.source,
    role: widget.role,
    uid: widget.uid,
  );

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      FamilyScreen(controller: c, sync: widget.sync, onRetry: widget.onRetry);
}
