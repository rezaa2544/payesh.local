// Row 128, wave W10 — `#/followup` (web PAGES.followup) and the bulk-import wizard (web
// client/import.js, the «ورود دسته‌ای از اکسل» modal): students whose grade/branch is not
// complete, open rows of past imports, and the four steps file → columns → check/fix → apply.
// Every write is local-first through Followup / SchoolImport (queue first, then the local copy).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_data/payesh_data.dart' show EngineRow;
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

  /// Row 205: (done, total) of the running «ثبت موقت در لیست» of many rows; null = idle.
  (int, int)? tempProgress;

  /// Row 205 «ثبت موقت در لیست» right on the row(s), without opening the form: each row's
  /// user is made with only its valid values (as the button inside the form does) and the
  /// row stays on this list, marked «ثبت موقت», until its data is complete. A row that is
  /// already in the system is skipped; a row that looks like a person already here (same
  /// name, other code) is left for «✏️ اصلاح» — never merged or duplicated without asking.
  Future<RecordWrite?> tempRegister(List<ImportIssue> rows) {
    final todo = [
      for (final i in rows)
        if (i.userId == null && i.tempUserId == null) i,
    ];
    if (todo.isEmpty) {
      notice = 'همهٔ ردیف‌های انتخاب‌شده از قبل در فهرست کاربران هستند';
      emit();
      return Future.value(null);
    }
    return run((db) async {
      final keys = <String>[];
      final classes = await db.allOrEmpty('classes');
      final dir = UserDirectory(db);
      final fu = Followup(db);
      var done = 0, same = 0, dropped = 0;
      final failed = <String>[];
      for (final (n, i) in todo.indexed) {
        tempProgress = (n, todo.length);
        emit();
        // a frame between rows: a long list must not freeze the screen
        await Future<void>.delayed(Duration.zero);
        try {
          final fix = followupFixValues(i);
          final (w, drop) = await dir.addTemporary(
            followupTempDraft(i, classes: classes, fix: fix.values),
          );
          keys.addAll(w.keys);
          final d = await fu.saveDraft(i.id, fix.values, tempUserId: w.id);
          keys.addAll(d.keys);
          done++;
          if (drop.isNotEmpty) dropped++;
        } on SamePersonFailure {
          same++;
        } on RecordFailure catch (e) {
          failed.add('${i.name.isEmpty ? '—' : i.name}: ${e.messageFa}');
        }
      }
      tempProgress = null;
      final parts = [
        '${_fa(done)} نفر ثبت موقت شد${done == 0 ? '' : ' — در فهرست کاربران هستند و ردیفشان برای تکمیل در «پیگیری» می‌ماند'}',
        if (dropped > 0) '${_fa(dropped)} نفر مقدارهای نادرستشان ثبت نشد',
        if (same > 0)
          '${_fa(same)} نفر شبیه کاربری است که از قبل هست — با «✏️ اصلاح» بررسی کنید',
        if (failed.isNotEmpty)
          '${_fa(failed.length)} نفر ثبت نشد (${failed.take(3).join('؛ ')})',
      ];
      if (done == 0) throw RecordFailure('invalid', parts.join(' · '));
      return RecordWrite(parts.join(' · '), keys: keys);
    });
  }

  /// Row 203: the «✏️ اصلاح» form keeps what was typed on the row as it goes — quietly (no
  /// busy flag, no reload under the open form; the list is read again when it closes).
  Future<RecordWrite?> saveDraft(
    int id,
    Map<String, String> values, {
    int? tempUserId,
  }) async {
    final d = db;
    if (d == null) return null;
    try {
      final w = await Followup(d).saveDraft(id, values, tempUserId: tempUserId);
      if (w.queued) source.queued();
      return w;
    } on RecordFailure catch (e) {
      error = e.messageFa;
    } on SyncFailure catch (e) {
      error = SchoolController.syncMessage(e);
    }
    emit();
    return null;
  }
}

