// Row 197 — Q12 (F19): the teacher's class tools on «دانش‌آموزان من» — homework for their
// own classes, a discipline note (تشویق / تذکر / یادداشت) for one student, and «ارجاع به
// مشاور». Same flows as the web client (`hw-add`, `disc-add`, `cref-add`); every write goes
// through the local database + outbox and the server re-checks the class is the teacher's.
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../finance/finance_screen.dart' show isoDayFa;
import '../pulse/web.dart';
import '../school/school_source.dart';
import 'users_controller.dart';

/// «تکالیف کلاس‌های من»: the list with «حذف» on the teacher's own rows and «تکلیف جدید».
class HomeworkCard extends StatelessWidget {
  const HomeworkCard({super.key, required this.controller});
  final StudentsController controller;

  Future<void> _add(BuildContext context) async {
    controller.clearForm();
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => HomeworkForm(controller: controller),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return WebCard(
      key: const Key('hw-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text('📚 تکالیف کلاس‌های من', style: Web.b)),
              if (c.classes.isNotEmpty)
                WebBtn(
                  '+ تکلیف جدید',
                  key: const Key('hw-add'),
                  kind: WebBtnKind.ghost,
                  onPressed: c.busy ? null : () => _add(context),
                ),
            ],
          ),
          const SizedBox(height: 6),
          if (c.classes.isEmpty)
            Text(
              'هنوز کلاسی در برنامهٔ هفتگی شما ثبت نشده است؛ پس از ثبت برنامه توسط مدیر، '
              'تکلیف کلاس‌هایتان را از همین‌جا ثبت می‌کنید.',
              key: const Key('hw-no-class'),
              style: TextStyle(fontSize: 13, color: Web.muted, height: 1.6),
            )
          else if (c.homework.isEmpty)
            Text(
              'تکلیفی ثبت نشده.',
              key: const Key('hw-empty'),
              style: TextStyle(fontSize: 13, color: Web.muted),
            )
          else
            for (final h in c.homework.take(20))
              Padding(
                key: Key('hw-row-${h.id}'),
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(h.title, style: Web.b),
                          Text(
                            [
                              if (h.className.isNotEmpty) h.className,
                              if (h.due.isNotEmpty) 'مهلت ${isoDayFa(h.due)}',
                              if (h.body.isNotEmpty) h.body,
                            ].join(' · '),
                            style: TextStyle(fontSize: 12.5, color: Web.muted),
                          ),
                        ],
                      ),
                    ),
                    if (h.authorId == c.uid)
                      WebBtn.delete(
                        'حذف',
                        key: Key('hw-delete-${h.id}'),
                        onPressed: c.busy ? null : () => c.deleteHomework(h),
                      ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

/// «تکلیف جدید»: class (the teacher's own), title, description, due day.
class HomeworkForm extends StatefulWidget {
  const HomeworkForm({super.key, required this.controller});
  final StudentsController controller;

  @override
  State<HomeworkForm> createState() => _HomeworkFormState();
}

class _HomeworkFormState extends State<HomeworkForm> {
  final title = TextEditingController();
  final body = TextEditingController();
  final due = TextEditingController();
  late int? classId = widget.controller.classes.length == 1
      ? widget.controller.classes.first.id
      : null;

  @override
  void dispose() {
    for (final x in [title, body, due]) {
      x.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.addHomework(
      classId: classId,
      title: title.text,
      body: body.text,
      due: due.text,
    );
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'hw',
        title: 'تکلیف جدید',
        controller: c,
        submitLabel: 'ثبت تکلیف',
        onSubmit: _save,
        fields: [
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<int?>(
              key: const Key('hw-f-class'),
              initialValue: classId,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'کلاس *',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final k in c.classes)
                  DropdownMenuItem<int?>(
                    value: k.id,
                    child: Text(
                      SchoolRecords.str(k.data['name']),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: c.busy ? null : (v) => setState(() => classId = v),
            ),
          ),
          SchoolField('hw-f-title', 'عنوان *', title),
          SchoolField('hw-f-body', 'شرح', body, lines: 3),
          SchoolField('hw-f-due', 'مهلت (مثل ۱۴۰۵/۰۹/۰۶)', due),
        ],
      ),
    );
  }
}

/// «یادداشت انضباطی» for one student: kind + text.
class DisciplineForm extends StatefulWidget {
  const DisciplineForm({
    super.key,
    required this.controller,
    required this.student,
  });
  final StudentsController controller;
  final StudentRow student;

  @override
  State<DisciplineForm> createState() => _DisciplineFormState();
}

class _DisciplineFormState extends State<DisciplineForm> {
  final note = TextEditingController();
  DisciplineKind kind = DisciplineKind.positive;

  @override
  void dispose() {
    note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.addDiscipline(
      widget.student,
      kind,
      note.text,
    );
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'disc',
        title: 'انضباط — ${widget.student.user.name}',
        controller: c,
        submitLabel: 'ثبت',
        onSubmit: _save,
        fields: [
          SegmentedButton<DisciplineKind>(
            key: const Key('disc-f-kind'),
            segments: [
              for (final k in DisciplineKind.values)
                ButtonSegment(
                  value: k,
                  label: Text(k.labelFa, key: Key('disc-kind-${k.wire}')),
                ),
            ],
            selected: {kind},
            onSelectionChanged: c.busy
                ? null
                : (v) => setState(() => kind = v.first),
          ),
          const SizedBox(height: 12),
          SchoolField('disc-f-note', 'متن *', note, lines: 3),
        ],
      ),
    );
  }
}

/// «ارجاع به مشاور» for one of the teacher's students.
class ReferForm extends StatefulWidget {
  const ReferForm({super.key, required this.controller, required this.student});
  final StudentsController controller;
  final StudentRow student;

  @override
  State<ReferForm> createState() => _ReferFormState();
}

class _ReferFormState extends State<ReferForm> {
  final reason = TextEditingController();

  @override
  void dispose() {
    reason.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.refer(widget.student, reason.text);
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'cref',
        title: 'ارجاع به مشاور — ${widget.student.user.name}',
        controller: c,
        submitLabel: 'ارجاع',
        onSubmit: _save,
        fields: [SchoolField('cref-f-reason', 'علت ارجاع *', reason, lines: 3)],
      ),
    );
  }
}
