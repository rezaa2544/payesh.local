import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/pulse.dart';
import '../pulse/d2.dart';
import '../pulse/web.dart';
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

  /// Web «بازگشت» is a link to `#/home`; the web keeps the draft in memory, the native page
  /// does not, so unsaved marks are confirmed first.
  Future<void> _back() async {
    if (c.open == null) {
      if (!PulseInline.go(context, 'home')) Navigator.maybePop(context);
      return;
    }
    if (!await _confirmDiscard()) return;
    c.closeClass();
    // outside the shell (an old pushed route) the class list stands in for «home»
    if (mounted) PulseInline.go(context, 'home');
  }

  Future<void> _save() async {
    final r = await c.save();
    // web `actAttendanceSave`: toast «N رکورد ذخیره شد» / «تغییری نبود», then away from the
    // sheet; the native page shows the message above the class list
    if (r != null && mounted) c.closeClass();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final open = c.open;
        final inline = PulseInline.of(context);
        final content = WebPageBody(
          children: open == null ? _classList() : _sheet(open),
        );
        return PopScope(
          canPop: open == null,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _back();
          },
          child: Scaffold(
            backgroundColor: inline ? Colors.transparent : Web.bg,
            appBar: inline
                ? null
                : AppBar(
                    automaticallyImplyLeading: false,
                    title: const Text('حضور و غیاب'),
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
          ),
        );
      },
    );
  }

  List<Widget> _messages() => [
    if (c.error != null)
      WebBanner(
        kind: WebBannerKind.err,
        text: c.error!,
        textKey: const Key('att-error'),
      )
    else if (c.notice != null)
      Semantics(
        liveRegion: true,
        child: WebBanner(
          kind: WebBannerKind.ok,
          text: faDigits(c.notice!),
          textKey: const Key('att-notice'),
        ),
      ),
  ];

  /// Web `PAGES.attendance` without a class: pageHead «حضور و غیاب» / «کلاس را انتخاب کنید»,
  /// one card with a `.list` of `a.item` rows — the class name (link colour), «N دانش‌آموز ·
  /// grade», and a green «ثبت‌شده» or amber «ثبت‌نشده» badge.
  List<Widget> _classList() => [
    const WebPageHead(title: 'حضور و غیاب', sub: 'کلاس را انتخاب کنید'),
    ..._messages(),
    if (c.loading && c.classes.isEmpty)
      const Center(
        child: Padding(
          padding: EdgeInsets.all(26),
          child: CircularProgressIndicator(key: Key('att-loading')),
        ),
      )
    else if (c.error == null || c.classes.isNotEmpty)
      WebCard(
        child: c.classes.isEmpty
            ? const WebEmpty(
                'کلاسی به شما تخصیص نیافته است.',
                key: Key('att-no-classes'),
              )
            : WebList(
                children: [
                  for (final k in c.classes)
                    _ClassItem(
                      key: Key('att-class-${k.id}'),
                      item: k,
                      done: c.recorded[k.id] == true,
                      onTap: c.busy ? null : () => c.openClass(k),
                    ),
                ],
              ),
      ),
  ];

  /// Web `PAGES.attendance(classId)`: pageHead «حضور و غیاب» / «class · date» + «بازگشت»;
  /// a tight card with the four counts spread out; the card «فهرست کلاس» with «همه حاضر» /
  /// «همه غایب», one `.att-row` per student and the block «ثبت نهایی حضور».
  List<Widget> _sheet(AttendanceClass open) {
    final back = WebBtn(
      'بازگشت',
      key: const Key('att-back'),
      onPressed: c.busy ? null : _back,
    );
    if (c.roster.isEmpty) {
      return [
        WebPageHead(title: 'حضور و غیاب', sub: open.name, actions: [back]),
        ..._messages(),
        const WebEmpty(
          'دانش‌آموزی برای این کلاس ثبت نشده است.',
          key: Key('att-empty'),
        ),
      ];
    }
    final counts = {for (final s in _webStates) s: 0};
    for (final r in c.roster) {
      final v = c.statusOf(r);
      if (counts.containsKey(v)) counts[v] = counts[v]! + 1;
    }
    if (Web.d2) return _d2Sheet(open, counts);
    return [
      WebPageHead(
        title: 'حضور و غیاب',
        sub: '${open.name} · ${Web.jdate(c.date)}',
        actions: [back],
      ),
      ..._messages(),
      WebCard.tight(
        key: const Key('att-counts'),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            WebBadge(
              'حاضر ${Web.fa(counts[AttendanceStatus.present]!)}',
              key: const Key('att-count-present'),
              tone: WebTone.green,
            ),
            WebBadge(
              'غایب ${Web.fa(counts[AttendanceStatus.absent]!)}',
              key: const Key('att-count-absent'),
              tone: WebTone.red,
            ),
            WebBadge(
              'تأخیر ${Web.fa(counts[AttendanceStatus.late]!)}',
              key: const Key('att-count-late'),
              tone: WebTone.amber,
            ),
            WebBadge(
              'خروج ${Web.fa(counts[AttendanceStatus.earlyExit]!)}',
              key: const Key('att-count-early_exit'),
              tone: WebTone.purple,
            ),
          ],
        ),
      ),
      WebCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  Expanded(child: Text('فهرست کلاس', style: Web.b)),
                  WebBtn(
                    'همه حاضر',
                    key: const Key('att-all-present'),
                    onPressed: c.busy
                        ? null
                        : () => c.markAll(AttendanceStatus.present),
                  ),
                  const SizedBox(width: 9.6),
                  WebBtn(
                    'همه غایب',
                    key: const Key('att-all-absent'),
                    onPressed: c.busy
                        ? null
                        : () => c.markAll(AttendanceStatus.absent),
                  ),
                ],
              ),
            ),
            for (final r in c.roster) _StudentRow(controller: c, entry: r),
            const SizedBox(height: 12),
            WebBtn(
              'ثبت نهایی حضور',
              key: const Key('att-save'),
              kind: WebBtnKind.primary,
              size: WebBtnSize.normal,
              block: true,
              onPressed: c.busy ? null : _save,
            ),
          ],
        ),
      ),
    ];
  }
}