/// Row 202 — what the «✏️ اصلاح» form of a follow-up row opens with: every value of the row
/// (the stored ones, then the file's own values for what the import could not take — a
/// 9-digit national id, a short mobile; for rows saved before 0.9.71 the value quoted in the
/// reason) and the wrong fields (data key → message) that open framed in red.
///
/// Row 203: then what was already typed ([ImportIssue.draft]); `auto` = national ids whose
/// dropped leading zeros were put back (fixed without asking, saved on the row at once).
({
  Map<String, String> values,
  Map<String, String> issues,
  Map<String, String> auto,
})
followupFixValues(ImportIssue i) {
  final d = i.data;
  final values = <String, String>{
    for (final e in d.entries)
      if (e.value != null && e.value is! Map && e.value is! List)
        e.key: '${e.value}',
  };
  for (final e in i.raw.entries) {
    if ((values[e.key] ?? '').isEmpty || i.fields.containsKey(e.key)) {
      values[e.key] = e.value;
    }
  }
  String pick(String k, String fallback) =>
      (values[k] ?? '').isNotEmpty ? values[k]! : fallback;
  final first = values['first_name'] ?? '';
  final last = values['last_name'] ?? '';
  values['name'] = pick(
    'full_name',
    '$first $last'.trim().isNotEmpty ? '$first $last'.trim() : i.name,
  );
  values['national_id'] = pick('national_id', i.nationalId);
  values['phone'] = pick('phone', i.phone);
  values['role'] = pick('role', 'student');
  for (final e in i.fields.entries) {
    if ((values[e.key] ?? '').isNotEmpty) continue;
    for (final line in e.value.split('\n')) {
      final q = importReasonValue(line);
      if (q.isNotEmpty && q != i.name) {
        values[e.key] = q;
        break;
      }
    }
  }
  // row 203: what the manager already typed (kept by «✏️ اصلاح»)
  values.addAll(i.draft);
  final issues = {
    for (final e in i.fields.entries)
      e.key == 'full_name' ? 'name' : e.key: e.value,
  };
  // row 203: a national id whose leading zeros Excel dropped is fixed right away
  final auto = <String, String>{};
  for (final k in issues.keys.toList()) {
    if (k != 'national_id' && !k.endsWith('_nid')) continue;
    final z = nidRestoreZeros(values[k]);
    if (z.isEmpty) continue;
    values[k] = z;
    auto[k] = z;
    issues.remove(k);
  }
  return (values: values, issues: issues, auto: auto);
}

