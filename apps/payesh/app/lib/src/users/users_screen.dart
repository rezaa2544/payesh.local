import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';
import 'users_controller.dart';

/// Native `#/users` (row 128, W6): the manager's user list — search (name, mobile, national
/// id), role filter, multi-select with bulk delete, and per user: full profile, edit, delete.
/// Works offline; queued rows carry «در صف ارسال».
class UsersScreen extends StatefulWidget {
  const UsersScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final UsersController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<UsersScreen> createState() => _UsersScreenState();
}

class _UsersScreenState extends State<UsersScreen> {
  UsersController get c => widget.controller;
  final search = TextEditingController();

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<void> _open(Widget page) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
    c.clearForm();
  }

  Future<void> _delete(SchoolUser u) async {
    final parents = u.role == 'student'
        ? await c.orphanParents(u.id)
        : const <String>[];
    if (!mounted) return;
    final ok = await confirmAction(
      context,
      prefix: 'usr',
      title: 'حذف کاربر',
      message: u.role == 'student'
          ? 'دانش‌آموز «${u.name}» حذف شود؟'
                '${parents.isEmpty ? '' : '\nولیِ او هم (${parents.join('، ')}) حذف می‌شود.'}'
                '\nاین کار قابل بازگشت نیست.'
          : 'کاربر «${u.name}» حذف شود؟ این کار قابل بازگشت نیست.',
    );
    if (ok) await c.delete(u.id);
  }

  Future<void> _bulkDelete() async {
    final ok = await confirmAction(
      context,
      prefix: 'usr',
      title: 'حذف گروهی',
      message:
          '${faDigits(c.picked.length)} کاربر حذف شوند؟ این کار قابل بازگشت نیست.',
    );
    if (ok) await c.deletePicked();
  }

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'usr',
    title: 'کاربران',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    fab: c.canManage
        ? FloatingActionButton.extended(
            key: const Key('usr-add'),
            onPressed: () => _open(UserFormPage(controller: c)),
            icon: const Icon(Icons.person_add_alt),
            label: const Text('کاربر جدید'),
          )
        : null,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) => _body(context),
    ),
  );

  Widget _body(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        PayeshTokens.space4,
        PayeshTokens.space3,
        PayeshTokens.space4,
        96,
      ),
      children: [
        TextField(
          key: const Key('usr-search'),
          controller: search,
          decoration: const InputDecoration(
            labelText: 'جستجوی نام، شمارهٔ همراه یا کد ملی…',
            prefixIcon: Icon(Icons.search),
            border: OutlineInputBorder(),
          ),
          onSubmitted: (v) => c.filter(search: v),
        ),
        const SizedBox(height: PayeshTokens.space2),
        Wrap(
          spacing: PayeshTokens.space2,
          children: [
            for (final (v, label) in roleFilters)
              ChoiceChip(
                key: Key('usr-role-${v.isEmpty ? 'all' : v}'),
                label: Text(label),
                selected: c.roleFilter == v,
                onSelected: (_) => c.filter(role: v),
              ),
          ],
        ),
        const SizedBox(height: PayeshTokens.space2),
        Row(
          children: [
            Checkbox(
              key: const Key('usr-pick-all'),
              value: c.users.isNotEmpty && c.picked.length == c.users.length,
              onChanged: (v) => c.pickAll(v ?? false),
            ),
            Expanded(
              child: Text(
                '${faDigits(c.users.length)} کاربر',
                key: const Key('usr-count'),
                style: theme.textTheme.bodySmall,
              ),
            ),
          ],
        ),
        if (c.picked.isNotEmpty)
          Card(
            key: const Key('usr-picked-bar'),
            child: Padding(
              padding: const EdgeInsets.all(PayeshTokens.space2),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '${faDigits(c.picked.length)} کاربر انتخاب شده',
                    ),
                  ),
                  TextButton(
                    key: const Key('usr-pick-clear'),
                    onPressed: c.clearPicks,
                    child: const Text('لغو انتخاب'),
                  ),
                  FilledButton(
                    key: const Key('usr-bulk-delete'),
                    style: FilledButton.styleFrom(
                      backgroundColor: theme.colorScheme.error,
                    ),
                    onPressed: c.busy ? null : _bulkDelete,
                    child: const Text('حذف انتخاب‌شده‌ها'),
                  ),
                ],
              ),
            ),
          ),
        if (c.users.isEmpty && c.error == null)
          const Padding(
            padding: EdgeInsets.all(PayeshTokens.space4),
            child: Text(
              'کاربری با این مشخصات پیدا نشد.',
              key: Key('usr-empty'),
            ),
          ),
        for (final u in c.users) _row(context, u),
      ],
    );
  }

  Widget _row(BuildContext context, SchoolUser u) => Card(
    key: Key('usr-row-${u.id}'),
    child: ListTile(
      leading: Checkbox(
        key: Key('usr-pick-${u.id}'),
        value: c.picked.contains(u.id),
        onChanged: (_) => c.togglePick(u.id),
      ),
      title: Text(u.name),
      subtitle: Text(
        [
          if (u.role != 'student') u.roleLabel,
          if (u.className.isNotEmpty) u.className,
          if (u.kids.isNotEmpty) 'ولیِ ${u.kids.join('، ')}',
          if (!u.active) 'غیرفعال',
        ].join(' · '),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (u.queued)
            const Padding(
              padding: EdgeInsetsDirectional.only(end: PayeshTokens.space1),
              child: StatusBadge(
                'در صف ارسال',
                tone: PayeshTone.warning,
                icon: Icons.schedule,
              ),
            ),
          PopupMenuButton<String>(
            key: Key('usr-menu-${u.id}'),
            onSelected: (v) => switch (v) {
              'full' => _open(UserProfilePage(controller: c, user: u)),
              'edit' => _open(UserEditPage(controller: c, user: u)),
              _ => _delete(u),
            },
            itemBuilder: (_) => [
              PopupMenuItem(
                key: Key('usr-full-${u.id}'),
                value: 'full',
                child: const Text('مشخصات کامل'),
              ),
              PopupMenuItem(
                key: Key('usr-edit-${u.id}'),
                value: 'edit',
                child: const Text('ویرایش'),
              ),
              PopupMenuItem(
                key: Key('usr-delete-${u.id}'),
                value: 'delete',
                child: const Text('حذف'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

/// The `user` form (web «کاربر جدید»).
class UserFormPage extends StatefulWidget {
  const UserFormPage({super.key, required this.controller});
  final UsersController controller;

  @override
  State<UserFormPage> createState() => _UserFormPageState();
}

class _UserFormPageState extends State<UserFormPage> {
  final f = {
    for (final k in [
      'name',
      'national_id',
      'phone',
      'birth_date',
      'gender',
      'parent_name',
      'parent_phone',
    ])
      k: TextEditingController(),
    for (final (k, _, _) in userExtraFields) k: TextEditingController(),
  };
  String role = 'student';
  int? classId;

  @override
  void dispose() {
    for (final c in f.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.add(
      UserDraft(
        name: f['name']!.text,
        role: role,
        classId: role == 'student' ? classId : null,
        nationalId: f['national_id']!.text,
        phone: f['phone']!.text,
        birthDate: f['birth_date']!.text,
        gender: f['gender']!.text,
        parentName: f['parent_name']!.text,
        parentPhone: f['parent_phone']!.text,
        extra: {for (final (k, _, _) in userExtraFields) k: f[k]!.text},
      ),
    );
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'usr',
        title: 'کاربر جدید',
        controller: c,
        submitLabel: c.samePerson != null ? 'شخص دیگری است — ذخیره' : 'ذخیره',
        onSubmit: _save,
        fields: [
          SchoolField('usr-f-name', 'نام و نام خانوادگی', f['name']!),
          DropdownButtonFormField<String>(
            key: const Key('usr-f-role'),
            initialValue: role,
            decoration: const InputDecoration(
              labelText: 'نقش',
              border: OutlineInputBorder(),
            ),
            items: [
              for (final MapEntry(:key, :value) in roleFa.entries)
                DropdownMenuItem(value: key, child: Text(value)),
            ],
            onChanged: (v) => setState(() => role = v ?? 'student'),
          ),
          if (role == 'student')
            DropdownButtonFormField<int?>(
              key: const Key('usr-f-class'),
              initialValue: classId,
              decoration: const InputDecoration(
                labelText: 'کلاس',
                border: OutlineInputBorder(),
              ),
              items: [
                const DropdownMenuItem<int?>(value: null, child: Text('—')),
                for (final (id, name) in c.classes)
                  DropdownMenuItem<int?>(value: id, child: Text(name)),
              ],
              onChanged: (v) => setState(() => classId = v),
            ),
          SchoolField('usr-f-nid', 'کد ملی', f['national_id']!, numeric: true),
          SchoolField(
            'usr-f-phone',
            'شمارهٔ همراه (نام کاربری)',
            f['phone']!,
            numeric: true,
          ),
          SchoolField('usr-f-birth', 'تاریخ تولد', f['birth_date']!),
          SchoolField('usr-f-gender', 'جنسیت', f['gender']!),
          if (role == 'student') ...[
            SchoolField('usr-f-parent-name', 'نام ولی', f['parent_name']!),
            SchoolField(
              'usr-f-parent-phone',
              'همراه ولی',
              f['parent_phone']!,
              numeric: true,
            ),
          ],
          for (final (k, label, numeric) in userExtraFields)
            SchoolField('usr-f-$k', label, f[k]!, numeric: numeric),
        ],
      ),
    );
  }
}

/// `user-edit` (web «ویرایش کاربر»): name, mobile, active, extra fields.
class UserEditPage extends StatefulWidget {
  const UserEditPage({super.key, required this.controller, required this.user});
  final UsersController controller;
  final SchoolUser user;

  @override
  State<UserEditPage> createState() => _UserEditPageState();
}

class _UserEditPageState extends State<UserEditPage> {
  late final name = TextEditingController(
    text: SchoolRecords.str(widget.user.data['name']),
  );
  late final phone = TextEditingController(text: widget.user.phone);
  late bool active = widget.user.active;
  late final extra = {
    for (final (k, _, _) in userExtraFields)
      k: TextEditingController(text: widget.user.field(k)),
  };

  @override
  void dispose() {
    name.dispose();
    phone.dispose();
    for (final c in extra.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.edit(
      widget.user.id,
      name: name.text,
      phone: phone.text,
      active: active,
      extra: {for (final e in extra.entries) e.key: e.value.text},
    );
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'usr',
    title: 'ویرایش ${widget.user.name}',
    controller: widget.controller,
    submitLabel: 'ذخیره',
    onSubmit: _save,
    fields: [
      SchoolField('usr-e-name', 'نام', name),
      SchoolField('usr-e-phone', 'شمارهٔ همراه', phone, numeric: true),
      StatefulBuilder(
        builder: (context, set) => SwitchListTile(
          key: const Key('usr-e-active'),
          title: const Text('فعال'),
          value: active,
          onChanged: (v) => set(() => active = v),
        ),
      ),
      for (final (k, label, numeric) in userExtraFields)
        SchoolField('usr-e-$k', label, extra[k]!, numeric: numeric),
    ],
  );
}

/// `user-full` (web «مشخصات کامل»).
class UserProfilePage extends StatefulWidget {
  const UserProfilePage({
    super.key,
    required this.controller,
    required this.user,
  });
  final UsersController controller;
  final SchoolUser user;

  static const List<(String, String, bool)> base = [
    ('name', 'نام', false),
    ('last_name', 'نام خانوادگی', false),
    ('national_id', 'کد ملی', true),
    ('phone', 'شمارهٔ همراه', true),
    ('birth_date', 'تاریخ تولد', false),
    ('gender', 'جنسیت', false),
  ];

  @override
  State<UserProfilePage> createState() => _UserProfilePageState();
}

class _UserProfilePageState extends State<UserProfilePage> {
  late final f = {
    for (final (k, _, _) in [...UserProfilePage.base, ...userExtraFields])
      k: TextEditingController(text: widget.user.field(k)),
  };

  @override
  void dispose() {
    for (final c in f.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.saveFull(widget.user.id, {
      for (final e in f.entries)
        if (e.value.text.trim() != widget.user.field(e.key))
          e.key: e.value.text,
    });
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'usr',
    title: 'مشخصات کامل — ${widget.user.name}',
    controller: widget.controller,
    submitLabel: 'ذخیرهٔ مشخصات',
    onSubmit: _save,
    fields: [
      for (final (k, label, numeric) in [
        ...UserProfilePage.base,
        ...userExtraFields,
      ])
        SchoolField('usr-p-$k', label, f[k]!, numeric: numeric),
    ],
  );
}

/// Native `#/students` (W6).
class StudentsScreen extends StatefulWidget {
  const StudentsScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final StudentsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<StudentsScreen> createState() => _StudentsScreenState();
}

class _StudentsScreenState extends State<StudentsScreen> {
  StudentsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'std',
    title: UserDirectory.wholeSchool.contains(c.role)
        ? 'دانش‌آموزان مدرسه'
        : 'دانش‌آموزان من',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) => ListView(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          TextField(
            key: const Key('std-search'),
            decoration: const InputDecoration(
              labelText: 'جستجو…',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
            ),
            onSubmitted: c.search,
          ),
          const SizedBox(height: PayeshTokens.space2),
          Text(
            '${faDigits(c.students.length)} نفر',
            key: const Key('std-count'),
          ),
          if (c.students.isEmpty && c.error == null)
            const Text('دانش‌آموزی یافت نشد.', key: Key('std-empty')),
          for (final s in c.students)
            Card(
              key: Key('std-row-${s.user.id}'),
              child: ListTile(
                title: Text(s.user.name),
                subtitle: Text(s.className),
                trailing: StatusBadge(
                  'معدل ${faDigits(s.average.toStringAsFixed(1))}',
                  key: Key('std-avg-${s.user.id}'),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}

/// Native `#/record` (W6): the student's own record.
class RecordScreen extends StatefulWidget {
  const RecordScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final RecordController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<RecordScreen> {
  RecordController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'rec',
    title: 'پروندهٔ من',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final r = c.record;
        if (r == null) return const SizedBox.shrink();
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            Text(r.className, key: const Key('rec-class')),
            const SizedBox(height: PayeshTokens.space2),
            Wrap(
              spacing: PayeshTokens.space2,
              children: [
                StatusBadge(
                  'حضور ${faDigits(r.presentPercent)}٪',
                  key: const Key('rec-present'),
                  tone: r.presentPercent >= 90
                      ? PayeshTone.success
                      : PayeshTone.warning,
                ),
                StatusBadge(
                  '${faDigits(r.grades.length)} نمره',
                  key: const Key('rec-grade-count'),
                ),
              ],
            ),
            const SizedBox(height: PayeshTokens.space3),
            for (final (i, (subject, score, approved)) in r.grades.indexed)
              ListTile(
                key: Key('rec-grade-$i'),
                title: Text(subject),
                subtitle: Text(approved ? 'تأییدشده' : 'در انتظار'),
                trailing: Text(score == null ? '—' : faDigits('$score')),
              ),
            if (r.details.isNotEmpty) ...[
              const Divider(),
              for (final (label, value) in r.details)
                ListTile(
                  dense: true,
                  title: Text(label),
                  trailing: Text(value),
                ),
            ],
          ],
        );
      },
    ),
  );
}
