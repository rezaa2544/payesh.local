// Row 128, wave W10 — `#/followup` (web PAGES.followup) and the bulk-import wizard (web
// client/import.js, the «ورود دسته‌ای از اکسل» modal): students whose grade/branch is not
// complete, open rows of past imports, and the four steps file → columns → check/fix → apply.
// Every write is local-first through Followup / SchoolImport (queue first, then the local copy).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';
import '../users/users_controller.dart';
import '../users/users_screen.dart';
import 'import_wizard.dart';

export 'import_wizard.dart' show ImportController, ImportScreen;

String _fa(int n) => n.toString().replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

class FollowupController extends SchoolController {
  FollowupController({
    required super.source,
    required super.role,
    required super.uid,
  });

  FollowupView? view;

  @override
  Future<void> read(SchoolRecords db) async {
    view = await Followup(db).view();
  }

  Future<RecordWrite?> assign(int id, String grade, String branch) =>
      run((db) => Followup(db).assign(id, grade: grade, branch: branch));

  Future<RecordWrite?> ack(int id) => run((db) => Followup(db).ack(id));

  Future<RecordWrite?> issueDone(int id) =>
      run((db) => Followup(db).issueDone(id));

  Future<RecordWrite?> issuesClear() => run((db) => Followup(db).issuesClear());
}

class FollowupScreen extends StatefulWidget {
  const FollowupScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final FollowupController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<FollowupScreen> createState() => _FollowupScreenState();
}

class _FollowupScreenState extends State<FollowupScreen> {
  FollowupController get c => widget.controller;
  final Map<int, String> _grade = {};
  final Map<int, String> _branch = {};

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _import() async {
    await openPanel<void>(
      context,
      (_) => SchoolOwned(
        create: () =>
            ImportController(source: c.source, role: c.role, uid: c.uid),
        page: (ic) => ImportScreen(
          controller: ic as ImportController,
          sync: widget.sync,
          onRetry: widget.onRetry,
        ),
      ),
      width: kPanelWideWidth,
    );
    await c.load();
  }

  /// `issue-fix`: the user form with the row's values (or the user it already became); saving
  /// closes the row.
  Future<void> _fix(ImportIssue i) async {
    final uc = UsersController(source: c.source, role: c.role, uid: c.uid);
    await uc.load();
    if (!mounted) {
      uc.dispose();
      return;
    }
    Future<void> done(RecordWrite _) async {
      await c.issueDone(i.id);
    }

    final existing = i.userId == null
        ? null
        : uc.users.where((u) => u.id == i.userId).firstOrNull;
    final Widget page;
    if (existing != null) {
      page = UserEditPage(controller: uc, user: existing, onSaved: done);
    } else {
      final d = i.data;
      page = UserFormPage(
        controller: uc,
        onSaved: done,
        initial: {
          for (final e in d.entries)
            if (e.value != null && e.value is! Map && e.value is! List)
              e.key: '${e.value}',
          'name': SchoolRecords.str(d['full_name']).isNotEmpty
              ? SchoolRecords.str(d['full_name'])
              : i.name,
          'national_id': SchoolRecords.str(d['national_id']).isNotEmpty
              ? SchoolRecords.str(d['national_id'])
              : i.nationalId,
          'phone': SchoolRecords.str(d['phone']).isNotEmpty
              ? SchoolRecords.str(d['phone'])
              : i.phone,
          'role': SchoolRecords.str(d['role']).isEmpty
              ? 'student'
              : SchoolRecords.str(d['role']),
        },
      );
    }
    await openPanel<void>(context, (_) => page);
    uc.dispose();
    await c.load();
  }

  Widget _select(
    Key key,
    String value,
    String empty,
    List<String> options,
    double minWidth,
    ValueChanged<String> onChanged,
  ) => ConstrainedBox(
    constraints: BoxConstraints(minWidth: minWidth, maxWidth: minWidth + 40),
    child: FieldBox(
      width: kFieldText,
      child: DropdownButtonFormField<String>(
        key: key,
        initialValue: value,
        isExpanded: true,
        isDense: true,
        style: TextStyle(
          fontSize: 15,
          color: Web.ink,
          fontFamily: PayeshTokens.fontFamily,
          package: PayeshTokens.fontPackage,
        ),
        decoration: webInput(),
        items: [
          DropdownMenuItem(value: '', child: Text(empty)),
          for (final x in options) DropdownMenuItem(value: x, child: Text(x)),
        ],
        onChanged: (x) => onChanged(x ?? ''),
      ),
    ),
  );

