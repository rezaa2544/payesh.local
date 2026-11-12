import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../sync_badge.dart';
import 'grades_controller.dart';

/// Tone per review state — the label text is always shown (colour is never the only signal).
PayeshTone gradeTone(GradeState s) => switch (s) {
  GradeState.approved => PayeshTone.success,
  GradeState.pending => PayeshTone.warning,
  GradeState.fresh => PayeshTone.neutral,
};

/// Native grade page (row 74, wave 3): the user's classes, then one sheet per (subject, term)
/// with a score field and the review state («تأییدشده / در انتظار / جدید») per student and a
/// single save. Works offline: saving writes to the device; the badge shows what is queued.
class GradesScreen extends StatefulWidget {
  const GradesScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final GradesController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<GradesScreen> createState() => _GradesScreenState();
}

class _GradesScreenState extends State<GradesScreen> {
  GradesController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<bool> _confirmDiscard() async {
    if (c.changes == 0) return true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('نمره‌های ذخیره نشده'),
        content: const Text(
          'نمره‌های این برگه هنوز ذخیره نشده است. بدون ذخیره ادامه می‌دهید؟',
        ),
        actions: [
          TextButton(
            key: const Key('grd-discard-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('ماندن'),
          ),
          FilledButton(
            key: const Key('grd-discard-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('ادامه بدون ذخیره'),
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
                key: const Key('grd-back'),
                tooltip: 'بازگشت',
                icon: const BackButtonIcon(),
                onPressed: _back,
              ),
              title: Text(open == null ? 'ثبت نمره' : open.name),
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
            key: const Key('grd-error'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ),
      if (c.notice != null)
        Padding(
          padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
          child: Semantics(
            liveRegion: true,
            child: Text(faDigits(c.notice!), key: const Key('grd-notice')),
          ),
        ),
    ],
  );

  Widget _classList(BuildContext context) {
    if (c.loading && c.classes.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(key: Key('grd-loading')),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        _messages(),
        if (c.error == null && c.classes.isEmpty)
          const Text(
            'کلاسی به شما تخصیص نیافته است.',
            key: Key('grd-no-classes'),
          ),
        for (final k in c.classes)
          Card(
            child: ListTile(
              key: Key('grd-class-${k.id}'),
              title: Text(k.name),
              trailing: const Icon(Icons.chevron_left),
              onTap: c.busy ? null : () => c.openClass(k),
            ),
          ),
      ],
    );
  }

  Future<void> _pick(Future<void> Function() change) async {
    if (await _confirmDiscard()) await change();
  }

  Widget _pickers(BuildContext context) {
    final s = c.subject;
    return Wrap(
      spacing: PayeshTokens.space3,
      runSpacing: PayeshTokens.space2,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        DropdownMenu<int>(
          key: const Key('grd-subject'),
          label: const Text('درس'),
          initialSelection: s?.id,
          enabled: !c.busy && c.subjects.isNotEmpty,
          dropdownMenuEntries: [
            for (final x in c.subjects)
              DropdownMenuEntry(value: x.id, label: x.name),
          ],
          onSelected: (id) {
            if (id == null || id == s?.id) return;
            final next = c.subjects.firstWhere((x) => x.id == id);
            _pick(() => c.chooseSubject(next));
          },
        ),
        DropdownMenu<GradeTerm>(
          key: const Key('grd-term'),
          label: const Text('نوبت'),
          initialSelection: c.term,
          enabled: !c.busy,
          dropdownMenuEntries: [
            for (final t in GradeTerm.values)
              DropdownMenuEntry(value: t, label: t.wire),
          ],
          onSelected: (t) {
            if (t == null || t == c.term) return;
            _pick(() => c.chooseTerm(t));
          },
        ),
      ],
    );
  }

