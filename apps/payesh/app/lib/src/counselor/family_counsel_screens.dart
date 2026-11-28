// Row 197 (Q12 / F27, F29) — native `#/pmsgs` «پیام اولیا / پیام و وقت ملاقات», `#/cstudents`
// «دانش‌آموزان» (the counselor's desk) and `#/cstudent/<id>` (read-only record + the
// counselor's notes). Web: client/pages.js PAGES.pmsgs / cstudents / cstudent.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';
import '../users/users_screen.dart' show disciplineCard;

WebTone _statusTone(String s) => switch (s) {
  'open' => WebTone.amber,
  'answered' || 'scheduled' => WebTone.green,
  _ => WebTone.none,
};

String _apptLine(ParentMsg m) => m.apptDate.isEmpty
    ? ''
    : '📅 ${Web.fa(Web.jdate(m.apptDate))}${m.apptTime.isEmpty ? '' : ' ساعت ${Web.fa(m.apptTime)}'}';

/// One thread line — shared by the inbox and the parent's child page.
Widget pmsgItem(
  ParentMsg m, {
  bool showStudent = false,
  List<Widget> actions = const [],
}) => WebCard.tight(
  key: Key('pm-row-${m.id}'),
  child: WebItem(
    title: [
      if (showStudent)
        m.studentName.isEmpty
            ? 'دانش‌آموز ${Web.fa(m.studentId ?? 0)}'
            : m.studentName,
      '${msgKindFa[m.kind] ?? ''} ← ${m.toLabel}',
    ].join(' · '),
    titleTrailing: [
      WebBadge(
        msgStatusFa[m.status] ?? m.status,
        key: Key('pm-status-${m.id}'),
        tone: _statusTone(m.status),
      ),
    ],
    sub: [
      if (m.text.isNotEmpty) m.text,
      if (m.wantDate.isNotEmpty)
        'زمان پیشنهادی: ${Web.fa(Web.jdate(m.wantDate))}',
      if (m.reply.isNotEmpty) '↩ ${m.reply}',
      if (m.apptDate.isNotEmpty) _apptLine(m),
    ].join('\n'),
    actions: actions,
  ),
);

// ───────────────────────────── inbox (#/pmsgs) ─────────────────────────────

class PmsgsController extends SchoolController {
  PmsgsController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<ParentMsg> msgs = const [];
  List<CounselStudent> students = const [];
  bool canAnswer = false;
  bool canBook = false;

  int get openCount => msgs.where((m) => m.open).length;

  @override
  Future<void> read(SchoolRecords db) async {
    final pm = ParentMessages(db);
    canAnswer = pm.canAnswer;
    canBook = pm.canBook;
    msgs = await pm.list();
    students = canBook ? await CounselorDesk(db).students() : const [];
  }

  Future<bool> answer(
    ParentMsg m, {
    required String reply,
    required String status,
    String apptDate = '',
    String apptTime = '',
  }) async =>
      await run(
        (db) => ParentMessages(db).answer(
          m.id,
          reply: reply,
          status: status,
          apptDate: apptDate,
          apptTime: apptTime,
        ),
        form: true,
      ) !=
      null;

  Future<bool> book({
    required int? studentId,
    required String apptDate,
    String apptTime = '',
    required String text,
  }) async {
    if (studentId == null) {
      formError = 'دانش‌آموز را انتخاب کنید';
      emit();
      return false;
    }
    return await run(
          (db) => ParentMessages(db).book(
            studentId: studentId,
            apptDate: apptDate,
            apptTime: apptTime,
            text: text,
          ),
          form: true,
        ) !=
        null;
  }
}

class PmsgsScreen extends StatefulWidget {
  const PmsgsScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final PmsgsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<PmsgsScreen> createState() => _PmsgsScreenState();
}

class _PmsgsScreenState extends State<PmsgsScreen> {
  PmsgsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _reply(ParentMsg m) async {
    c.clearForm();
    await openPanel<void>(context, (_) => PmsgReplyForm(controller: c, msg: m));
  }

