// Row 187 — native `#/cqueue` «صف ارجاع» (web PAGES.cqueue, the p2 counselor queue).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_data/payesh_data.dart' show EngineRow;
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';

class CqueueController extends SchoolController {
  CqueueController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<CounselorRef> refs = const [];
  List<EngineRow> students = const [];
  bool canRefer = false;
  bool canHandle = false;

  int get openCount => refs.where((r) => r.open).length;

  @override
  Future<void> read(SchoolRecords db) async {
    final q = CounselorQueue(db);
    canRefer = q.canRefer;
    canHandle = q.canHandle;
    refs = await q.list();
    students = canRefer ? await q.students() : const [];
  }

  Future<bool> refer(int? studentId, String reason) async {
    if (studentId == null) {
      formError = 'دانش‌آموز را انتخاب کنید';
      emit();
      return false;
    }
    final r = await run(
      (db) => CounselorQueue(db).refer(studentId, reason),
      form: true,
    );
    return r != null;
  }

  Future<void> handle(CounselorRef ref, String note) =>
      run((db) => CounselorQueue(db).handle(ref, note));
}

class CqueueScreen extends StatefulWidget {
  const CqueueScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final CqueueController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<CqueueScreen> createState() => _CqueueScreenState();
}

class _CqueueScreenState extends State<CqueueScreen> {
  CqueueController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _handle(CounselorRef r) async {
    // the dialog owns its text controller: it is disposed with the dialog, after the exit
    // animation, never while the field is still on screen
    final note = await showDialog<String>(
      context: context,
      builder: (_) => _DoneDialog(initial: r.note),
    );
    if (note != null) await c.handle(r, note);
  }

  Future<void> _refer() async {
    c.clearForm();
    await openPanel<void>(context, (_) => _ReferForm(controller: c));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'cq',
      title: 'صف ارجاع',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: '${Web.fa(c.openCount)} ارجاعِ باز',
      subKey: const Key('cq-count'),
      headActions: [
        if (c.canRefer)
          WebBtn(
            '+ ارجاع به مشاور',
            key: const Key('cq-add'),
            kind: WebBtnKind.primary,
            onPressed: _refer,
          ),
      ],
      children: [
        if (c.refs.isEmpty)
          WebEmpty(
            c.canRefer
                ? 'هنوز دانش‌آموزی به مشاور ارجاع نشده است.'
                : 'دانش‌آموزی به شما ارجاع نشده است.',
            key: const Key('cq-empty'),
          )
        else
          for (final r in c.refs)
            WebCard.tight(
              key: Key('cq-row-${r.id}'),
              child: WebItem(
                title: r.studentName.isEmpty
                    ? 'دانش‌آموز ${Web.fa(r.studentId ?? 0)}'
                    : r.studentName,
                titleTrailing: [
                  WebBadge(
                    r.open ? 'باز' : 'پیگیری شد',
                    tone: r.open ? WebTone.amber : WebTone.green,
                  ),
                ],
                sub: [
                  if (r.cohort.isNotEmpty) r.cohort,
                  if (r.reason.isNotEmpty) r.reason,
                  '۳۰ روز اخیر: غیبت ${Web.fa(r.absent)} · تأخیر ${Web.fa(r.late)} · خروج زودهنگام ${Web.fa(r.earlyExit)}',
                  if (r.note.isNotEmpty) '📝 ${r.note}',
                ].join('\n'),
                actions: [
                  if (r.open && c.canHandle)
                    WebBtn(
                      'پیگیری شد',
                      key: Key('cq-done-${r.id}'),
                      kind: WebBtnKind.primary,
                      onPressed: () => _handle(r),
                    ),
                ],
              ),
            ),
      ],
    ),
  );
}

class _DoneDialog extends StatefulWidget {
  const _DoneDialog({required this.initial});

  final String initial;

  @override
  State<_DoneDialog> createState() => _DoneDialogState();
}

class _DoneDialogState extends State<_DoneDialog> {
  late final note = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    key: const Key('cq-done-dialog'),
    title: const Text('پیگیری شد'),
    content: FieldBox(
      width: kFieldText,
      child: TextField(
        key: const Key('cq-note'),
        controller: note,
        maxLines: 3,
        decoration: webInput(hint: 'یادداشت پیگیری (اختیاری)'),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('انصراف'),
      ),
      FilledButton(
        key: const Key('cq-done-save'),
        onPressed: () => Navigator.pop(context, note.text),
        child: const Text('ثبت'),
      ),
    ],
  );
}

class _ReferForm extends StatefulWidget {
  const _ReferForm({required this.controller});
  final CqueueController controller;

  @override
  State<_ReferForm> createState() => _ReferFormState();
}

class _ReferFormState extends State<_ReferForm> {
  int? student;
  final reason = TextEditingController();

  @override
  void dispose() {
    reason.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.refer(student, reason.text);
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'cq',
        title: 'ارجاع به مشاور',
        controller: c,
        submitLabel: 'ثبت ارجاع',
        onSubmit: _save,
        fields: [
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<int?>(
              isExpanded: true,
              key: const Key('cq-f-student'),
              initialValue: student,
              decoration: const InputDecoration(
                labelText: 'دانش‌آموز',
                border: OutlineInputBorder(),
              ),
              items: [
                const DropdownMenuItem<int?>(value: null, child: Text('—')),
                for (final s in c.students)
                  DropdownMenuItem<int?>(
                    value: s.id,
                    child: Text(SchoolRecords.str(s.data['name'])),
                  ),
              ],
              onChanged: (v) => setState(() => student = v),
            ),
          ),
          SchoolField('cq-f-reason', 'علت ارجاع', reason, lines: 3),
        ],
      ),
    );
  }
}