  Widget _cardHead(String t, String count, String key) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      children: [
        Expanded(child: Text(t, style: Web.b)),
        Text(count, key: Key(key), style: Web.small),
      ],
    ),
  );

  Widget _nameCell(String name, String sub, {Key? key}) => Column(
    key: key,
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(name.isEmpty ? '—' : name, style: Web.b),
      if (sub.isNotEmpty)
        Directionality(
          textDirection: TextDirection.ltr,
          child: Text(sub, style: Web.small),
        ),
    ],
  );

  List<Widget> _student(FollowupView v, FollowupStudent s) {
    final g = _grade[s.id] ?? s.grade;
    final b = _branch[s.id] ?? s.branch;
    final grades = [...v.grades, if (g.isNotEmpty && !v.grades.contains(g)) g];
    final branches = [
      ...v.branches,
      if (b.isNotEmpty && !v.branches.contains(b)) b,
    ];
    return [
      _nameCell(s.name, s.contact, key: Key('fu-stud-${s.id}')),
      Text(
        '⚠️ ${s.reason}',
        key: Key('fu-reason-${s.id}'),
        style: Web.small.copyWith(color: Web.ink),
      ),
      WebWrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          _select(
            Key('fu-grade-${s.id}'),
            g,
            '— پایه —',
            grades,
            104,
            (x) => setState(() => _grade[s.id] = x),
          ),
          _select(
            Key('fu-branch-${s.id}'),
            b,
            '— رشته —',
            branches,
            118,
            (x) => setState(() => _branch[s.id] = x),
          ),
        ],
      ),
      WebWrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          WebBtn(
            'ذخیره',
            key: Key('fu-assign-${s.id}'),
            kind: WebBtnKind.primary,
            onPressed: c.busy ? null : () => c.assign(s.id, g, b),
          ),
          Tooltip(
            message: 'بی‌کلاس بماند',
            child: WebBtn(
              'حل شد',
              key: Key('fu-ack-${s.id}'),
              kind: WebBtnKind.ghost,
              onPressed: c.busy ? null : () => c.ack(s.id),
            ),
          ),
        ],
      ),
    ];
  }

  List<Widget> _issue(ImportIssue i) => [
    _nameCell(i.name, i.nationalId, key: Key('fu-issue-${i.id}')),
    Directionality(
      textDirection: TextDirection.ltr,
      child: Text(
        i.phone.isEmpty ? '—' : i.phone,
        style: Web.small.copyWith(color: Web.ink),
        textAlign: TextAlign.right,
      ),
    ),
    i.reasons.isEmpty
        ? Text('—', style: Web.small.copyWith(color: Web.ink))
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final r in i.reasons.take(4))
                Text('⚠️ $r', style: Web.small.copyWith(color: Web.ink)),
            ],
          ),
    Align(
      alignment: AlignmentDirectional.centerStart,
      child: WebBadge(
        i.userId != null ? 'در سامانه هست' : 'ساخته نشده',
        key: Key('fu-issue-state-${i.id}'),
        tone: i.userId != null ? WebTone.green : WebTone.red,
      ),
    ),
    WebWrap(
      spacing: 4,
      runSpacing: 4,
      children: [
        WebBtn(
          i.userId != null ? 'اصلاح' : 'ساختن کاربر',
          key: Key('fu-issue-fix-${i.id}'),
          onPressed: c.busy ? null : () => _fix(i),
        ),
        WebBtn(
          'حل شد',
          key: Key('fu-issue-done-${i.id}'),
          kind: WebBtnKind.ghost,
          onPressed: c.busy ? null : () => c.issueDone(i.id),
        ),
      ],
    ),
  ];

  /// Row 172: web `PAGES.followup` exactly — pageHead «نیازمند پیگیری» + «N مورد برای
  /// رسیدگی» with «📥 ورود دسته‌ای», the muted note, then the students card and the import
  /// rows card (each a table, or the ✅ line).
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final v = c.view;
      return SchoolPage(
        prefix: 'fu',
        title: 'نیازمند پیگیری',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub: v == null ? null : '${Web.fa(v.total)} مورد برای رسیدگی',
        subKey: const Key('fu-count'),
        headActions: [
          WebBtn(
            '📥 ورود دسته‌ای',
            key: const Key('fu-import'),
            onPressed: _import,
          ),
        ],
        children: v == null
            ? const []
            : [
                Padding(
                  padding: EdgeInsets.only(bottom: 10),
                  child: Text(
                    'هر چیزی که کامل نیست اینجا جمع می‌شود: ردیف‌های ورود دسته‌ای که ساخته نشدند، '
                    'و دانش‌آموزانی که پایه یا رشته‌شان کامل نیست (مثلاً رشته‌شان حذف شده یا پایه‌اش در فایل نبود). '
                    'تا اینجا باشند جایی گم نمی‌شوند.',
                    style: TextStyle(
                      fontSize: 12.5,
                      color: Web.muted,
                      height: 2,
                    ),
                  ),
                ),
                wideIf(
                  v.students.isNotEmpty,
                  WebCard(
                    key: const Key('fu-students'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _cardHead(
                          'دانش‌آموزانی که پایه/رشته‌شان کامل نیست',
                          '${Web.fa(v.students.length)} نفر',
                          'fu-students-count',
                        ),
                        if (v.students.isEmpty)
                          Text(
                            'پایه و رشتهٔ همهٔ دانش‌آموزان کامل است. ✅',
                            key: Key('fu-students-none'),
                            style: Web.small,
                          )
                        else
                          WebTable(
                            minWidth: 640,
                            head: const [
                              'دانش‌آموز',
                              'دلیل',
                              'پایه و رشته',
                              '',
                            ],
                            rows: [for (final s in v.students) _student(v, s)],
                          ),
                      ],
                    ),
                  ),
                ),
                wideIf(
                  v.issues.isNotEmpty,
                  WebCard(
                    key: const Key('fu-issues'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _cardHead(
                          'ردیف‌های ورود دسته‌ای',
                          '${Web.fa(v.issues.length)} ردیف',
                          'fu-issues-count',
                        ),
                        if (v.issues.isEmpty)
                          Text(
                            'ردیف ناتمامی از ورود دسته‌ای نمانده. ✅',
                            key: Key('fu-issues-none'),
                            style: Web.small,
                          )
                        else ...[
                          WebTable(
                            minWidth: 640,
                            head: const [
                              'نام',
                              'شمارهٔ همراه',
                              'دلیل',
                              'وضعیت',
                              '',
                            ],
                            rows: [for (final i in v.issues) _issue(i)],
                          ),
                          const SizedBox(height: 10),
                          Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: WebBtn(
                              'همه را حل‌شده کن',
                              key: const Key('fu-issues-clear'),
                              kind: WebBtnKind.primary,
                              size: WebBtnSize.normal,
                              onPressed: c.busy ? null : c.issuesClear,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
      );
    },
  );
}

// ─────────────────────────────── bulk import wizard ───────────────────────────────

/// Form `imp-fix` (web `impFixCardHtml`): correct one row in place, then everything is checked
/// again; the leading zero of a mobile is already filled in.
class ImportFixPage extends StatefulWidget {
  const ImportFixPage({super.key, required this.controller, required this.row});
  final ImportController controller;
  final ImportRow row;

  @override
  State<ImportFixPage> createState() => _ImportFixPageState();
}

class _ImportFixPageState extends State<ImportFixPage> {
  late final List<(String, String, bool)> fields =
      importFixFields[widget.controller.session?.kind ?? 'students']!;
  late final Map<String, TextEditingController> f = {
    for (final (k, _, _) in fields)
      k: TextEditingController(
        text: widget.controller.session?.fixValue(widget.row, k) ?? '',
      ),
  };

  @override
  void dispose() {
    for (final x in f.values) {
      x.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    await widget.controller.fix(widget.row, {
      for (final e in f.entries) e.key: e.value.text,
    });
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.row;
    return SchoolForm(
      prefix: 'imp-fix',
      title: 'سطر ${_fa(r.row)} — ${r.name.isEmpty ? '—' : r.name}',
      controller: widget.controller,
      submitLabel: '✔ ذخیره و بررسی دوباره',
      onSubmit: _save,
      fields: [
        for (final e in r.errors)
          Text(
            '⛔ $e',
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        for (final b in r.blocks) Text('✏️ $b'),
        for (final (k, label, numeric) in fields)
          SchoolField('imp-fix-f-$k', label, f[k]!, numeric: numeric),
        const Text(
          'صفرِ اولِ شماره‌ها خودکار گذاشته شده است؛ اگر یک رقم کم است، همین‌جا کاملش کنید.',
        ),
      ],
    );
  }
}
