import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/d2.dart';
import '../pulse/pulse.dart';
import '../pulse/web.dart';
import '../sync_badge.dart';
import 'family_controller.dart';

/// Row 172: the web text exactly — no grade / no record reads «۰.۰» / «۰٪» like the web panel.
String averageLabel(double? avg) =>
    'معدل ${faDigits((avg ?? 0).toStringAsFixed(1))}';

String attendanceLabel(int? pct) => 'حضور ${faDigits(pct ?? 0)}٪';

String _score(num n) => faDigits(n % 1 == 0 ? n.toInt() : n);

/// web `parentHome` empty-family text (one literal: the parity test compares it with the web).
const _noKids = 'فرزندی به حساب شما متصل نیست — با دفتر مدرسه تماس بگیرید.';

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
    icon: backOrCloseIcon(context),
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

/// Row 172: web `parentHome` exactly — pageHead «فرزندان من» / «N فرزند» with «🔄»; one
/// `<a class="card">` per linked child (bold name, muted class, the badges «معدل X» and
/// «حضور X٪»); the «📥 صندوقچهٔ ابری» card while changes wait; the card with «📨 درخواست
/// مرخصی» and «📢 اطلاعیه‌ها». A tap opens the child page (web `#/child/<id>`) in place.
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

  /// The child whose page is open (web `#/child/<id>`), null on the home.
  int? _open;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  void _openChild(ChildSummary k) {
    setState(() => _open = k.id);
    unawaited(c.openChild(k.id));
  }

  void _closeChild() {
    c.closeChild();
    setState(() => _open = null);
  }

  void _go(String route) {
    if (PulseInline.go(context, route)) return;
    if (route == 'leaves') {
      openPanel<void>(
        context,
        (_) => LeavesScreen(
          controller: c,
          sync: widget.sync,
          onRetry: widget.onRetry,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([c, widget.sync]),
      builder: (context, _) {
        final inline = PulseInline.of(context);
        final content = c.loading && c.children.isEmpty && c.error == null
            ? const Center(
                child: CircularProgressIndicator(key: Key('fam-loading')),
              )
            : WebPageBody(
                children: _open == null
                    ? _home()
                    : ChildPage(controller: c, onBack: _closeChild).blocks(),
              );
        return PopScope(
          canPop: _open == null,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop && _open != null) _closeChild();
          },
          child: Scaffold(
            backgroundColor: inline ? Colors.transparent : Web.bg,
            appBar: inline
                ? null
                : _bar(
                    context,
                    'فرزندان من',
                    'fam-back',
                    widget.sync,
                    widget.onRetry,
                  ),
            body: inline ? content : WebBackdrop(child: content),
          ),
        );
      },
    );
  }

  List<Widget> _home() {
    final waiting = widget.sync.value.waiting;
    if (Web.d2) return _d2Home(waiting);
    return [
      WebPageHead(
        title: 'فرزندان من',
        sub: c.error == null ? '${Web.fa(c.children.length)} فرزند' : null,
        subKey: const Key('fam-count'),
        actions: [
          WebBtn('🔄', key: const Key('fam-sync'), onPressed: widget.onRetry),
        ],
      ),
      if (c.error != null)
        WebBanner(
          kind: WebBannerKind.err,
          text: c.error!,
          textKey: const Key('fam-error'),
        ),
      if (c.error == null) ...[
        if (c.children.isEmpty) const WebEmpty(_noKids, key: Key('fam-empty')),
        for (final k in c.children) _card(k),
        // web `cloudCard`: only while changes of this device wait
        if (waiting > 0) _cloudCard(waiting),
        WebCard(
          child: Row(
            children: [
              Expanded(
                child: WebBtn(
                  '📨 درخواست مرخصی',
                  key: const Key('fam-leaves'),
                  size: WebBtnSize.normal,
                  block: true,
                  onPressed: () => _go('leaves'),
                ),
              ),
              const SizedBox(width: 9.6),
              Expanded(
                child: WebBtn(
                  '📢 اطلاعیه‌ها',
                  key: const Key('fam-notices'),
                  size: WebBtnSize.normal,
                  block: true,
                  onPressed: PulseInline.of(context)
                      ? () => _go('announcements')
                      : null,
                ),
              ),
            ],
          ),
        ),
      ],
    ];
  }

  /// Row 180 — design 2 parent home on a phone, as drawn: the muted date over «سلام» and the
  /// bell; the kid chips (avatar + «name · class», the chosen one filled); two tiles for the
  /// chosen child (attendance, then the average in violet); «برنامهٔ امروز» with the running
  /// lesson in violet and «اکنون»; the newest notice; the leave / notices actions.
  List<Widget> _d2Home(int waiting) {
    final now = WebClock.of(context);
    final iso =
        '${now.year}-${'${now.month}'.padLeft(2, '0')}-${'${now.day}'.padLeft(2, '0')}';
    final day = Web.jDays[(now.weekday + 1) % 7];
    final k =
        c.children.where((x) => x.id == c.kid).firstOrNull ??
        c.children.firstOrNull;
    final today = c.kidToday;
    final notice = c.latestNotice;
    Widget card({Key? key, required Widget child, VoidCallback? onTap}) =>
        Material(
          key: key,
          color: Web.card,
          shape: RoundedRectangleBorder(
            side: BorderSide(color: Web.line),
            borderRadius: BorderRadius.circular(10),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(padding: const EdgeInsets.all(14), child: child),
          ),
        );
    Widget tile({
      required Key key,
      required Key valueKey,
      required String label,
      required String value,
      required String sub,
      required Color color,
      required String semantics,
    }) => Expanded(
      child: card(
        key: key,
        onTap: k == null ? null : () => _openChild(k),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(fontSize: 12, color: Web.muted)),
            const SizedBox(height: 4),
            Semantics(
              label: semantics,
              excludeSemantics: true,
              child: Text(
                value,
                key: valueKey,
                style: TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w800,
                  height: 1.25,
                  color: color,
                  fontFeatures: Web.numFeatures,
                ),
              ),
            ),
            Text(
              sub,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: Web.muted),
            ),
          ],
        ),
      ),
    );
    return [
      Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '$day ${Web.fa(Web.jdate(iso))}',
                    style: TextStyle(fontSize: 12, color: Web.muted),
                  ),
                  Text(
                    'سلام 👋',
                    key: const Key('web-title'),
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                      color: Web.ink,
                    ),
                  ),
                  if (c.error == null)
                    Text(
                      '${Web.fa(c.children.length)} فرزند',
                      key: const Key('fam-count'),
                      style: TextStyle(fontSize: 12, color: Web.muted),
                    ),
                ],
              ),
            ),
            D2IconButton(
              key: const Key('fam-sync'),
              icon: Icons.sync_rounded,
              tooltip: 'همگام‌سازی',
              onPressed: widget.onRetry,
            ),
            const SizedBox(width: 8),
            D2IconButton(
              key: const Key('fam-bell'),
              icon: Icons.notifications_none_rounded,
              tooltip: 'اطلاعیه‌ها',
              dot: notice != null,
              onPressed: PulseInline.of(context)
                  ? () => _go('announcements')
                  : null,
            ),
          ],
        ),
      ),
      if (c.error != null)
        WebBanner(
          kind: WebBannerKind.err,
          text: c.error!,
          textKey: const Key('fam-error'),
        ),
      if (c.error == null) ...[
        if (c.children.isEmpty) const WebEmpty(_noKids, key: Key('fam-empty')),
        if (c.children.isNotEmpty)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final x in c.children) ...[
                  _KidChip(
                    key: Key('fam-card-${x.id}'),
                    kid: x,
                    on: x.id == k?.id,
                    onTap: () => c.pickKid(x.id),
                  ),
                  const SizedBox(width: 8),
                ],
              ],
            ),
          ),
        if (k != null) ...[
          const SizedBox(height: 12),
          Row(
            children: [
              tile(
                key: Key('fam-open-${k.id}'),
                valueKey: Key('fam-att-${k.id}'),
                label: 'حضور',
                value: k.attendancePercent == null
                    ? '—'
                    : '${Web.fa(k.attendancePercent!)}٪',
                sub: k.attendanceRecords == 0
                    ? 'هنوز ثبت نشده'
                    : (k.attendancePercent ?? 0) >= 100
                    ? 'بدون غیبت'
                    : '${Web.fa(k.attendanceRecords)} جلسهٔ ثبت‌شده',
                color: Web.ink,
                semantics: attendanceLabel(k.attendancePercent),
              ),
              const SizedBox(width: 10),
              tile(
                key: Key('fam-tile-avg-${k.id}'),
                valueKey: Key('fam-avg-${k.id}'),
                label: 'میانگین نمره',
                value: k.average == null
                    ? '—'
                    : Web.fa(k.average!.toStringAsFixed(1)),
                sub: k.approvedGrades == 0
                    ? 'نمرهٔ تأییدشده‌ای نیست'
                    : '${Web.fa(k.approvedGrades)} نمرهٔ تأییدشده',
                color: Web.link,
                semantics: averageLabel(k.average),
              ),
            ],
          ),
          const SizedBox(height: 12),
          card(
            key: const Key('fam-today'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'برنامهٔ امروز',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: Web.ink,
                        ),
                      ),
                    ),
                    if (today != null && today.slots.isNotEmpty)
                      Text(
                        '${Web.fa(today.slots.length)} کلاس',
                        style: TextStyle(fontSize: 12, color: Web.muted),
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                if (today == null || today.slots.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      'امروز کلاسی در برنامه نیست.',
                      key: const Key('fam-today-empty'),
                      style: TextStyle(fontSize: 12.5, color: Web.muted),
                    ),
                  )
                else
                  for (final (i, sl) in today.slots.indexed)
                    _SlotRow(key: Key('fam-slot-$i'), slot: sl),
              ],
            ),
          ),
        ],
        if (notice != null) ...[
          const SizedBox(height: 12),
          card(
            key: const Key('fam-notice'),
            onTap: PulseInline.of(context) ? () => _go('announcements') : null,
            child: Row(
              children: [
                const D2IconBox(Icons.chat_bubble_outline_rounded),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        notice.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w700,
                          color: Web.ink,
                        ),
                      ),
                      Text(
                        '${Web.fa(Web.jdate(notice.date))} · ${notice.body.replaceAll('\n', ' ')}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: Web.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
        if (waiting > 0) ...[const SizedBox(height: 12), _cloudCard(waiting)],
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: WebBtn(
                'درخواست مرخصی',
                key: const Key('fam-leaves'),
                size: WebBtnSize.normal,
                block: true,
                onPressed: () => _go('leaves'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: WebBtn(
                'اطلاعیه‌ها',
                key: const Key('fam-notices'),
                size: WebBtnSize.normal,
                block: true,
                onPressed: PulseInline.of(context)
                    ? () => _go('announcements')
                    : null,
              ),
            ),
          ],
        ),
      ],
    ];
  }

  Widget _card(ChildSummary k) => MouseRegion(
    key: Key('fam-card-${k.id}'),
    cursor: SystemMouseCursors.click,
    child: GestureDetector(
      key: Key('fam-open-${k.id}'),
      behavior: HitTestBehavior.opaque,
      onTap: () => _openChild(k),
      child: WebCard(
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // an `<a class="card">`: the bold name takes the link colour
                  Text(k.name, style: Web.b.copyWith(color: Web.primary)),
                  Text(
                    k.className,
                    key: Key('fam-class-${k.id}'),
                    style: Web.small,
                  ),
                ],
              ),
            ),
            WebBadge(
              averageLabel(k.average),
              key: Key('fam-avg-${k.id}'),
              tone: webAverageTone(k.average ?? 0),
            ),
            const SizedBox(width: 9.6),
            WebBadge(
              attendanceLabel(k.attendancePercent),
              key: Key('fam-att-${k.id}'),
              tone: (k.attendancePercent ?? 0) >= 90
                  ? WebTone.green
                  : WebTone.amber,
            ),
          ],
        ),
      ),
    ),
  );

  Widget _cloudCard(int waiting) => WebCard(
    key: const Key('fam-cloud'),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text('📥 صندوقچهٔ ابری', style: Web.b)),
            WebBadge('در انتظار اعمال', tone: WebTone.amber),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text.rich(
            TextSpan(
              style: TextStyle(fontSize: 12.5, color: Web.ink),
              children: [
                const TextSpan(text: '📤 '),
                TextSpan(
                  text: Web.fa(waiting),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const TextSpan(
                  text: ' تغییر روی همین دستگاه ثبت شده و هنوز اعمال نشده.',
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.only(top: 6),
          child: Text(
            'لازم نیست کاری کنید: اولین سیستمی که روشن شود (مدرسه، خانه یا گوشیِ کادر) خودش این‌ها را اعمال می‌کند.',
            style: Web.small,
          ),
        ),
      ],
    ),
  );
}

