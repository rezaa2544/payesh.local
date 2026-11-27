// Row 197 (Q07 / F32, F33) — «کمک‌های مردمی» and «هیئت امنا», the manager's two pages.
//
// A public school (every type except غیرانتفاعی) records VOLUNTARY contributions only — never a
// mandatory tuition (the 1405 directive) — and keeps its board of trustees: members and meetings
// with their resolutions. A غیرانتفاعی school with «شهریه» on may also record tuition. Which page
// shows is decided by the school type and its capabilities (payesh_ui `schoolFeatures`).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../family/family_controller.dart' show jalaliToIso;
import '../pulse/web.dart';
import '../school/school_source.dart';

/// «۱۲٬۰۰۰٬۰۰۰ ریال».
String rialsFa(int v) => '${faNumber(v)} ریال';

/// ISO day → «۱۴۰۵/۰۹/۰۶» (or the raw text).
String isoDayFa(String iso) =>
    JalaliDate.fromIso(iso)?.formatShort() ?? Web.fa(iso);

String _todayJalali() => JalaliDate.fromDateTime(DateTime.now()).slash;

// ─── «کمک‌های مردمی» ───────────────────────────────────────────────────────────────────────────

class ContributionsController extends SchoolController {
  ContributionsController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<ContributionRow> rows = const [];
  Map<String, Object?>? school;
  Map<int, String> students = const {};

  bool get tuition => tuitionOn(school);
  bool get publicSchool => isPublicSchool(school);
  int get voluntaryTotal =>
      rows.where((r) => !r.tuition).fold(0, (a, r) => a + r.amount);
  int get tuitionTotal =>
      rows.where((r) => r.tuition).fold(0, (a, r) => a + r.amount);

  @override
  Future<void> read(SchoolRecords db) async {
    final f = FinanceBook(db);
    school = await f.school();
    rows = await f.contributionList();
    students = {
      for (final u in await db.allOrEmpty('users'))
        if (SchoolRecords.str(u.data['role']) == 'student')
          u.id: SchoolRecords.str(u.data['name']),
    };
  }

  Future<bool> add({
    required String payer,
    required String amount,
    required String date,
    bool tuition = false,
    String purpose = '',
    String receiptNo = '',
    String note = '',
  }) async {
    final iso = jalaliToIso(date);
    final rials = int.tryParse(SchoolRecords.digitsOnly(amount));
    String? bad;
    if (payer.trim().isEmpty) bad = financeIssueFa['payer'];
    if (bad == null && (rials == null || rials <= 0)) {
      bad = financeIssueFa['amount'];
    }
    if (bad == null && iso == null) bad = 'تاریخ را مثل ۱۴۰۵/۰۹/۰۶ بنویسید';
    if (bad != null) {
      formError = bad;
      emit();
      return false;
    }
    final r = await run(
      (db) => FinanceBook(db).addContribution(
        payer: payer,
        amount: rials!,
        date: iso!,
        tuition: tuition,
        purpose: purpose,
        receiptNo: receiptNo,
        note: note,
      ),
      form: true,
    );
    return r != null;
  }

  Future<void> remove(ContributionRow r) =>
      run((db) => FinanceBook(db).remove(FinanceBook.contributions, r.row));
}

class ContributionsScreen extends StatefulWidget {
  const ContributionsScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final ContributionsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<ContributionsScreen> createState() => _ContributionsScreenState();
}

class _ContributionsScreenState extends State<ContributionsScreen> {
  ContributionsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _add() async {
    c.clearForm();
    await openPanel<void>(context, (_) => _ContributionForm(controller: c));
  }

  Future<void> _remove(ContributionRow r) async {
    final ok = await confirmAction(
      context,
      prefix: 'fin',
      title: 'حذف ردیف',
      message: '«${r.payer}» — ${rialsFa(r.amount)} حذف شود؟',
    );
    if (ok) await c.remove(r);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'fin',
      title: c.tuition ? 'کمک‌ها و شهریه' : 'کمک‌های مردمی',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: [
        'کمک داوطلبانه: ${rialsFa(c.voluntaryTotal)}',
        if (c.tuition || c.tuitionTotal > 0)
          'شهریه: ${rialsFa(c.tuitionTotal)}',
        '${Web.fa(c.rows.length)} ردیف',
      ].join(' · '),
      subKey: const Key('fin-total'),
      headActions: [
        WebBtn(
          c.tuition ? '+ ثبت کمک یا شهریه' : '+ ثبت کمک داوطلبانه',
          key: const Key('fin-add'),
          kind: WebBtnKind.primary,
          onPressed: _add,
        ),
      ],
      children: [
        if (c.publicSchool)
          const WebCard.tight(
            key: Key('fin-public-note'),
            child: WebItem(
              title: 'مدرسهٔ دولتی شهریهٔ اجباری ندارد',
              sub: 'طبق بخشنامهٔ ۱۴۰۵ دریافت شهریه در مدارس دولتی (از جمله نمونه دولتی و شاهد) ممنوع است. آنچه خانواده‌ها یا خیّران می‌دهند «کمک داوطلبانه» است: مبلغ ثابت ندارد، شرط ثبت‌نام نیست و با رسید ثبت می‌شود.',
            ),
          ),
        if (c.rows.isEmpty)
          const WebEmpty('هنوز کمکی ثبت نشده است.', key: Key('fin-empty'))
        else
          for (final r in c.rows)
            WebCard.tight(
              key: Key('fin-row-${r.id}'),
              child: WebItem(
                title: '${r.payer} — ${rialsFa(r.amount)}',
                titleTrailing: [
                  WebBadge(
                    r.tuition ? 'شهریه' : 'کمک داوطلبانه',
                    tone: r.tuition ? WebTone.amber : WebTone.green,
                  ),
                  if (r.queued) const WebBadge('در صف ارسال'),
                ],
                sub: [
                  isoDayFa(r.date),
                  if (r.purpose.isNotEmpty) 'بابت: ${r.purpose}',
                  if (r.studentId != null &&
                      (c.students[r.studentId] ?? '').isNotEmpty)
                    'دانش‌آموز: ${c.students[r.studentId]}',
                  if (r.receiptNo.isNotEmpty) 'رسید: ${Web.fa(r.receiptNo)}',
                  if (r.note.isNotEmpty) r.note,
                ].join('\n'),
                actions: [
                  WebBtn(
                    'حذف',
                    key: Key('fin-del-${r.id}'),
                    kind: WebBtnKind.danger,
                    size: WebBtnSize.sm,
                    onPressed: () => _remove(r),
                  ),
                ],
              ),
            ),
      ],
    ),
  );
}

