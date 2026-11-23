import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/pulse.dart';
import '../pulse/web.dart';
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

  // the three selects of the web card; applied by «نمایش» (web `grade-reload`)
  int? _selClass;
  int? _selSubject;
  GradeTerm? _selTerm;

  Future<void> _show() async {
    final k = c.classes.where((x) => x.id == (_selClass ?? c.open?.id));
    if (k.isEmpty) return;
    final sid = _selSubject ?? c.subject?.id;
    final sub = c.subjects.where((x) => x.id == sid);
    if (!await _confirmDiscard()) return;
    await c.show(k.first, sub.isEmpty ? null : sub.first, _selTerm ?? c.term);
    if (mounted) {
      setState(() {
        _selClass = null;
        _selSubject = null;
        _selTerm = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final inline = PulseInline.of(context);
        final content = WebPageBody(children: _page());
        return Scaffold(
          backgroundColor: inline ? Colors.transparent : Web.bg,
          appBar: inline
              ? null
              : AppBar(
                  leading: IconButton(
                    key: const Key('grd-back'),
                    tooltip: 'بازگشت',
                    icon: const BackButtonIcon(),
                    onPressed: () async {
                      if (await _confirmDiscard() && context.mounted) {
                        Navigator.maybePop(context);
                      }
                    },
                  ),
                  title: const Text('ثبت نمره'),
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
          body: inline ? content : WebBackdrop(child: content),
        );
      },
    );
  }

  List<Widget> _messages() => [
    if (c.error != null)
      WebBanner(
        kind: WebBannerKind.err,
        text: c.error!,
        textKey: const Key('grd-error'),
      )
    else if (c.notice != null)
      Semantics(
        liveRegion: true,
        child: WebBanner(
          kind: WebBannerKind.ok,
          text: faDigits(c.notice!),
          textKey: const Key('grd-notice'),
        ),
      ),
  ];

  /// Row 172: web `PAGES.grades` (teacher / manager) exactly — no class list: pageHead
  /// «ثبت نمره» / the subject; a tight card with the selects «پایه / رشته», «درس», «نوبت» and
  /// «نمایش»; a card with the bold subject + «نمره از ۲۰» (or «درس کارگاهی — نمرهٔ عملی»),
  /// the table دانش‌آموز / نمره / وضعیت and the block «ثبت نمرات».
  List<Widget> _page() {
    if (c.loading && c.classes.isEmpty) {
      return [
        const WebPageHead(title: 'ثبت نمره'),
        const Center(
          child: Padding(
            padding: EdgeInsets.all(26),
            child: CircularProgressIndicator(key: Key('grd-loading')),
          ),
        ),
      ];
    }
    if (c.classes.isEmpty) {
      return [
        const WebPageHead(title: 'ثبت نمره'),
        ..._messages(),
        if (c.error == null)
          const WebEmpty(
            'کلاسی به شما تخصیص نیافته است.',
            key: Key('grd-no-classes'),
          ),
      ];
    }
    final s = c.subject;
    final open = c.open;
    return [
      WebPageHead(
        title: 'ثبت نمره',
        sub: s?.name ?? 'یک درس را انتخاب کنید',
        subKey: const Key('grd-subject-name'),
      ),
      ..._messages(),
      WebCard.tight(child: _selects()),
      if (open != null)
        WebCard(
          key: const Key('grd-sheet'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Expanded(child: Text(s?.name ?? '', style: Web.b)),
                    Text(
                      s?.workshop ?? false
                          ? 'درس کارگاهی — نمرهٔ عملی'
                          : 'نمره از ۲۰',
                      key: const Key('grd-scale'),
                      style: Web.small,
                    ),
                  ],
                ),
              ),
              if (s == null)
                const Text(
                  'درسی تعریف نشده است',
                  key: Key('grd-no-subjects'),
                  style: Web.small,
                )
              else if (c.sheet.isEmpty)
                const Text(
                  'دانش‌آموزی در این کلاس نیست.',
                  key: Key('grd-empty'),
                  style: Web.small,
                )
              else ...[
                WebTable(
                  head: const ['دانش‌آموز', 'نمره', 'وضعیت'],
                  widths: const {1: 110, 2: 90},
                  rows: [
                    for (final e in c.sheet)
                      [
                        Text(e.name, key: Key('grd-row-${e.studentId}')),
                        _GradeField(
                          key: ValueKey('grd-field-${e.studentId}'),
                          c: c,
                          e: e,
                        ),
                        Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: WebBadge(
                            e.state.labelFa,
                            key: Key('grd-state-${e.studentId}'),
                            tone: switch (e.state) {
                              GradeState.approved => WebTone.green,
                              GradeState.pending => WebTone.amber,
                              GradeState.fresh => WebTone.none,
                            },
                          ),
                        ),
                      ],
                  ],
                ),
                const SizedBox(height: 12),
                WebBtn(
                  'ثبت نمرات',
                  key: const Key('grd-save'),
                  kind: WebBtnKind.primary,
                  size: WebBtnSize.normal,
                  block: true,
                  onPressed: c.busy ? null : c.save,
                ),
              ],
            ],
          ),
        ),
    ];
  }

  /// `<div class="row">` of three `label.field.grow` selects + «نمایش» at the bottom.
  Widget _selects() {
    Widget select<T>(
      String key,
      String label,
      T? value,
      List<(T, String)> items,
      ValueChanged<T?> onChanged,
    ) => Expanded(
      child: WebField(
        label: label,
        bottom: 0,
        child: DropdownButtonFormField<T>(
          key: Key(key),
          initialValue: items.any((i) => i.$1 == value) ? value : null,
          isExpanded: true,
          isDense: true,
          style: const TextStyle(
            fontSize: 15,
            color: Web.ink,
            fontFamily: 'Vazirmatn',
          ),
          decoration: webInput(),
          items: [
            for (final (v, l) in items)
              DropdownMenuItem<T>(value: v, child: Text(l)),
          ],
          onChanged: c.busy ? null : onChanged,
        ),
      ),
    );
    const gap = SizedBox(width: 9.6);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        select<int>('grd-class', 'پایه / رشته', _selClass ?? c.open?.id, [
          for (final k in c.classes) (k.id, k.name),
        ], (v) => setState(() => _selClass = v)),
        gap,
        select<int>('grd-subject', 'درس', _selSubject ?? c.subject?.id, [
          for (final x in c.subjects) (x.id, x.name),
        ], (v) => setState(() => _selSubject = v)),
        gap,
        select<GradeTerm>('grd-term', 'نوبت', _selTerm ?? c.term, [
          for (final t in GradeTerm.values) (t, t.wire),
        ], (v) => setState(() => _selTerm = v)),
        gap,
        WebBtn(
          'نمایش',
          key: const Key('grd-show'),
          onPressed: c.busy ? null : _show,
        ),
      ],
    );
  }
}