extension on _AttendanceScreenState {
  /// Row 180 — design 2 «حضور و غیاب» on a phone, as drawn: the head (back chevron, title,
  /// «class · date»), the class chips (radius 6, the open one filled), three outlined summary
  /// cards (حاضر / تأخیر / غایب with the number in its colour), «همه حاضرند؟» with the violet
  /// «همه حاضر ✓», one row per student (avatar, name, «ردیف n», the outlined toggle group) and
  /// the full-width black «✓ ثبت حضور · n نفر».
  List<Widget> _d2Sheet(
    AttendanceClass open,
    Map<AttendanceStatus, int> counts,
  ) {
    Widget count(AttendanceStatus s, String label, Color color) => Expanded(
      child: Semantics(
        container: true,
        label: '$label ${Web.fa(counts[s]!)}',
        child: Container(
          key: Key('att-count-${s.wire}'),
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(
            color: Web.card,
            border: Border.all(color: Web.line),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            children: [
              Text(
                Web.fa(counts[s]!),
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w800,
                  height: 1.2,
                  color: color,
                  fontFeatures: Web.numFeatures,
                ),
              ),
              const SizedBox(height: 2),
              Text(label, style: TextStyle(fontSize: 12, color: Web.muted)),
            ],
          ),
        ),
      ),
    );
    return [
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'حضور و غیاب',
                    key: const Key('web-title'),
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color: Web.ink,
                    ),
                  ),
                  Text(
                    '${open.name} · ${Web.fa(Web.jdate(c.date))}',
                    style: TextStyle(fontSize: 12, color: Web.muted),
                  ),
                ],
              ),
            ),
            IconButton(
              key: const Key('att-back'),
              tooltip: 'بازگشت',
              onPressed: c.busy ? null : _back,
              icon: Icon(Icons.chevron_left_rounded, color: Web.ink),
            ),
          ],
        ),
      ),
      if (c.classes.length > 1)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final k in c.classes) ...[
                  _D2ClassChip(
                    key: Key('att-chip-${k.id}'),
                    label: k.name,
                    on: k.id == open.id,
                    onTap: c.busy || k.id == open.id
                        ? null
                        : () => c.openClass(k),
                  ),
                  const SizedBox(width: 6),
                ],
              ],
            ),
          ),
        ),
      ..._messages(),
      Row(
        children: [
          count(AttendanceStatus.present, 'حاضر', Web.green),
          const SizedBox(width: 8),
          count(AttendanceStatus.late, 'تأخیر', Web.amber),
          const SizedBox(width: 8),
          count(AttendanceStatus.absent, 'غایب', Web.red),
        ],
      ),
      Padding(
        padding: const EdgeInsets.only(top: 14, bottom: 2),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'همه حاضرند؟',
                style: TextStyle(fontSize: 12, color: Web.muted),
              ),
            ),
            TextButton(
              key: const Key('att-all-absent'),
              onPressed: c.busy
                  ? null
                  : () => c.markAll(AttendanceStatus.absent),
              style: TextButton.styleFrom(
                foregroundColor: Web.muted,
                minimumSize: const Size(48, 40),
                textStyle: Theme.of(context).textTheme.labelLarge
                    ?.copyWith(fontSize: 12.5),
              ),
              child: const Text('همه غایب'),
            ),
            TextButton.icon(
              key: const Key('att-all-present'),
              onPressed: c.busy
                  ? null
                  : () => c.markAll(AttendanceStatus.present),
              style: TextButton.styleFrom(
                foregroundColor: Web.link,
                minimumSize: const Size(48, 40),
                textStyle: Theme.of(context).textTheme.labelLarge
                    ?.copyWith(fontSize: 12.5),
              ),
              iconAlignment: IconAlignment.end,
              icon: const Icon(Icons.check_rounded, size: 15),
              label: const Text('همه حاضر'),
            ),
          ],
        ),
      ),
      for (final (i, r) in c.roster.indexed)
        _D2StudentRow(controller: c, entry: r, index: i + 1),
      const SizedBox(height: 14),
      SizedBox(
        height: 48,
        child: FilledButton.icon(
          key: const Key('att-save'),
          onPressed: c.busy ? null : _save,
          style: FilledButton.styleFrom(
            backgroundColor: Web.primary,
            foregroundColor: Web.onPrimary,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
            textStyle: Theme.of(context).textTheme.labelLarge
                ?.copyWith(fontSize: 14, fontWeight: FontWeight.w700),
          ),
          icon: const Icon(Icons.check_rounded, size: 18),
          label: Text('ثبت حضور · ${Web.fa(c.roster.length)} نفر'),
        ),
      ),
    ];
  }
}