class _ContributionForm extends StatefulWidget {
  const _ContributionForm({required this.controller});
  final ContributionsController controller;

  @override
  State<_ContributionForm> createState() => _ContributionFormState();
}

class _ContributionFormState extends State<_ContributionForm> {
  final payer = TextEditingController();
  final amount = TextEditingController();
  final date = TextEditingController(text: _todayJalali());
  final purpose = TextEditingController();
  final receipt = TextEditingController();
  final note = TextEditingController();
  bool tuition = false;

  @override
  void dispose() {
    for (final x in [payer, amount, date, purpose, receipt, note]) {
      x.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.add(
      payer: payer.text,
      amount: amount.text,
      date: date.text,
      tuition: tuition && widget.controller.tuition,
      purpose: purpose.text,
      receiptNo: receipt.text,
      note: note.text,
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'fin',
        title: tuition ? 'ثبت شهریه' : 'ثبت کمک داوطلبانه',
        controller: c,
        submitLabel: 'ثبت',
        onSubmit: _save,
        fields: [
          if (c.tuition)
            CheckboxListTile(
              key: const Key('fin-f-tuition'),
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: tuition,
              title: const Text('شهریه (مدرسهٔ غیرانتفاعی)'),
              onChanged: (v) => setState(() => tuition = v == true),
            ),
          SchoolField('fin-f-payer', 'پرداخت‌کننده (ولی، خیّر، …) *', payer),
          SchoolField('fin-f-amount', 'مبلغ (ریال) *', amount, numeric: true),
          SchoolField('fin-f-date', 'تاریخ *', date),
          SchoolField('fin-f-purpose', 'بابت (مثلاً خرید پروژکتور)', purpose),
          SchoolField('fin-f-receipt', 'شمارهٔ رسید', receipt),
          SchoolField('fin-f-note', 'یادداشت', note, lines: 2),
        ],
      ),
    );
  }
}

// ─── «هیئت امنا» ────────────────────────────────────────────────────────────────────────────────

class TrusteesController extends SchoolController {
  TrusteesController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<TrusteeRow> members = const [];
  List<TrusteeRow> meetings = const [];

  @override
  Future<void> read(SchoolRecords db) async {
    final b = await FinanceBook(db).board();
    members = b.members;
    meetings = b.meetings;
  }

  Future<bool> addMember({
    required String name,
    required String post,
    String phone = '',
  }) async {
    if (name.trim().isEmpty) {
      formError = financeIssueFa['member_name'];
      emit();
      return false;
    }
    final r = await run(
      (db) => FinanceBook(db).addMember(name: name, post: post, phone: phone),
      form: true,
    );
    return r != null;
  }

  Future<bool> addMeeting({
    required String date,
    required String title,
    String decisions = '',
  }) async {
    final iso = jalaliToIso(date);
    if (title.trim().isEmpty || iso == null) {
      formError = title.trim().isEmpty
          ? financeIssueFa['meeting_title']
          : 'تاریخ را مثل ۱۴۰۵/۰۹/۰۶ بنویسید';
      emit();
      return false;
    }
    final r = await run(
      (db) =>
          FinanceBook(db)
              .addMeeting(date: iso, title: title, decisions: decisions),
      form: true,
    );
    return r != null;
  }

  Future<void> remove(TrusteeRow t) =>
      run((db) => FinanceBook(db).remove(FinanceBook.trustees, t.row));
}

class TrusteesScreen extends StatefulWidget {
  const TrusteesScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final TrusteesController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<TrusteesScreen> createState() => _TrusteesScreenState();
}