/// `<input class="input ltr" style="padding:.3rem" inputmode="decimal" placeholder="—">`.
class _GradeField extends StatefulWidget {
  const _GradeField({super.key, required this.c, required this.e});

  final GradesController c;
  final GradeEntry e;

  @override
  State<_GradeField> createState() => _GradeFieldState();
}

class _GradeFieldState extends State<_GradeField> {
  late final TextEditingController text = TextEditingController(
    text: widget.c.valueOf(widget.e),
  );

  @override
  void didUpdateWidget(_GradeField old) {
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
    final d = webInput(error: bad ? '' : null);
    // the web input has no visible label; screen readers hear «نمره» (+ «نامعتبر»)
    return Semantics(
      label: bad ? 'نمره، نامعتبر' : 'نمره',
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: TextField(
          key: Key('grd-${e.studentId}'),
          controller: text,
          enabled: !widget.c.busy,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          style: const TextStyle(fontSize: 15, color: Web.ink),
          decoration: d.copyWith(
            hintText: '—',
            errorText: null,
            // padding .3rem inside the 44px `.input` min-height
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 4.8,
              vertical: 11.5,
            ),
          ),
          onChanged: (v) => widget.c.edit(e.studentId, v),
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
    return PayeshTile(
      key: const Key('grd-entry'),
      onTap: open,
      icon: Icons.edit_note,
      label: 'ثبت نمره',
      tone: PayeshTone.success,
    );
  }

  /// Row 165: true when this entry is a home tile (else a short note or nothing).
  bool get isTile =>
      role != null &&
      GradeBook.writers.contains(role) &&
      enabled &&
      uid != null;
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
