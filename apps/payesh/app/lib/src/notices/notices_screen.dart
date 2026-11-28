import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/pulse.dart';
import '../pulse/web.dart';
import '../sync_badge.dart';
import 'notices_controller.dart';

/// Tone per severity — the label text is always shown (colour is never the only signal).
PayeshTone noticeTone(NoticeSeverity s) => switch (s) {
  NoticeSeverity.important => PayeshTone.danger,
  NoticeSeverity.info => PayeshTone.info,
  NoticeSeverity.normal => PayeshTone.neutral,
};

/// Native notices page (row 74, wave 4): every role reads the school's notices, newest first;
/// a manager also publishes, edits and deletes. Works offline: a write goes to the device and
/// the badge (and «در صف ارسال» on the card) shows it until the Gateway confirms.
class NoticesScreen extends StatefulWidget {
  const NoticesScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final NoticesController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<NoticesScreen> createState() => _NoticesScreenState();
}

class _NoticesScreenState extends State<NoticesScreen> {
  NoticesController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _openEditor([Notice? n]) async {
    await openPanel<void>(
      context,
      (_) => NoticeEditor(controller: c, editing: n),
    );
    c.clearForm();
  }

  Future<void> _confirmDelete(Notice n) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف اطلاعیه'),
        content: Text('اطلاعیهٔ «${n.title}» حذف شود؟'),
        actions: [
          TextButton(
            key: const Key('ntc-delete-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: const Key('ntc-delete-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (ok == true) await c.delete(n.id);
  }

  /// Row 172: web `PAGES.announcements` exactly — pageHead «اطلاعیه‌ها» + «N مورد» and
  /// «+ اطلاعیه» (manager); one card per notice: bold title, the Jalali date as a badge (red =
  /// important, purple = info), the text, then «ویرایش» / «حذف».
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final inline = PulseInline.of(context);
      final content = c.loading && c.notices.isEmpty && c.error == null
          ? const Center(
              child: CircularProgressIndicator(key: Key('ntc-loading')),
            )
          : WebPageBody(
              children: [
                WebPageHead(
                  title: 'اطلاعیه‌ها',
                  sub: c.error == null
                      ? '${faDigits(c.notices.length)} مورد'
                      : null,
                  subKey: const Key('ntc-count'),
                  actions: [
                    // row 197 F19: a teacher with no class yet has nothing to publish to
                    if (c.canWrite &&
                        (c.canWriteSchool || c.classes.isNotEmpty))
                      WebBtn(
                        '+ اطلاعیه',
                        key: const Key('ntc-add'),
                        kind: WebBtnKind.primary,
                        onPressed: c.busy ? null : _openEditor,
                      ),
                  ],
                ),
                if (c.error != null)
                  WebBanner(
                    kind: WebBannerKind.err,
                    text: c.error!,
                    textKey: const Key('ntc-error'),
                  )
                else if (c.notice != null)
                  Semantics(
                    liveRegion: true,
                    child: WebBanner(
                      kind: WebBannerKind.ok,
                      text: c.notice!,
                      textKey: const Key('ntc-notice'),
                    ),
                  ),
                // row 197 Q10: the manager announces a day off; everyone sees today/tomorrow
                if (c.canWriteSchool && c.error == null) _dayOffCard(),
                if (!c.canWriteSchool) ...[
                  if (c.todayOff case final d?)
                    dayOffBanner(d, 'ntc-dayoff-today'),
                  if (c.tomorrowOff case final d?)
                    dayOffBanner(d, 'ntc-dayoff-tomorrow'),
                ],
                if (c.error == null && c.notices.isEmpty)
                  const WebEmpty('اطلاعیه‌ای ثبت نشده.', key: Key('ntc-empty')),
                for (final n in c.notices) _card(n),
              ],
            );
      return Scaffold(
        backgroundColor: inline ? Colors.transparent : Web.bg,
        appBar: inline
            ? null
            : AppBar(
                automaticallyImplyLeading: false,
                leading: IconButton(
                  key: const Key('ntc-back'),
                  tooltip: 'بازگشت',
                  icon: backOrCloseIcon(context),
                  onPressed: () => Navigator.maybePop(context),
                ),
                title: const Text('اطلاعیه‌ها'),
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

  /// Row 197 Q10: «تعطیلی و غیرحضوری» — upcoming days off with «لغو», and the button.
  Widget _dayOffCard() => WebCard(
    key: const Key('ntc-dayoff-card'),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          alignment: WrapAlignment.spaceBetween,
          children: [
            Text('🗓️ تعطیلی و غیرحضوری', style: Web.b),
            WebBtn(
              '+ اعلام تعطیلی / غیرحضوری',
              key: const Key('ntc-dayoff-add'),
              onPressed: c.busy ? null : _openDayOff,
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          'برای روزهایی مثل آلودگی هوا یا کمبود انرژی: غیبت نمی‌خورد، اولیا با اطلاعیه باخبر '
          'می‌شوند و امتحان‌های داخلی آن روز جابه‌جا می‌شوند.',
          style: Web.small.copyWith(color: Web.muted),
        ),
        const SizedBox(height: 8),
        if (c.daysOff.isEmpty)
          Text(
            'روزی اعلام نشده است.',
            key: const Key('ntc-dayoff-none'),
            style: Web.small.copyWith(color: Web.muted),
          ),
        for (final d in c.daysOff)
          Padding(
            key: Key('ntc-dayoff-${d.id}'),
            padding: const EdgeInsets.only(top: 6),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 6,
                        children: [
                          Text(Web.fa(Web.jdate(d.date)), style: Web.b),
                          WebBadge(
                            d.kind.labelFa,
                            tone: d.kind == DayOffKind.closed
                                ? WebTone.red
                                : WebTone.amber,
                          ),
                        ],
                      ),
                      Text(
                        '${d.reason}${d.examsTo == null ? '' : ' · امتحان‌ها به ${Web.fa(Web.jdate(d.examsTo))}'}',
                        style: Web.small,
                      ),
                    ],
                  ),
                ),
                WebBtn.delete(
                  'لغو',
                  key: Key('ntc-dayoff-cancel-${d.id}'),
                  onPressed: c.busy ? null : () => c.cancelDayOff(d.id),
                ),
              ],
            ),
          ),
      ],
    ),
  );

  Future<void> _openDayOff() async {
    c.dayOffError = null;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => DayOffEditor(controller: c)),
    );
  }

  Widget _card(Notice n) => WebCard(
    key: Key('ntc-card-${n.id}'),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text(n.title, style: Web.b)),
            // row 185: in a narrow column the badges wrap instead of overflowing
            if (n.queued)
              Flexible(
                child: Padding(
                  padding: const EdgeInsetsDirectional.only(end: 6),
                  child: WebBadge(
                    'در صف ارسال',
                    key: Key('ntc-queued-${n.id}'),
                    tone: WebTone.amber,
                  ),
                ),
              ),
            // the severity is the badge's colour, as on the web; its name is read aloud
            Semantics(
              key: Key('ntc-sev-${n.id}'),
              label: n.severity.labelFa,
              child: WebBadge(
                Web.fa(Web.jdate(n.date)),
                key: Key('ntc-date-${n.id}'),
                tone: switch (n.severity) {
                  NoticeSeverity.important => WebTone.red,
                  NoticeSeverity.info => WebTone.purple,
                  NoticeSeverity.normal => WebTone.none,
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        if (n.classId != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              '🏫 اطلاعیهٔ کلاس${c.className(n.classId).isEmpty ? '' : ' ${c.className(n.classId)}'}',
              key: Key('ntc-class-${n.id}'),
              style: TextStyle(fontSize: 12, color: Web.muted),
            ),
          ),
        Text(
          n.body,
          key: Key('ntc-body-${n.id}'),
          style: TextStyle(fontSize: 13.5, color: Web.ink, height: 1.6),
        ),
        if (c.canChange(n))
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: WebWrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                WebBtn(
                  'ویرایش',
                  key: Key('ntc-edit-${n.id}'),
                  kind: WebBtnKind.ghost,
                  onPressed: c.busy ? null : () => _openEditor(n),
                ),
                WebBtn.delete(
                  'حذف',
                  key: Key('ntc-delete-${n.id}'),
                  onPressed: c.busy ? null : () => _confirmDelete(n),
                ),
              ],
            ),
          ),
      ],
    ),
  );
}