/// Row 205 — the user a follow-up row becomes on «ثبت موقت در لیست» without its form: the
/// values the «✏️ اصلاح» form opens with ([followupFixValues]), read the way the form reads
/// them (the single «ولی» is the father; the class the file named, when the school has it).
UserDraft followupTempDraft(
  ImportIssue i, {
  List<EngineRow> classes = const [],
  Map<String, String>? fix,
}) {
  final v = fix ?? followupFixValues(i).values;
  String g(String k) => (v[k] ?? '').trim();
  final extra = <String, String>{
    for (final k in userProfileKeys)
      if (g(k).isNotEmpty) k: g(k),
  };
  for (final (from, to) in const [
    ('parent_name', 'father_name'),
    ('parent_phone', 'father_phone'),
  ]) {
    if (g(from).isNotEmpty && (extra[to] ?? '').isEmpty) extra[to] = g(from);
  }
  final role = g('role').isEmpty ? 'student' : g('role');
  final student = role == 'student';
  var classId = int.tryParse(g('class_id'));
  final cn = g('class_name');
  if (classId == null && cn.isNotEmpty) {
    classId = classes
        .where((c) => normName(c.data['name']) == normName(cn))
        .map((c) => c.id)
        .firstOrNull;
  }
  bool has(String rel) => [
    '${rel}_name',
    '${rel}_phone',
    '${rel}_nid',
  ].any((k) => (extra[k] ?? '').isNotEmpty);
  return UserDraft(
    name: g('name'),
    role: role,
    classId: student ? classId : null,
    nationalId: g('national_id'),
    phone: g('phone'),
    birthDate: g('birth_date'),
    gender: g('gender'),
    extra: extra,
    grade: student ? g('grade') : '',
    branch: student ? (g('field').isNotEmpty ? g('field') : g('branch')) : '',
    parentAccounts: student
        ? {
            for (final r in const ['father', 'mother'])
              if (has(r)) r,
          }
        : const {},
    access: accessForSave(role, roleDefaultAccess[role] ?? const []),
  );
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

  /// Row 205: the import rows ticked for one «ثبت موقت در لیست».
  final Set<int> _picked = {};

  static bool _canTemp(ImportIssue i) =>
      i.userId == null && i.tempUserId == null;

  Future<void> _temp(List<ImportIssue> rows) async {
    if (rows.length > 1) {
      final ok = await confirmAction(
        context,
        prefix: 'fu-temp',
        title: 'ثبت موقت در لیست',
        message:
            '${Web.fa(rows.length)} نفر با همان اطلاعات درستشان در فهرست کاربران ثبت شوند؟ '
            'مقدارهای نادرست ثبت نمی‌شوند و ردیف هر نفر برای تکمیل در «پیگیری» می‌ماند.',
        confirm: 'ثبت موقت همه',
      );
      if (!ok) return;
    }
    final r = await c.tempRegister(rows);
    if (r != null && mounted) setState(() => _picked.clear());
  }

  Widget _tempBar(List<ImportIssue> issues) {
    final open = [
      for (final i in issues)
        if (_canTemp(i)) i,
    ];
    _picked.removeWhere((id) => !open.any((i) => i.id == id));
    if (open.isEmpty) return const SizedBox.shrink();
    final all = _picked.length == open.length;
    final p = c.tempProgress;
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 2),
      child: Wrap(
        spacing: 10,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          InkWell(
            key: const Key('fu-issues-all'),
            onTap: c.busy
                ? null
                : () => setState(() {
                    if (all) {
                      _picked.clear();
                    } else {
                      _picked.addAll(open.map((i) => i.id));
                    }
                  }),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Checkbox(
                  value: _picked.isEmpty ? false : (all ? true : null),
                  tristate: true,
                  onChanged: c.busy
                      ? null
                      : (_) => setState(() {
                          if (all) {
                            _picked.clear();
                          } else {
                            _picked.addAll(open.map((i) => i.id));
                          }
                        }),
                ),
                Text(
                  'انتخاب همه (${Web.fa(open.length)} ردیفی که هنوز در فهرست نیستند)',
                  style: Web.small.copyWith(color: Web.ink),
                ),
              ],
            ),
          ),
          WebBtn(
            '📋 ثبت موقت انتخاب‌شده‌ها${_picked.isEmpty ? '' : ' (${Web.fa(_picked.length)})'}',
            key: const Key('fu-issues-temp'),
            onPressed: c.busy || _picked.isEmpty
                ? null
                : () => _temp([
                    for (final i in open)
                      if (_picked.contains(i.id)) i,
                  ]),
          ),
          if (p != null)
            Text(
              'در حال ثبت موقت: ${Web.fa(p.$1)} از ${Web.fa(p.$2)}',
              key: const Key('fu-issues-progress'),
              style: Web.small.copyWith(color: Web.muted),
            ),
        ],
      ),
    );
  }

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
    final fix = followupFixValues(i);
    if (fix.auto.isNotEmpty) {
      await c.saveDraft(i.id, fix.auto);
      if (!mounted) {
        uc.dispose();
        return;
      }
    }
    // row 203: every change is kept on the row as it is typed; «ذخیره» is the final save
    Future<void> pending = Future<void>.value();
    Future<void> draft(Map<String, String> m) {
      final f = c.saveDraft(i.id, m).then((_) {});
      pending = f;
      return f;
    }

    final Widget page;
    if (existing != null) {
      page = UserEditPage(
        controller: uc,
        user: existing,
        onSaved: done,
        issues: fix.issues,
        notes: i.reasons,
        initial: fix.values,
        draft: {...i.draft, ...fix.auto},
        onDraft: draft,
      );
    } else {
      page = UserFormPage(
        controller: uc,
        onSaved: done,
        initial: fix.values,
        issues: fix.issues,
        notes: i.reasons,
        onDraft: draft,
        // row 203 «ثبت موقت در لیست»: in the class list now, still on this list to complete
        onTemp: (w, dropped, values) async {
          await c.saveDraft(i.id, values, tempUserId: w.id);
        },
      );
    }
    await openPanel<void>(context, (_) => page);
    // what was typed just before closing is written before the list is read again
    await pending;
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
            message: 'همین‌طور بماند و از این فهرست برود',
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

  /// Row 201 «حذف / نادیده گرفتن»: the row leaves the list (the file's data is not used).
  Future<void> _ignore(ImportIssue i) async {
    final ok = await confirmAction(
      context,
      prefix: 'fu-issue',
      title: 'حذف از پیگیری',
      message:
          'ردیف «${i.name.isEmpty ? '—' : i.name}» از «نیازمند پیگیری» حذف و نادیده گرفته شود؟'
          '${i.userId == null ? ' کاربری برای او ساخته نمی‌شود.' : ''}',
      confirm: 'حذف و نادیده گرفتن',
    );
    if (ok) await c.issueDone(i.id);
  }

  /// Row 201 — one import row as a card line: who (name, national id, mobile) · why · the
  /// two actions «✏️ اصلاح» (the user form, prefilled; saving removes the row) and «حذف /
  /// نادیده گرفتن». The buttons never wrap word by word (they were squeezed into a column).
  Widget _issueTile(ImportIssue i) {
    final who = Column(
      key: Key('fu-issue-${i.id}'),
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Wrap(
          spacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              i.name.isEmpty ? '—' : i.name,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            if (i.tempUserId != null)
              WebBadge(
                'ثبت موقت — در فهرست کاربران',
                key: Key('fu-issue-temp-${i.id}'),
                tone: WebTone.amber,
              )
            else if (i.userId != null)
              WebBadge(
                'در سامانه هست',
                key: Key('fu-issue-state-${i.id}'),
                tone: WebTone.green,
              ),
          ],
        ),
        const SizedBox(height: 2),
        Text(
          [
            if (i.nationalId.isNotEmpty) 'کد ملی ${i.nationalId}',
            if (i.phone.isNotEmpty) '☎ ${i.phone}',
            if (i.nationalId.isEmpty && i.phone.isEmpty) '—',
          ].join(' · '),
          style: Web.small.copyWith(color: Web.muted),
        ),
      ],
    );
    final saved = i.draft.isEmpty
        ? null
        : Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              i.reasons.isEmpty
                  ? '✓ همهٔ ایرادها اصلاح و ذخیره شد — ثبت نهایی: «✏️ اصلاح» ← «ذخیره»'
                  : '✓ اصلاح‌های قبلی ذخیره شده است؛ ${_fa(i.reasons.length)} مورد مانده',
              key: Key('fu-issue-draft-${i.id}'),
              style: Web.small.copyWith(
                color: Colors.green.shade800,
                fontWeight: FontWeight.w600,
              ),
            ),
          );
    final why = i.reasons.isEmpty
        ? (saved ?? Text('—', style: Web.small.copyWith(color: Web.ink)))
        : Column(
            key: Key('fu-issue-why-${i.id}'),
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final r in i.reasons.take(4))
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Text(
                    '⚠️ $r',
                    style: Web.small.copyWith(color: Web.ink, height: 1.7),
                  ),
                ),
              ?saved,
            ],
          );
    final actions = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        WebBtn(
          '✏️ اصلاح',
          key: Key('fu-issue-fix-${i.id}'),
          kind: WebBtnKind.primary,
          onPressed: c.busy ? null : () => _fix(i),
        ),
        if (_canTemp(i)) ...[
          const SizedBox(width: 6),
          // row 205: the form's «ثبت موقت در لیست» right on the row too
          WebBtn(
            '📋 ثبت موقت در لیست',
            key: Key('fu-issue-temp-btn-${i.id}'),
            onPressed: c.busy ? null : () => _temp([i]),
          ),
        ],
        const SizedBox(width: 6),
        WebBtn.delete(
          'حذف / نادیده گرفتن',
          key: Key('fu-issue-done-${i.id}'),
          onPressed: c.busy ? null : () => _ignore(i),
        ),
      ],
    );
    final pick = _canTemp(i)
        ? Checkbox(
            key: Key('fu-issue-pick-${i.id}'),
            value: _picked.contains(i.id),
            onChanged: c.busy
                ? null
                : (v) => setState(() {
                    if (v ?? false) {
                      _picked.add(i.id);
                    } else {
                      _picked.remove(i.id);
                    }
                  }),
          )
        : const SizedBox(width: 48);
    return LayoutBuilder(
      builder: (context, box) {
        final narrow = box.maxWidth < 720;
        return Container(
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: Web.line)),
          ),
          child: narrow
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        pick,
                        Expanded(child: who),
                      ],
                    ),
                    const SizedBox(height: 6),
                    why,
                    const SizedBox(height: 8),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: actions,
                    ),
                  ],
                )
              : Row(
                  children: [
                    pick,
                    SizedBox(width: 220, child: who),
                    const SizedBox(width: 12),
                    Expanded(child: why),
                    const SizedBox(width: 12),
                    actions,
                  ],
                ),
        );
      },
    );
  }

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
                          Text(
                            'هر ردیف را با «✏️ اصلاح» در همان فرم تعریف کاربر درست و ذخیره کنید تا '
                            'از این فهرست برود؛ با «📋 ثبت موقت در لیست» همان حالا با اطلاعات درستش در '
                            'فهرست کاربران می‌آید و برای تکمیل اینجا می‌ماند (چند ردیف را تیک بزنید یا '
                            '«انتخاب همه» تا یک‌جا ثبت شوند)؛ یا اگر لازم نیست، «حذف / نادیده گرفتن» را بزنید.',
                            style: Web.small.copyWith(color: Web.muted),
                          ),
                          _tempBar(v.issues),
                          const SizedBox(height: 4),
                          for (final i in v.issues) _issueTile(i),
                          const SizedBox(height: 10),
                          Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: WebBtn.delete(
                              'همه را نادیده بگیر',
                              key: const Key('fu-issues-clear'),
                              size: WebBtnSize.normal,
                              onPressed: c.busy
                                  ? null
                                  : () async {
                                      final ok = await confirmAction(
                                        context,
                                        prefix: 'fu-issues',
                                        title: 'حذف همهٔ ردیف‌ها',
                                        message:
                                            'همهٔ ${Web.fa(v.issues.length)} ردیف ورود دسته‌ای از «نیازمند پیگیری» حذف و نادیده گرفته شود؟',
                                        confirm: 'همه حذف شود',
                                      );
                                      if (ok) await c.issuesClear();
                                    },
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
  late final String _kind = widget.controller.session?.kind ?? 'students';

  /// The fix fields of the kind, then (row 202) every other wrong field of this row.
  late final List<(String, String, bool)> fields = [
    ...importFixFields[_kind]!,
    for (final k in widget.row.problems.keys)
      if (!importFixFields[_kind]!.any((x) => x.$1 == k))
        for (final x in importFields[_kind] ?? const <ImportField>[])
          if (x.$1 == k)
            (
              k,
              x.$2,
              k.endsWith('_nid') || k.endsWith('phone') || k == 'national_id',
            ),
  ];
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
      // row 202: the wrong boxes open framed in red
      presetIssues: {
        for (final e in r.problems.entries)
          if (fields.any((x) => x.$1 == e.key)) 'imp-fix-f-${e.key}': e.value,
      },
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