/// design 2 `.chip` of the class strip: radius 6, outlined; the open class filled primary.
class _D2ClassChip extends StatelessWidget {
  const _D2ClassChip({
    super.key,
    required this.label,
    required this.on,
    this.onTap,
  });
  final String label;
  final bool on;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: on,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        constraints: const BoxConstraints(minHeight: 34),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: on ? Web.primary : Web.card,
          border: Border.all(color: on ? Web.primary : Web.line),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: on ? FontWeight.w700 : FontWeight.w500,
            color: on ? Web.onPrimary : Web.ink2,
          ),
        ),
      ),
    ),
  );
}

/// design 2 roster row: avatar 32, name + «ردیف n», the outlined toggle group (radius 7, the
/// chosen state filled in its colour).
class _D2StudentRow extends StatelessWidget {
  const _D2StudentRow({
    required this.controller,
    required this.entry,
    required this.index,
  });
  final AttendanceController controller;
  final RosterEntry entry;
  final int index;

  @override
  Widget build(BuildContext context) {
    final current = controller.statusOf(entry);
    return Container(
      key: Key('att-row-${entry.studentId}'),
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: Web.line)),
      ),
      child: Row(
        children: [
          D2Avatar(entry.name, size: 32),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  entry.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: Web.ink,
                  ),
                ),
                Text(
                  'ردیف ${Web.fa(index)}',
                  style: TextStyle(fontSize: 11.5, color: Web.muted),
                ),
              ],
            ),
          ),
          if (entry.recorded == null)
            const SizedBox.shrink(key: Key('att-row-new')),
          Container(
            padding: const EdgeInsets.all(2),
            decoration: BoxDecoration(
              border: Border.all(color: Web.line),
              borderRadius: BorderRadius.circular(7),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final s in const [
                  AttendanceStatus.present,
                  AttendanceStatus.late,
                  AttendanceStatus.absent,
                  AttendanceStatus.earlyExit,
                ])
                  AttendanceButton(
                    key: Key('att-${entry.studentId}-${s.wire}'),
                    status: s,
                    on: current == s,
                    label: '${entry.name}: ${s.labelFa}',
                    onTap: controller.busy
                        ? null
                        : () => controller.mark(entry.studentId, s),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The four buttons of the web roster (`excused` has none there).
const _webStates = [
  AttendanceStatus.present,
  AttendanceStatus.absent,
  AttendanceStatus.late,
  AttendanceStatus.earlyExit,
];

/// `a.item` of the class list (`a{color:var(--primary)}` colours the name).
class _ClassItem extends StatelessWidget {
  const _ClassItem({
    super.key,
    required this.item,
    required this.done,
    required this.onTap,
  });
  final AttendanceClass item;
  final bool done;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    child: WebItem(
      title: item.name,
      subWidget: Text(
        '${Web.fa(item.students)} دانش‌آموز · ${faDigits(item.grade)}',
        style: TextStyle(
          fontSize: 12,
          color: Web.muted,
          height: Web.lineHeight,
        ),
      ),
      titleColor: Web.primary,
      actions: [
        WebBadge(
          done ? 'ثبت‌شده' : 'ثبت‌نشده',
          tone: done ? WebTone.green : WebTone.amber,
        ),
      ],
      onTap: onTap,
    ),
  );
}

/// `.att-row`: the name (flex, 14px) and the four `.att-btn`s, a line under each row.
class _StudentRow extends StatelessWidget {
  const _StudentRow({required this.controller, required this.entry});

  final AttendanceController controller;
  final RosterEntry entry;

  @override
  Widget build(BuildContext context) {
    final current = controller.statusOf(entry);
    return Container(
      key: Key('att-row-${entry.studentId}'),
      padding: const EdgeInsets.symmetric(horizontal: 3.2, vertical: 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: Web.line)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(entry.name, style: const TextStyle(fontSize: 14)),
          ),
          if (entry.recorded == null)
            // native: the day has nothing stored for this student yet (screen readers)
            const SizedBox.shrink(key: Key('att-row-new')),
          const SizedBox(width: 8),
          for (final (i, s) in _webStates.indexed) ...[
            if (i > 0) const SizedBox(width: 4),
            AttendanceButton(
              key: Key('att-${entry.studentId}-${s.wire}'),
              status: s,
              on: current == s,
              label: '${entry.name}: ${s.labelFa}',
              onTap: controller.busy
                  ? null
                  : () => controller.mark(entry.studentId, s),
            ),
          ],
        ],
      ),
    );
  }
}