/// Web badge of an average: `avg >= 15 ? green : avg >= 10 ? amber : red` (no grade = 0).
WebTone webAverageTone(double avg) => avg >= 15
    ? WebTone.green
    : avg >= 10
    ? WebTone.amber
    : WebTone.red;

/// Row 172: web `PAGES.child` exactly — pageHead (child name / class, «بازگشت»), three stat
/// cards (معدل, حضور, نمره ثبت‌شده), «نمرات» (درس / نوبت / نمره / وضعیت), «حضور و غیاب» (the
/// latest 12: تاریخ / وضعیت) and «کارآموزی» when there is any.
class ChildPage {
  const ChildPage({required this.controller, required this.onBack});

  final FamilyController controller;
  final VoidCallback onBack;

  List<Widget> blocks() {
    final c = controller;
    final r = c.child;
    final back = WebBtn(
      'بازگشت',
      key: const Key('chd-back'),
      onPressed: onBack,
    );
    if (r == null) {
      return [
        WebPageHead(title: 'پرونده', actions: [back]),
        if (c.childError != null)
          WebBanner(
            kind: WebBannerKind.err,
            text: c.childError!,
            textKey: const Key('chd-error'),
          )
        else
          const Center(
            child: Padding(
              padding: EdgeInsets.all(26),
              child: CircularProgressIndicator(key: Key('chd-loading')),
            ),
          ),
      ];
    }
    final s = r.summary;
    // web: the average of every grade of the child (approved and pending), 0 when none
    final avg = r.grades.isEmpty
        ? 0.0
        : r.grades.fold<double>(0, (a, g) => a + g.score) / r.grades.length;
    final pct = s.attendancePercent ?? 0;
    Widget title(String t) => Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(t, style: Web.b),
    );
    Widget empty(String t, String key) => Text(
      t,
      key: Key(key),
      style: TextStyle(fontSize: 15, color: Web.muted),
    );
    WebTone state(bool approved) => approved ? WebTone.green : WebTone.amber;
    return [
      WebPageHead(title: s.name, sub: s.className, actions: [back]),
      WebGrid(
        children: [
          WebStat(
            icon: 'chart',
            num: Web.fa(avg.toStringAsFixed(1)),
            label: 'معدل',
            numKey: const Key('chd-avg'),
            numColor: avg >= 15
                ? Web.green
                : avg >= 10
                ? null
                : Web.red,
          ),
          WebStat(
            icon: 'check',
            num: '${Web.fa(pct)}٪',
            label: 'حضور',
            numKey: const Key('chd-att'),
            numColor: pct >= 90 ? Web.green : Web.amber,
          ),
          WebStat(
            icon: 'pen',
            num: Web.fa(r.grades.length),
            label: 'نمره ثبت‌شده',
            numKey: const Key('chd-count'),
          ),
        ],
      ),
      WebCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            title('نمرات'),
            WebTable(
              head: const ['درس', 'نوبت', 'نمره', 'وضعیت'],
              empty: r.grades.isEmpty
                  ? empty('نمره‌ای ثبت نشده', 'chd-grades-empty')
                  : null,
              rows: [
                for (final g in r.grades)
                  [
                    Text(
                      g.subject.isEmpty ? '—' : g.subject,
                      key: Key('chd-grade-${g.id}'),
                    ),
                    Text(g.term, style: Web.small),
                    Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: _score(g.score),
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                          if (g.practicalScore != null)
                            TextSpan(
                              text: ' (عملی ${_score(g.practicalScore!)})',
                              style: TextStyle(
                                fontSize: 12.5,
                                color: Web.muted,
                              ),
                            ),
                        ],
                      ),
                      key: Key('chd-score-${g.id}'),
                    ),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: WebBadge(
                        g.approved ? 'تأییدشده' : 'در انتظار',
                        key: Key('chd-state-${g.id}'),
                        tone: state(g.approved),
                      ),
                    ),
                  ],
              ],
            ),
          ],
        ),
      ),
      WebCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            title('حضور و غیاب'),
            WebTable(
              head: const ['تاریخ', 'وضعیت'],
              empty: r.attendance.isEmpty
                  ? empty('ثبت نشده', 'chd-att-empty')
                  : null,
              rows: [
                for (final a in r.attendance.take(12))
                  [
                    Text(Web.jdate(a.date), key: Key('chd-day-${a.id}')),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: WebBadge(
                        a.status?.labelFa ?? a.raw,
                        key: Key('chd-day-state-${a.id}'),
                        tone: switch (a.status) {
                          AttendanceStatus.present => WebTone.green,
                          AttendanceStatus.absent => WebTone.red,
                          _ => WebTone.amber,
                        },
                      ),
                    ),
                  ],
              ],
            ),
          ],
        ),
      ),
      if (r.internships.isNotEmpty)
        WebCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              title('کارآموزی'),
              WebTable(
                head: const ['تاریخ', 'ساعت', 'محل', 'وضعیت'],
                rows: [
                  for (final i in r.internships)
                    [
                      Text(Web.jdate(i.date), key: Key('chd-int-${i.id}')),
                      Text(i.hours == null ? '' : _score(i.hours!)),
                      Text(i.location, style: Web.small),
                      Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: WebBadge(
                          i.approved ? 'تأییدشده' : 'در انتظار',
                          tone: state(i.approved),
                        ),
                      ),
                    ],
                ],
              ),
            ],
          ),
        ),
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
    await openPanel<void>(context, (_) => LeaveForm(controller: controller));
    controller.clearForm();
  }

  /// Row 172: web `PAGES.leaves` (parent) exactly — pageHead «مرخصی و غیبت موجه» + «N درخواست»
  /// and «+ درخواست»; one card per request: bold child name, the state badge, «date · reason».
  @override
  Widget build(BuildContext context) {
    final c = controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final inline = PulseInline.of(context);
        final content = WebPageBody(
          children: [
            WebPageHead(
              title: 'مرخصی و غیبت موجه',
              sub: c.error == null
                  ? '${faDigits(c.leaves.length)} درخواست'
                  : null,
              subKey: const Key('lvs-count'),
              actions: [
                WebBtn(
                  '+ درخواست',
                  key: const Key('lvs-add'),
                  kind: WebBtnKind.primary,
                  onPressed: c.busy || c.children.isEmpty
                      ? null
                      : () => _openForm(context),
                ),
              ],
            ),
            if (c.error != null)
              WebBanner(
                kind: WebBannerKind.err,
                text: c.error!,
                textKey: const Key('lvs-error'),
              )
            else if (c.notice != null)
              Semantics(
                liveRegion: true,
                child: WebBanner(
                  kind: WebBannerKind.ok,
                  text: c.notice!,
                  textKey: const Key('lvs-notice'),
                ),
              ),
            if (c.error == null && c.leaves.isEmpty)
              const WebEmpty('درخواستی ثبت نشده.', key: Key('lvs-empty')),
            for (final l in c.leaves) _card(l),
          ],
        );
        return Scaffold(
          backgroundColor: inline ? Colors.transparent : Web.bg,
          appBar: inline
              ? null
              : _bar(context, 'مرخصی و غیبت موجه', 'lvs-back', sync, onRetry),
          body: inline ? content : WebBackdrop(child: content),
        );
      },
    );
  }

  Widget _card(LeaveRequest l) => WebCard(
    key: Key('lvs-card-${l.id}'),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text(l.studentName, style: Web.b)),
            if (l.queued) ...[
              WebBadge(
                'در صف ارسال',
                key: Key('lvs-queued-${l.id}'),
                tone: WebTone.amber,
              ),
              const SizedBox(width: 6),
            ],
            WebBadge(
              l.state.labelFa,
              key: Key('lvs-state-${l.id}'),
              tone: switch (l.state) {
                LeaveState.approved => WebTone.green,
                LeaveState.rejected => WebTone.red,
                LeaveState.pending => WebTone.amber,
              },
            ),
          ],
        ),
        Text.rich(
          TextSpan(
            style: TextStyle(fontSize: 12.5, color: Web.muted, height: 1.6),
            children: [
              TextSpan(text: Web.jdate(l.date)),
              if (l.reason.isNotEmpty) const TextSpan(text: ' · '),
              if (l.reason.isNotEmpty) TextSpan(text: l.reason),
            ],
          ),
          key: Key('lvs-date-${l.id}'),
        ),
      ],
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
              icon: backOrCloseIcon(context),
              onPressed: _leave,
            ),
            title: const Text('درخواست مرخصی'),
          ),
          body: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space4),
            children: [
              if (c.formError != null)
                _error(context, c.formError!, 'lvf-error'),
              FieldBox(
                width: kFieldText,
                child: DropdownButtonFormField<int>(
                  isExpanded: true,
                  key: const Key('lvf-student'),
                  initialValue: _student,
                  // row 166: the refused field is outlined red
                  decoration: InputDecoration(
                    labelText: 'دانش‌آموز',
                    errorText: _student == null
                        ? fieldIssueFor(c.formError, 'دانش‌آموز', '')
                        : null,
                  ),
                  items: [
                    for (final k in c.children)
                      DropdownMenuItem(value: k.id, child: Text(k.name)),
                  ],
                  onChanged: (v) => setState(() => _student = v),
                ),
              ),
              const SizedBox(height: PayeshTokens.space3),
              FieldBox(
                width: kFieldDigits,
                child: TextField(
                  key: const Key('lvf-date'),
                  controller: _day,
                  keyboardType: TextInputType.datetime,
                  decoration: InputDecoration(
                    labelText: 'تاریخ شمسی',
                    hintText: '۱۴۰۵/۰۸/۲۱',
                    errorText:
                        c.formError == FamilyError.badDate.messageFa ||
                            fieldIssueFor(c.formError, 'تاریخ', _day.text) !=
                                null
                        ? checkFieldFa
                        : null,
                  ),
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
    return PayeshTile(
      key: const Key('fam-entry'),
      onTap: open,
      icon: Icons.family_restroom,
      label: 'فرزندان من',
      tone: PayeshTone.success,
    );
  }

  /// Row 165: true when this entry is a home tile (else a short note or nothing).
  bool get isTile => role == 'parent' && enabled && uid != null;
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
    this.leaves = false,
  });

  final FamilySource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  /// Row 172: the web sidebar's own «مرخصی» page (parent) instead of «فرزندان».
  final bool leaves;

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
  void initState() {
    super.initState();
    if (widget.leaves) c.load();
  }

  @override
  Widget build(BuildContext context) => widget.leaves
      ? LeavesScreen(controller: c, sync: widget.sync, onRetry: widget.onRetry)
      : FamilyScreen(controller: c, sync: widget.sync, onRetry: widget.onRetry);
}