/// Publish / edit form (web modal «اطلاعیهٔ جدید / ویرایش اطلاعیه»). Stays open with the typed
/// text when the board refuses; leaving with unsaved text asks first.
class NoticeEditor extends StatefulWidget {
  const NoticeEditor({super.key, required this.controller, this.editing});

  final NoticesController controller;
  final Notice? editing;

  @override
  State<NoticeEditor> createState() => _NoticeEditorState();
}

class _NoticeEditorState extends State<NoticeEditor> {
  late final TextEditingController title = TextEditingController(
    text: widget.editing?.title ?? '',
  );
  late final TextEditingController body = TextEditingController(
    text: widget.editing?.body ?? '',
  );
  late NoticeSeverity severity =
      widget.editing?.severity ?? NoticeSeverity.normal;

  /// Row 197 (F19): the class a notice is for — required for a teacher (their own classes
  /// only), optional for the manager (empty = the whole school).
  late int? classId =
      widget.editing?.classId ??
      (c.canWriteSchool || c.classes.length != 1 ? null : c.classes.first.id);

  NoticesController get c => widget.controller;

  bool get _dirty =>
      title.text != (widget.editing?.title ?? '') ||
      body.text != (widget.editing?.body ?? '') ||
      severity != (widget.editing?.severity ?? NoticeSeverity.normal);