  Future<void> _book() async {
    c.clearForm();
    await openPanel<void>(context, (_) => PmsgBookForm(controller: c));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'pm',
      title: c.role == 'counselor' ? 'پیام و وقت ملاقات' : 'پیام اولیا',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: '${Web.fa(c.openCount)} پیامِ بی‌پاسخ',
      subKey: const Key('pm-count'),
      headActions: [
        if (c.canBook)
          WebBtn(
            '+ تعیین وقت برای اولیا',
            key: const Key('pm-book'),
            kind: WebBtnKind.primary,
            onPressed: _book,
          ),
      ],
      children: [
        if (c.msgs.isEmpty)
          WebEmpty(
            c.role == 'teacher'
                ? 'پیامی از اولیا برای شما نیامده است.'
                : 'پیامی نیامده است.',
            key: const Key('pm-empty'),
          )
        else
          for (final m in c.msgs)
            pmsgItem(
              m,
              showStudent: true,
              actions: [
                if (c.canAnswer && m.status != 'closed')
                  WebBtn(
                    m.open ? 'پاسخ' : 'ویرایش پاسخ',
                    key: Key('pm-reply-${m.id}'),
                    kind: m.open ? WebBtnKind.primary : WebBtnKind.normal,
                    onPressed: () => _reply(m),
                  ),
              ],
            ),
      ],
    ),
  );
}

InputDecoration _dec(String label) =>
    InputDecoration(labelText: label, border: const OutlineInputBorder());

/// «پاسخ» — the recipient answers: reply text, status and (appointments) the day and hour.
class PmsgReplyForm extends StatefulWidget {
  const PmsgReplyForm({super.key, required this.controller, required this.msg});
  final PmsgsController controller;
  final ParentMsg msg;

  @override
  State<PmsgReplyForm> createState() => _PmsgReplyFormState();
}

class _PmsgReplyFormState extends State<PmsgReplyForm> {
  late final reply = TextEditingController(text: widget.msg.reply);
  late final time = TextEditingController(text: widget.msg.apptTime);
  late String status = widget.msg.open ? 'answered' : widget.msg.status;
  late String? date = widget.msg.apptDate.isEmpty ? null : widget.msg.apptDate;

  /// scheduled: an appointment, set by the counselor or the manager (server policy.js).
  bool get canSched =>
      widget.msg.isAppointment &&
      (widget.controller.role == 'counselor' ||
          widget.controller.role == 'manager');