  Widget _sheet(BuildContext context) {
    final s = c.subject;
    return ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        _pickers(context),
        const SizedBox(height: PayeshTokens.space3),
        if (s != null)
          Text(
            s.workshop ? 'درس کارگاهی — نمرهٔ عملی' : 'نمره از ۲۰',
            key: const Key('grd-scale'),
          ),
        const SizedBox(height: PayeshTokens.space3),
        _messages(),
        if (s == null)
          const Text('درسی تعریف نشده است', key: Key('grd-no-subjects'))
        else if (c.sheet.isEmpty)
          const Text('دانش‌آموزی در این کلاس نیست.', key: Key('grd-empty')),
        if (s != null)
          for (final e in c.sheet)
            _GradeRow(key: ValueKey('grd-row-${e.studentId}'), c: c, e: e),
      ],
    );
  }

  Widget _saveBar(BuildContext context) {
    final n = c.changes;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: FilledButton.icon(
          key: const Key('grd-save'),
          onPressed: c.busy || c.subject == null ? null : c.save,
          icon: const Icon(Icons.save_outlined),
          label: Text(
            n == 0 ? 'ثبت نمرات' : 'ثبت نمرات (${faDigits(n)} تغییر)',
          ),
        ),
      ),
    );
  }
}

class _GradeRow extends StatefulWidget {
  const _GradeRow({super.key, required this.c, required this.e});

  final GradesController c;
  final GradeEntry e;

  @override
  State<_GradeRow> createState() => _GradeRowState();
}

class _GradeRowState extends State<_GradeRow> {
  late final TextEditingController text = TextEditingController(
    text: widget.c.valueOf(widget.e),
  );

  @override
  void didUpdateWidget(_GradeRow old) {
    super.didUpdateWidget(old);
    final v = widget.c.valueOf(widget.e);
    // after a save / pull / sheet change the stored value replaces the field text
    if (!widget.c.draft.containsKey(widget.e.studentId) && text.text != v) {
      text.text = v;
    }
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.e;
    final bad = widget.c.invalid == e.studentId;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(e.name, style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: PayeshTokens.space1),
                  StatusBadge(
                    e.state.labelFa,
                    key: Key('grd-state-${e.studentId}'),
                    tone: gradeTone(e.state),
                  ),
                ],
              ),
            ),
            SizedBox(
              width: 96,
              child: Directionality(
                textDirection: TextDirection.ltr,
                child: TextField(
                  key: Key('grd-${e.studentId}'),
                  controller: text,
                  enabled: !widget.c.busy,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  textAlign: TextAlign.center,
                  decoration: InputDecoration(
                    hintText: '—',
                    labelText: 'نمره',
                    errorText: bad ? 'نامعتبر' : null,
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (v) => widget.c.edit(e.studentId, v),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Entry on the signed-in home: shown only when the build ships the grades wave, the user may
/// enter grades and the device knows who the user is. Otherwise a short line says where grades
/// live (the old web client) — never a dead button.
class GradesEntry extends StatelessWidget {
  const GradesEntry({
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
    if (role == null || !GradeBook.writers.contains(role)) {
      return const SizedBox.shrink(key: Key('grd-entry-none'));
    }
    if (!enabled) {
      return const Text(
        'ثبت نمره فعلاً در نسخهٔ وب انجام می‌شود.',
        key: Key('grd-entry-legacy'),
      );
    }
    if (uid == null) {
      return const Text(
        'برای ثبت نمره یک بار به اینترنت وصل شوید.',
        key: Key('grd-entry-wait'),
      );
    }
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: FilledButton.tonalIcon(
        key: const Key('grd-entry'),
        onPressed: open,
        icon: const Icon(Icons.edit_note),
        label: const Text('ثبت نمره'),
      ),
    );
  }
}

/// Route that owns the page controller for one visit.
class GradesRoute extends StatefulWidget {
  const GradesRoute({
    super.key,
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    this.onRetry,
  });

  final GradeSource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<GradesRoute> createState() => _GradesRouteState();
}

class _GradesRouteState extends State<GradesRoute> {
  late final GradesController controller = GradesController(
    source: widget.source,
    role: widget.role,
    uid: widget.uid,
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => GradesScreen(
    controller: controller,
    sync: widget.sync,
    onRetry: widget.onRetry,
  );
}