/// `.att-btn` as pulse.css draws it (`.pjs-att-*`: min-height 48, radius 14, weight 800,
/// tinted per state); the chosen one has the strong `.on-*` colours of styles.css.
class AttBtnLook {
  const AttBtnLook(
    this.fg,
    this.border,
    this.bg,
    this.onFg,
    this.onBorder,
    this.onBg,
  );
  final Color fg, border, bg, onFg, onBorder, onBg;

  /// Row 179: «مینیمال» light keeps the web colours (present = green, not teal); dark mode
  /// gets its own readable set.
  static AttBtnLook of(AttendanceStatus s) => Web.dark
      ? switch (s) {
          AttendanceStatus.present => const AttBtnLook(
            Color(0xFF4ADE80),
            Color(0x664ADE80),
            Color(0x1A4ADE80),
            Color(0xFFDCFCE7),
            Color(0xFF22C55E),
            Color(0xFF14532D),
          ),
          AttendanceStatus.absent => const AttBtnLook(
            Color(0xFFFB7185),
            Color(0x59FB7185),
            Color(0x17FB7185),
            Color(0xFFFEE2E2),
            Color(0xFFEF4444),
            Color(0xFF7F1D1D),
          ),
          AttendanceStatus.late => const AttBtnLook(
            Color(0xFFFBBF24),
            Color(0x66FBBF24),
            Color(0x1AFBBF24),
            Color(0xFFFEF3C7),
            Color(0xFFF59E0B),
            Color(0xFF78350F),
          ),
          _ => const AttBtnLook(
            Color(0xFF38BDF8),
            Color(0x5938BDF8),
            Color(0x1738BDF8),
            Color(0xFFE0E7FF),
            Color(0xFF818CF8),
            Color(0xFF312E81),
          ),
        }
      : switch (s) {
          AttendanceStatus.present =>
            Web.palette.flat
                ? const AttBtnLook(
                    Color(0xFF15803D),
                    Color(0x6615803D),
                    Color(0x1A22C55E),
                    Color(0xFF166534),
                    Color(0xFF86EFAC),
                    Color(0xFFDCFCE7),
                  )
                : const AttBtnLook(
                    Color(0xFF0D9488),
                    Color(0x660D9488),
                    Color(0x1A14B8A6),
                    Color(0xFF166534),
                    Color(0xFF86EFAC),
                    Color(0xFFDCFCE7),
                  ),
          AttendanceStatus.absent => const AttBtnLook(
            Color(0xFFE11D48),
            Color(0x59E11D48),
            Color(0x17F43F5E),
            Color(0xFF991B1B),
            Color(0xFFFCA5A5),
            Color(0xFFFEE2E2),
          ),
          AttendanceStatus.late => const AttBtnLook(
            Color(0xFFB45309),
            Color(0x66F59E0B),
            Color(0x1AF59E0B),
            Color(0xFF92400E),
            Color(0xFFFCD34D),
            Color(0xFFFEF3C7),
          ),
          _ => const AttBtnLook(
            Color(0xFF0284C7),
            Color(0x590EA5E9),
            Color(0x170EA5E9),
            Color(0xFF3730A3),
            Color(0xFFA5B4FC),
            Color(0xFFE0E7FF),
          ),
        };
}