/// design 2 kid chip: avatar 22 (radius 5) + «name · class», radius 8; the chosen one filled.
class _KidChip extends StatelessWidget {
  const _KidChip({
    super.key,
    required this.kid,
    required this.on,
    required this.onTap,
  });
  final ChildSummary kid;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final first = kid.name.trim().split(RegExp(r'\s+')).first;
    final label = kid.className.isEmpty ? first : '$first · ${kid.className}';
    return Semantics(
      button: true,
      selected: on,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          constraints: const BoxConstraints(minHeight: 40),
          padding: const EdgeInsetsDirectional.fromSTEB(6, 6, 12, 6),
          decoration: BoxDecoration(
            color: on ? Web.primary : Web.card,
            border: Border.all(color: on ? Web.primary : Web.line),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 24,
                height: 24,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: on ? Web.onPrimary : Web.soft,
                  borderRadius: BorderRadius.circular(5),
                ),
                child: Text(
                  kid.name.trim().isEmpty
                      ? '؟'
                      : kid.name.trim().characters.first,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: on ? Web.primary : Web.ink2,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                label,
                key: Key('fam-class-${kid.id}'),
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                  color: on ? Web.onPrimary : Web.ink2,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// design 2 «برنامهٔ امروز» row: the start time, the subject over the teacher; the running
/// lesson in violet with the «اکنون» pill.
class _SlotRow extends StatelessWidget {
  const _SlotRow({super.key, required this.slot});
  final TodaySlot slot;

  @override
  Widget build(BuildContext context) {
    final cur = slot.current;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          SizedBox(
            width: 46,
            child: Text(
              slot.start.isEmpty ? '—' : Web.fa(slot.start),
              style: TextStyle(
                fontSize: 12.5,
                color: Web.muted,
                fontFeatures: Web.numFeatures,
              ),
            ),
          ),
          Container(
            width: 2,
            height: 30,
            margin: const EdgeInsetsDirectional.only(end: 10),
            decoration: BoxDecoration(
              color: cur ? Web.link : Web.line,
              borderRadius: BorderRadius.circular(1),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  slot.subject,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: cur ? Web.link : Web.ink,
                  ),
                ),
                if (slot.teacher.isNotEmpty)
                  Text(
                    slot.teacher,
                    style: TextStyle(fontSize: 11.5, color: Web.muted),
                  ),
              ],
            ),
          ),
          if (cur)
            Container(
              key: const Key('fam-now'),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: Web.link,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                'اکنون',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: Web.dark ? const Color(0xFF09090B) : Colors.white,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