  @override
  void dispose() {
    title.dispose();
    body.dispose();
    super.dispose();
  }

  Future<void> _leave() async {
    if (!_dirty) {
      Navigator.pop(context);
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تغییرات ذخیره نشده'),
        content: const Text(
          'متن این اطلاعیه ذخیره نشده است. بدون ذخیره خارج می‌شوید؟',
        ),
        actions: [
          TextButton(
            key: const Key('ntc-discard-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('ماندن'),
          ),
          FilledButton(
            key: const Key('ntc-discard-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('خروج بدون ذخیره'),
          ),
        ],
      ),
    );
    if (ok == true && mounted) Navigator.pop(context);
  }

  Future<void> _submit() async {
    final res = await c.submit(
      id: widget.editing?.id,
      title: title.text,
      body: body.text,
      severity: severity,
      classId: classId,
    );
    if (res != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.editing != null;
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
              key: const Key('ntc-editor-back'),
              tooltip: 'بازگشت',
              icon: backOrCloseIcon(context),
              onPressed: _leave,
            ),
            title: Text(editing ? 'ویرایش اطلاعیه' : 'اطلاعیهٔ جدید'),
          ),
          body: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space4),
            children: [
              if (c.formError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
                  child: Text(
                    c.formError!,
                    key: const Key('ntc-form-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (!editing && (!c.canWriteSchool || c.classes.isNotEmpty)) ...[
                FieldBox(
                  width: kFieldText,
                  child: DropdownButtonFormField<int?>(
                    key: const Key('ntc-class'),
                    initialValue: classId,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: c.canWriteSchool ? 'مخاطب' : 'کلاس',
                      border: const OutlineInputBorder(),
                      helperText: !c.canWriteSchool && c.classes.isEmpty
                          ? 'کلاسی در برنامهٔ هفتگی شما ثبت نشده است'
                          : null,
                    ),
                    items: [
                      if (c.canWriteSchool)
                        const DropdownMenuItem<int?>(
                          value: null,
                          child: Text('همهٔ مدرسه'),
                        ),
                      for (final k in c.classes)
                        DropdownMenuItem<int?>(
                          value: k.id,
                          child: Text(
                            SchoolRecords.str(k.data['name']),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: c.busy
                        ? null
                        : (v) => setState(() => classId = v),
                  ),
                ),
                const SizedBox(height: PayeshTokens.space3),
              ],
              FieldBox(
                width: kFieldWide,
                child: TextField(
                  key: const Key('ntc-title'),
                  controller: title,
                  enabled: !c.busy,
                  decoration: InputDecoration(
                    labelText: 'عنوان',
                    border: const OutlineInputBorder(),
                    errorText: fieldIssueFor(c.formError, 'عنوان', title.text),
                    errorMaxLines: 3,
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              const SizedBox(height: PayeshTokens.space3),
              TextField(
                key: const Key('ntc-body'),
                controller: body,
                enabled: !c.busy,
                minLines: 4,
                maxLines: 12,
                decoration: InputDecoration(
                  labelText: 'متن',
                  border: const OutlineInputBorder(),
                  errorText: fieldIssueFor(c.formError, 'متن', body.text),
                  errorMaxLines: 3,
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: PayeshTokens.space3),
              Text('اهمیت', style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: PayeshTokens.space1),
              SegmentedButton<NoticeSeverity>(
                key: const Key('ntc-severity'),
                segments: [
                  for (final s in NoticeSeverity.values)
                    ButtonSegment(
                      value: s,
                      label: Text(s.labelFa, key: Key('ntc-sev-opt-${s.wire}')),
                    ),
                ],
                selected: {severity},
                onSelectionChanged: c.busy
                    ? null
                    : (v) => setState(() => severity = v.first),
              ),
            ],
          ),
          bottomNavigationBar: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(PayeshTokens.space3),
              child: FilledButton.icon(
                key: const Key('ntc-submit'),
                onPressed: c.busy ? null : _submit,
                icon: const Icon(Icons.send_outlined),
                label: Text(editing ? 'ذخیرهٔ تغییرات' : 'انتشار'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Entry on the signed-in home: shown when the build ships the notices wave and the device
/// knows who the user is. Otherwise a short line says where notices live (the old web client)
/// — never a dead button. Every server role reads notices.
class NoticesEntry extends StatelessWidget {
  const NoticesEntry({
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
    if (role == null || !NoticeBoard.readers.contains(role)) {
      return const SizedBox.shrink(key: Key('ntc-entry-none'));
    }
    if (!enabled) {
      return const Text(
        'اطلاعیه‌ها فعلاً در نسخهٔ وب نمایش داده می‌شود.',
        key: Key('ntc-entry-legacy'),
      );
    }
    if (uid == null) {
      return const Text(
        'برای دیدن اطلاعیه‌ها یک بار به اینترنت وصل شوید.',
        key: Key('ntc-entry-wait'),
      );
    }
    return PayeshTile(
      key: const Key('ntc-entry'),
      onTap: open,
      icon: Icons.campaign_outlined,
      label: 'اطلاعیه‌ها',
      tone: PayeshTone.success,
    );
  }

  /// Row 165: true when this entry is a home tile (else a short note or nothing).
  bool get isTile =>
      role != null &&
      NoticeBoard.readers.contains(role) &&
      enabled &&
      uid != null;
}

/// Route that owns the page controller for one visit.
class NoticesRoute extends StatefulWidget {
  const NoticesRoute({
    super.key,
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    this.onRetry,
    this.now,
  });

  /// The app's clock (tests pin it): today / tomorrow for the day-off banners.
  final DateTime Function()? now;
  final NoticeSource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<NoticesRoute> createState() => _NoticesRouteState();
}

class _NoticesRouteState extends State<NoticesRoute> {
  late final NoticesController controller = NoticesController(
    source: widget.source,
    role: widget.role,
    uid: widget.uid,
  )..now = widget.now ?? DateTime.now;

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => NoticesScreen(
    controller: controller,
    sync: widget.sync,
    onRetry: widget.onRetry,
  );
}

/// Row 197 Q10: «امروز/فردا تعطیل یا غیرحضوری است» (web `dayOffBanner`).
Widget dayOffBanner(DayOff d, String key) => WebBanner(
  kind: WebBannerKind.warn,
  textKey: Key(key),
  text:
      '${d.kind == DayOffKind.closed ? '⛔' : '💻'} ${Web.fa(Web.jdate(d.date))} — ${d.kind.labelFa}: ${d.reason}\n'
      'در این روز غیبت و تأخیر ثبت نمی‌شود'
      '${d.kind == DayOffKind.remote ? '؛ حضور در کلاس مجازی را می‌توانید «حاضر» بزنید' : ''}.',
);

/// Row 197 Q10: the «اعلام تعطیلی / غیرحضوری» form (web modal `dayoff`) — tomorrow by
/// default (it is usually announced the evening before).
class DayOffEditor extends StatefulWidget {
  const DayOffEditor({super.key, required this.controller});
  final NoticesController controller;

  @override
  State<DayOffEditor> createState() => _DayOffEditorState();
}

class _DayOffEditorState extends State<DayOffEditor> {
  NoticesController get c => widget.controller;
  late String date = c.tomorrow;
  DayOffKind kind = DayOffKind.closed;
  final reason = TextEditingController();
  String examsTo = '';
  bool notify = true;

  @override
  void dispose() {
    reason.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final r = await c.announceDayOff(
      date: date,
      kind: kind,
      reason: reason.text,
      examsTo: examsTo.isEmpty ? null : examsTo,
      notify: notify,
    );
    if (r != null && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => Scaffold(
      backgroundColor: Web.bg,
      appBar: AppBar(
        leading: IconButton(
          key: const Key('dof-back'),
          tooltip: 'بازگشت',
          icon: backOrCloseIcon(context),
          onPressed: () => Navigator.maybePop(context),
        ),
        title: const Text('اعلام تعطیلی / غیرحضوری'),
      ),
      body: WebPageBody(
        children: [
          WebCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (c.dayOffError != null)
                  WebBanner(
                    kind: WebBannerKind.err,
                    text: c.dayOffError!,
                    textKey: const Key('dof-error'),
                  ),
                Text('روز', style: Web.small),
                WebJalaliField(
                  key: const Key('dof-date'),
                  iso: date,
                  onChanged: (v) => setState(() => date = v),
                ),
                const SizedBox(height: 10),
                Text('نوع', style: Web.small),
                Semantics(
                  label: 'نوع',
                  child: FieldBox(
                    child: DropdownButtonFormField<DayOffKind>(
                      key: const Key('dof-kind'),
                      initialValue: kind,
                      isExpanded: true,
                      decoration: webInput(),
                      items: const [
                        DropdownMenuItem(
                          value: DayOffKind.closed,
                          child: Text('تعطیل — مدرسه بسته است'),
                        ),
                        DropdownMenuItem(
                          value: DayOffKind.remote,
                          child: Text('غیرحضوری — آموزش مجازی'),
                        ),
                      ],
                      onChanged: (v) => setState(() => kind = v ?? kind),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Text('علت (در اطلاعیهٔ اولیا می‌آید)', style: Web.small),
                Semantics(
                  label: 'علت',
                  child: FieldBox(
                    child: TextField(
                      key: const Key('dof-reason'),
                      controller: reason,
                      maxLength: 300,
                      decoration: webInput(
                        hint: 'مثلاً آلودگی هوا به اعلام استانداری',
                      ),
                    ),
                  ),
                ),
                Text(
                  'امتحان‌های داخلی این روز منتقل شوند به (اختیاری)',
                  style: Web.small,
                ),
                WebJalaliField(
                  key: const Key('dof-exams-to'),
                  iso: examsTo,
                  onChanged: (v) => setState(() => examsTo = v),
                ),
                const SizedBox(height: 6),
                // a plain row (a ListTile would paint under the card's colour)
                InkWell(
                  onTap: () => setState(() => notify = !notify),
                  child: Row(
                    children: [
                      Checkbox(
                        key: const Key('dof-notify'),
                        value: notify,
                        onChanged: (v) => setState(() => notify = v ?? true),
                      ),
                      Expanded(
                        child: Text(
                          'اطلاعیهٔ «مهم» برای همهٔ اولیا و دانش‌آموزان منتشر شود',
                          style: Web.small.copyWith(color: Web.ink),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                WebBtn(
                  'ثبت و اعلام',
                  key: const Key('dof-submit'),
                  kind: WebBtnKind.primary,
                  onPressed: c.busy ? null : _submit,
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// Row 197 Q10: «امروز/فردا تعطیل یا غیرحضوری است» at the top of everyone's home (web
/// `PAGES.home`). Nothing is drawn when no day off is announced.
class HomeDayOff extends StatefulWidget {
  const HomeDayOff({
    super.key,
    required this.source,
    required this.role,
    required this.uid,
    this.now,
  });
  final NoticeSource source;
  final String role;
  final int uid;
  final DateTime Function()? now;

  @override
  State<HomeDayOff> createState() => _HomeDayOffState();
}

class _HomeDayOffState extends State<HomeDayOff> {
  late final NoticesController c = NoticesController(
    source: widget.source,
    role: widget.role,
    uid: widget.uid,
  )..now = widget.now ?? DateTime.now;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => Column(
      key: const Key('home-dayoff'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (c.todayOff case final d?) dayOffBanner(d, 'home-dayoff-today'),
        if (c.tomorrowOff case final d?)
          dayOffBanner(d, 'home-dayoff-tomorrow'),
      ],
    ),
  );
}