/// One `.att-btn` (public so tests can read its state).
class AttendanceButton extends StatelessWidget {
  const AttendanceButton({
    super.key,
    required this.status,
    required this.on,
    required this.label,
    required this.onTap,
  });
  final AttendanceStatus status;
  final bool on;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l = AttBtnLook.of(status);
    if (Web.d2) {
      // design 2 `.tg`: a segment of the outlined group — muted text, the chosen one filled
      final fill = switch (status) {
        AttendanceStatus.present => Web.green,
        AttendanceStatus.absent => Web.red,
        AttendanceStatus.late => Web.amber,
        _ => Web.link,
      };
      final onText = Web.dark || status == AttendanceStatus.late
          ? const Color(0xFF09090B)
          : Colors.white;
      return Semantics(
        button: true,
        selected: on,
        inMutuallyExclusiveGroup: true,
        label: label,
        enabled: onTap != null,
        onTap: onTap,
        excludeSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 34, minWidth: 34),
            padding: const EdgeInsets.symmetric(horizontal: 7),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: on ? fill : null,
              borderRadius: BorderRadius.circular(5),
            ),
            child: Text(
              status == AttendanceStatus.earlyExit ? 'خروج' : status.labelFa,
              style: TextStyle(
                fontSize: 12,
                fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                color: on ? onText : Web.muted,
              ),
            ),
          ),
        ),
      );
    }
    return Semantics(
      button: true,
      selected: on,
      inMutuallyExclusiveGroup: true,
      label: label,
      enabled: onTap != null,
      onTap: onTap,
      excludeSemantics: true,
      child: MouseRegion(
        cursor: onTap == null ? MouseCursor.defer : SystemMouseCursors.click,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 48, minWidth: 44),
            padding: const EdgeInsets.symmetric(horizontal: 8.8, vertical: 5.6),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: on ? l.onBg : l.bg,
              border: Border.all(color: on ? l.onBorder : l.border),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Text(
              status.labelFa,
              style: TextStyle(
                fontSize: 12,
                fontWeight: on ? FontWeight.w700 : FontWeight.w800,
                color: on ? l.onFg : l.fg,
              ),
            ),
          ),
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
    return PayeshTile(
      key: const Key('att-entry'),
      onTap: open,
      icon: Icons.fact_check_outlined,
      label: 'حضور و غیاب',
      tone: PayeshTone.success,
    );
  }

  /// Row 165: true when this entry is a home tile (else a short note or nothing).
  bool get isTile =>
      role != null &&
      AttendanceBook.writers.contains(role) &&
      enabled &&
      uid != null;
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