class _TrusteesScreenState extends State<TrusteesScreen> {
  TrusteesController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _remove(TrusteeRow t) async {
    final ok = await confirmAction(
      context,
      prefix: 'board',
      title: 'حذف',
      message: t.isMeeting
          ? 'جلسهٔ «${t.title}» حذف شود؟'
          : '«${t.name}» از هیئت امنا حذف شود؟',
    );
    if (ok) await c.remove(t);
  }

  Widget _del(TrusteeRow t) => WebBtn(
    'حذف',
    key: Key('board-del-${t.id}'),
    kind: WebBtnKind.danger,
    size: WebBtnSize.sm,
    onPressed: () => _remove(t),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'board',
      title: 'هیئت امنا',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub:
          '${Web.fa(c.members.length)} عضو · ${Web.fa(c.meetings.length)} جلسه',
      subKey: const Key('board-count'),
      headActions: [
        WebBtn(
          '+ عضو',
          key: const Key('board-add-member'),
          onPressed: () {
            c.clearForm();
            openPanel<void>(context, (_) => _MemberForm(controller: c));
          },
        ),
        WebBtn(
          '+ جلسه و مصوبه',
          key: const Key('board-add-meeting'),
          kind: WebBtnKind.primary,
          onPressed: () {
            c.clearForm();
            openPanel<void>(context, (_) => _MeetingForm(controller: c));
          },
        ),
      ],
      children: [
        const WebCardHead(
          key: Key('board-members-head'),
          icon: '👥',
          title: 'اعضای هیئت امنا',
        ),
        if (c.members.isEmpty)
          const WebEmpty(
            'هنوز عضوی ثبت نشده است.',
            key: Key('board-members-empty'),
          )
        else
          for (final m in c.members)
            WebCard.tight(
              key: Key('board-member-${m.id}'),
              child: WebItem(
                title: m.name,
                titleTrailing: [
                  WebBadge(m.post, tone: WebTone.purple),
                  if (m.queued) const WebBadge('در صف ارسال'),
                ],
                sub: m.phone.isEmpty ? null : Web.fa(m.phone),
                actions: [_del(m)],
              ),
            ),
        const WebCardHead(
          key: Key('board-meetings-head'),
          icon: '📝',
          title: 'جلسه‌ها و مصوبه‌ها',
        ),
        if (c.meetings.isEmpty)
          const WebEmpty(
            'هنوز جلسه‌ای ثبت نشده است.',
            key: Key('board-meetings-empty'),
          )
        else
          for (final m in c.meetings)
            WebCard.tight(
              key: Key('board-meeting-${m.id}'),
              child: WebItem(
                title: m.title,
                titleTrailing: [
                  WebBadge(isoDayFa(m.date)),
                  if (m.queued) const WebBadge('در صف ارسال'),
                ],
                sub: m.decisions.isEmpty ? null : m.decisions,
                actions: [_del(m)],
              ),
            ),
      ],
    ),
  );
}

class _MemberForm extends StatefulWidget {
  const _MemberForm({required this.controller});
  final TrusteesController controller;

  @override
  State<_MemberForm> createState() => _MemberFormState();
}

class _MemberFormState extends State<_MemberForm> {
  final name = TextEditingController();
  final phone = TextEditingController();
  String post = 'عضو';

  @override
  void dispose() {
    name.dispose();
    phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.addMember(
      name: name.text,
      post: post,
      phone: phone.text,
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'board',
        title: 'عضو هیئت امنا',
        controller: c,
        submitLabel: 'افزودن',
        onSubmit: _save,
        fields: [
          SchoolField('board-f-name', 'نام و نام خانوادگی *', name),
          FieldBox(
            child: DropdownButtonFormField<String>(
              key: const Key('board-f-post'),
              initialValue: post,
              decoration: const InputDecoration(labelText: 'سمت'),
              items: [
                for (final p in trusteePosts)
                  DropdownMenuItem(value: p, child: Text(p)),
              ],
              onChanged: (v) => setState(() => post = v ?? 'عضو'),
            ),
          ),
          SchoolField('board-f-phone', 'شمارهٔ تماس', phone, numeric: true),
        ],
      ),
    );
  }
}

class _MeetingForm extends StatefulWidget {
  const _MeetingForm({required this.controller});
  final TrusteesController controller;

  @override
  State<_MeetingForm> createState() => _MeetingFormState();
}

class _MeetingFormState extends State<_MeetingForm> {
  final date = TextEditingController(text: _todayJalali());
  final title = TextEditingController();
  final decisions = TextEditingController();

  @override
  void dispose() {
    for (final x in [date, title, decisions]) {
      x.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.addMeeting(
      date: date.text,
      title: title.text,
      decisions: decisions.text,
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'board',
        title: 'جلسهٔ هیئت امنا',
        controller: c,
        submitLabel: 'ثبت جلسه',
        onSubmit: _save,
        fields: [
          SchoolField('board-f-date', 'تاریخ جلسه *', date),
          SchoolField('board-f-title', 'موضوع جلسه *', title),
          SchoolField('board-f-decisions', 'مصوبه‌ها', decisions, lines: 4),
        ],
      ),
    );
  }
}