  @override
  void dispose() {
    reply.dispose();
    time.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.answer(
      widget.msg,
      reply: reply.text,
      status: status,
      apptDate: status == 'scheduled' ? (date ?? '') : '',
      apptTime: status == 'scheduled' ? time.text.trim() : '',
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final statuses = ['answered', if (canSched) 'scheduled', 'closed'];
    if (!statuses.contains(status)) status = 'answered';
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'pmr',
        title:
            'پاسخ به ${widget.msg.studentName.isEmpty ? 'ولی' : 'ولیِ ${widget.msg.studentName}'}',
        controller: c,
        submitLabel: 'ثبت پاسخ',
        onSubmit: _save,
        fields: [
          if (widget.msg.text.isNotEmpty)
            Text(
              widget.msg.text,
              key: const Key('pmr-text'),
              style: Web.small.copyWith(color: Web.ink),
            ),
          FieldBox(
            width: kFieldText,
            child: TextField(
              key: const Key('pmr-reply'),
              controller: reply,
              maxLines: 4,
              maxLength: msgReplyMax,
              decoration: _dec('پاسخ'),
            ),
          ),
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<String>(
              isExpanded: true,
              key: const Key('pmr-status'),
              initialValue: status,
              decoration: _dec('وضعیت'),
              items: [
                for (final s in statuses)
                  DropdownMenuItem(value: s, child: Text(msgStatusFa[s] ?? s)),
              ],
              onChanged: (v) => setState(() => status = v ?? 'answered'),
            ),
          ),
          if (status == 'scheduled') ...[
            WebJalaliField(
              key: const Key('pmr-date'),
              iso: date,
              onChanged: (v) => date = v,
            ),
            FieldBox(
              width: 140,
              child: TextField(
                key: const Key('pmr-time'),
                controller: time,
                textDirection: TextDirection.ltr,
                decoration: _dec('ساعت (۱۰:۳۰)'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// «تعیین وقت برای اولیا» — the counselor sets an appointment for a student's parents.
class PmsgBookForm extends StatefulWidget {
  const PmsgBookForm({super.key, required this.controller, this.studentId});
  final PmsgsController controller;
  final int? studentId;

  @override
  State<PmsgBookForm> createState() => _PmsgBookFormState();
}

class _PmsgBookFormState extends State<PmsgBookForm> {
  late int? student = widget.studentId;
  String? date;
  final time = TextEditingController();
  final text = TextEditingController();

  @override
  void dispose() {
    time.dispose();
    text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.book(
      studentId: student,
      apptDate: date ?? '',
      apptTime: time.text.trim(),
      text: text.text,
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'pmb',
        title: 'تعیین وقت برای اولیا',
        controller: c,
        submitLabel: 'ثبت وقت',
        onSubmit: _save,
        fields: [
          if (widget.studentId == null)
            FieldBox(
              width: kFieldText,
              child: DropdownButtonFormField<int?>(
                isExpanded: true,
                key: const Key('pmb-student'),
                initialValue: student,
                decoration: _dec('دانش‌آموز'),
                items: [
                  const DropdownMenuItem<int?>(value: null, child: Text('—')),
                  for (final s in c.students)
                    DropdownMenuItem<int?>(value: s.id, child: Text(s.name)),
                ],
                onChanged: (v) => setState(() => student = v),
              ),
            ),
          WebJalaliField(
            key: const Key('pmb-date'),
            iso: date,
            onChanged: (v) => date = v,
          ),
          FieldBox(
            width: 140,
            child: TextField(
              key: const Key('pmb-time'),
              controller: time,
              textDirection: TextDirection.ltr,
              decoration: _dec('ساعت (۱۰:۳۰)'),
            ),
          ),
          FieldBox(
            width: kFieldText,
            child: TextField(
              key: const Key('pmb-text'),
              controller: text,
              maxLines: 3,
              maxLength: msgTextMax,
              decoration: _dec('موضوع جلسه'),
            ),
          ),
        ],
      ),
    );
  }
}

// ───────────────────────────── desk (#/cstudents) ─────────────────────────────

class CstudentsController extends SchoolController {
  CstudentsController({
    required super.source,
    required super.role,
    required super.uid,
  });

  String query = '';
  List<CounselStudent> students = const [];

  @override
  Future<void> read(SchoolRecords db) async {
    students = await CounselorDesk(db).students(query: query);
  }

  Future<void> search(String q) async {
    query = q;
    final d = db;
    if (d == null) return;
    students = await CounselorDesk(d).students(query: q);
    emit();
  }
}

class CstudentsScreen extends StatefulWidget {
  const CstudentsScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final CstudentsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<CstudentsScreen> createState() => _CstudentsScreenState();
}

class _CstudentsScreenState extends State<CstudentsScreen> {
  CstudentsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  void _open(CounselStudent s) => openPanel<void>(
    context,
    (_) => SchoolOwned(
      create: () => CstudentController(
        source: c.source,
        role: c.role,
        uid: c.uid,
        studentId: s.id,
      ),
      page: (x) => CstudentScreen(
        controller: x as CstudentController,
        sync: widget.sync,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'cst',
      title: 'دانش‌آموزان',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: '${Web.fa(c.students.length)} نفر',
      subKey: const Key('cst-count'),
      children: [
        WebCard.tight(
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: FieldBox(
              width: kFieldSearch,
              child: TextField(
                key: const Key('cst-search'),
                decoration: webInput(hint: 'جستجوی نام…'),
                onChanged: c.search,
              ),
            ),
          ),
        ),
        if (c.students.isEmpty)
          const WebEmpty('دانش‌آموزی پیدا نشد.', key: Key('cst-empty'))
        else
          for (final s in c.students.take(300))
            WebCard.tight(
              key: Key('cst-row-${s.id}'),
              child: WebItem(
                title: s.name,
                titleColor: Web.primary,
                sub: s.cohort,
                onTap: () => _open(s),
              ),
            ),
      ],
    ),
  );
}

// ───────────────────────────── one student (#/cstudent/<id>) ─────────────────────────────

class CstudentController extends SchoolController {
  CstudentController({
    required super.source,
    required super.role,
    required super.uid,
    required this.studentId,
  });

  final int studentId;
  StudentRecord? record;
  List<CounselNote> notes = const [];
  bool get isCounselor => role == 'counselor';

  @override
  Future<void> read(SchoolRecords db) async {
    record = await UserDirectory(db).recordOf(studentId);
    notes = isCounselor ? await CounselorDesk(db).notesOf(studentId) : const [];
  }

  Future<bool> addNote({
    required String kind,
    required String text,
    String track = '',
  }) async =>
      await run(
        (db) => CounselorDesk(
          db,
        ).addNote(studentId: studentId, kind: kind, text: text, track: track),
        form: true,
      ) !=
      null;

  Future<bool> book({
    required String apptDate,
    String apptTime = '',
    required String text,
  }) async =>
      await run(
        (db) => ParentMessages(db).book(
          studentId: studentId,
          apptDate: apptDate,
          apptTime: apptTime,
          text: text,
        ),
        form: true,
      ) !=
      null;
}

class CstudentScreen extends StatefulWidget {
  const CstudentScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final CstudentController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<CstudentScreen> createState() => _CstudentScreenState();
}

class _CstudentScreenState extends State<CstudentScreen> {
  CstudentController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _note() async {
    c.clearForm();
    await openPanel<void>(context, (_) => CnoteForm(controller: c));
  }

  Future<void> _book() async {
    c.clearForm();
    await openPanel<void>(context, (_) => _CstudentBookForm(controller: c));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final r = c.record;
      return SchoolPage(
        prefix: 'cs',
        title: r?.user.name ?? 'پرونده',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub: r?.className,
        subKey: const Key('cs-class'),
        children: [
          if (r != null) ...[
            WebGrid(
              children: [
                WebStat(
                  icon: 'check',
                  num: r.hasAttendance ? '${Web.fa(r.presentPercent)}٪' : '—',
                  label: 'حضور',
                  numKey: const Key('cs-present'),
                ),
                WebStat(
                  icon: 'chart',
                  num: r.average == null
                      ? '—'
                      : Web.fa(
                          r.average!.toStringAsFixed(1).replaceAll('.', '٫'),
                        ),
                  label: 'معدل',
                  numKey: const Key('cs-average'),
                ),
              ],
            ),
            WebCard(
              key: const Key('cs-report-card'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text('کارنامه', style: Web.b),
                  ),
                  WebTable(
                    head: const ['عنوان درس', 'میانگین / ارزشیابی'],
                    empty: r.reportCard.isEmpty
                        ? Text(
                            'هنوز نمره‌ای ثبت نشده.',
                            style: TextStyle(color: Web.muted),
                          )
                        : null,
                    rows: [
                      for (final (subject, value) in r.reportCard)
                        [
                          Text(subject),
                          Text(
                            value,
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                        ],
                    ],
                  ),
                ],
              ),
            ),
            disciplineCard(
              r.discipline,
              key: const Key('cs-discipline'),
              keyPrefix: 'cs-disc',
            ),
          ],
          if (c.isCounselor)
            WebCard(
              key: const Key('cs-notes'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        '🗂️ یادداشت‌های مشاوره (فقط شما می‌بینید)',
                        style: Web.b,
                      ),
                      WebBtn(
                        '📅 وقت برای اولیا',
                        key: const Key('cs-book'),
                        onPressed: _book,
                      ),
                      WebBtn(
                        '+ یادداشت',
                        key: const Key('cs-note-add'),
                        kind: WebBtnKind.primary,
                        onPressed: _note,
                      ),
                    ],
                  ),
                  if (c.notes.isEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        'یادداشتی ثبت نشده.',
                        key: const Key('cs-notes-none'),
                        style: Web.small.copyWith(color: Web.muted),
                      ),
                    ),
                  for (final n in c.notes)
                    Padding(
                      key: Key('cs-note-${n.id}'),
                      padding: const EdgeInsets.only(top: 8),
                      child: WebItem(
                        title: [
                          noteKindFa[n.kind] ?? '',
                          if (n.track.isNotEmpty) 'رشتهٔ پیشنهادی: ${n.track}',
                        ].join(' · '),
                        titleTrailing: [
                          WebBadge(
                            Web.fa(Web.jdate(n.date)),
                            tone: WebTone.none,
                          ),
                        ],
                        sub: n.text,
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

/// «یادداشت مشاوره» — a session note or an educational-guidance note with the suggested track.
class CnoteForm extends StatefulWidget {
  const CnoteForm({super.key, required this.controller});
  final CstudentController controller;

  @override
  State<CnoteForm> createState() => _CnoteFormState();
}

class _CnoteFormState extends State<CnoteForm> {
  String kind = 'session';
  String? track;
  final text = TextEditingController();

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.addNote(
      kind: kind,
      text: text.text,
      track: kind == 'guidance' ? (track ?? '') : '',
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'csn',
        title: 'یادداشت مشاوره',
        controller: c,
        submitLabel: 'ثبت',
        onSubmit: _save,
        fields: [
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<String>(
              isExpanded: true,
              key: const Key('csn-kind'),
              initialValue: kind,
              decoration: _dec('نوع'),
              items: [
                for (final k in noteKinds)
                  DropdownMenuItem(value: k, child: Text(noteKindFa[k] ?? k)),
              ],
              onChanged: (v) => setState(() => kind = v ?? 'session'),
            ),
          ),
          if (kind == 'guidance')
            FieldBox(
              width: kFieldText,
              child: DropdownButtonFormField<String?>(
                isExpanded: true,
                key: const Key('csn-track'),
                initialValue: track,
                decoration: _dec('رشتهٔ پیشنهادی'),
                items: [
                  const DropdownMenuItem<String?>(
                    value: null,
                    child: Text('—'),
                  ),
                  for (final t in guidanceTracks)
                    DropdownMenuItem<String?>(value: t, child: Text(t)),
                ],
                onChanged: (v) => setState(() => track = v),
              ),
            ),
          FieldBox(
            width: kFieldText,
            child: TextField(
              key: const Key('csn-text'),
              controller: text,
              maxLines: 5,
              maxLength: noteTextMax,
              decoration: _dec('شرح'),
            ),
          ),
        ],
      ),
    );
  }
}

class _CstudentBookForm extends StatefulWidget {
  const _CstudentBookForm({required this.controller});
  final CstudentController controller;

  @override
  State<_CstudentBookForm> createState() => _CstudentBookFormState();
}

class _CstudentBookFormState extends State<_CstudentBookForm> {
  String? date;
  final time = TextEditingController();
  final text = TextEditingController();

  @override
  void dispose() {
    time.dispose();
    text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.book(
      apptDate: date ?? '',
      apptTime: time.text.trim(),
      text: text.text,
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'csb',
        title: 'تعیین وقت برای اولیا',
        controller: c,
        submitLabel: 'ثبت وقت',
        onSubmit: _save,
        fields: [
          WebJalaliField(
            key: const Key('csb-date'),
            iso: date,
            onChanged: (v) => date = v,
          ),
          FieldBox(
            width: 140,
            child: TextField(
              key: const Key('csb-time'),
              controller: time,
              textDirection: TextDirection.ltr,
              decoration: _dec('ساعت (۱۰:۳۰)'),
            ),
          ),
          FieldBox(
            width: kFieldText,
            child: TextField(
              key: const Key('csb-text'),
              controller: text,
              maxLines: 3,
              maxLength: msgTextMax,
              decoration: _dec('موضوع جلسه'),
            ),
          ),
        ],
      ),
    );
  }
}
