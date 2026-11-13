// Row 150 — «مشخصات مدرسه» in the manager's settings.
//
// The owner's «تعریف مدرسه جدید» form now keeps only location/office + the manager's
// details (to create the manager account). Everything else — level, type, school type,
// gender, shift, capacity, phones, counts, work days, the attendance excuse window,
// capability profile, branches/fields and the «بوم» goals — is set here by the manager.
//
// Dependencies (same as server/school-profile.js, shared vectors
// docs/cloud/contracts/school-profile-vectors.json):
//   * school type ⇒ default capabilities (still editable by hand);
//   * level «متوسطه دوم» ⇒ at least one branch, fields only from chosen branches;
//   * shift «شب» / «هر دو» ⇒ «نوبت دوم / کلاس شبانه» is forced on;
//   * students ≤ capacity; at least one work day.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Opens the profile page on top of the current route.
Future<void> openSchoolProfile(BuildContext context, ServerAdminApi? admin) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('مشخصات مدرسه')),
          body: SchoolProfileView(admin: admin),
        ),
      ),
    );

class SchoolProfileView extends StatefulWidget {
  const SchoolProfileView({super.key, required this.admin});
  final ServerAdminApi? admin;

  @override
  State<SchoolProfileView> createState() => _SchoolProfileViewState();
}

class _SchoolProfileViewState extends State<SchoolProfileView> {
  final Map<String, TextEditingController> _c = {
    for (final k in const [
      'capacity',
      'landline',
      'phone',
      'staff',
      'students',
      'excuse',
      'boom',
    ])
      k: TextEditingController(),
  };
  Map<String, Object?>? _loaded;
  String _level = '';
  String _type = 'عادی';
  String _schoolType = 'governmental';
  String _gender = '';
  String _shift = 'صبح';
  Set<int> _days = defaultWorkDays.toSet();
  Map<String, int> _caps = Map<String, int>.of(capDefaults);
  Set<String> _branches = {};
  Set<String> _fields = {};
  bool _publicGoals = false;
  bool _busy = false;
  String? _error;
  String? _notice;

  bool get _evening => _shift == 'شب' || _shift == 'هر دو';

  @override
  void initState() {
    super.initState();
    for (final c in _c.values) {
      c.addListener(_changed);
    }
    _load();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final a = widget.admin;
    if (a == null) {
      setState(() => _error = const AdminFailure(AdminError.offline).messageFa);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      _apply(await a.schoolProfile());
    } on AdminFailure catch (e) {
      _error = e.messageFa;
    }
    if (mounted) setState(() => _busy = false);
  }

  String _s(Object? v) => v == null ? '' : '$v';

  void _apply(Map<String, Object?> p) {
    _loaded = p;
    _level = schoolLevels.contains(p['level']) ? '${p['level']}' : '';
    _type = schoolKindsFa.contains(p['type']) ? '${p['type']}' : 'عادی';
    _schoolType = schoolTypeDefs.any((d) => d.$1 == p['school_type'])
        ? '${p['school_type']}'
        : 'governmental';
    _gender = schoolGenders.contains(p['gender']) ? '${p['gender']}' : '';
    _shift = schoolShifts.contains(p['shift']) ? '${p['shift']}' : 'صبح';
    _c['capacity']!.text = _s(p['capacity'] ?? 300);
    _c['landline']!.text = _s(p['landline']);
    _c['phone']!.text = _s(p['phone']);
    _c['staff']!.text = _s(p['staff_count']);
    _c['students']!.text = _s(p['student_count']);
    _c['excuse']!.text = _s(p['excuse_window_minutes'] ?? 15);
    _c['boom']!.text = _s(p['boom_goals']);
    final wd = p['work_days'];
    _days = wd is List && wd.isNotEmpty
        ? {
            for (final d in wd)
              if (d is int) d,
          }
        : defaultWorkDays.toSet();
    final rc = p['capabilities'];
    _caps = rc is Map
        ? {for (final d in capDefs) d.$1: rc[d.$1] == 1 ? 1 : 0}
        : capsForType(_schoolType);
    _branches = {
      if (p['branches'] is List)
        for (final b in p['branches']! as List) '$b',
    };
    _fields = {
      if (p['fields'] is List)
        for (final b in p['fields']! as List) '$b',
    };
    _publicGoals = p['public_goals'] == true;
  }

  Map<String, Object?> _collect() => {
    'level': _level,
    'type': _type,
    'school_type': _schoolType,
    'gender': _gender,
    'shift': _shift,
    'capacity': _c['capacity']!.text.trim(),
    'landline': _c['landline']!.text.trim(),
    'phone': _c['phone']!.text.trim(),
    'staff_count': _c['staff']!.text.trim(),
    'student_count': _c['students']!.text.trim(),
    'work_days': _days.toList()..sort(),
    'excuse_window_minutes': _c['excuse']!.text.trim(),
    'capabilities': {..._caps, if (_evening) 'has_evening': 1},
    'branches': _level == 'متوسطه دوم' ? _branches.toList() : <String>[],
    'fields': _level == 'متوسطه دوم' ? _fields.toList() : <String>[],
    'boom_goals': _c['boom']!.text,
    'public_goals': _publicGoals,
  };

  Future<void> _save() async {
    final check = SchoolProfile.validate(_collect());
    if (check.error != null) {
      setState(() {
        _error = check.messageFa;
        _notice = null;
      });
      return;
    }
    final a = widget.admin;
    if (a == null) {
      setState(() => _error = const AdminFailure(AdminError.offline).messageFa);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      _apply(await a.saveSchoolProfile(check.patch!));
      _notice = 'مشخصات مدرسه ذخیره شد';
    } on AdminFailure catch (e) {
      _error = e.messageFa;
    }
    if (mounted) setState(() => _busy = false);
  }

  int? _num(String k) => int.tryParse(latinDigits(_c[k]!.text.trim()));

  Widget _text(
    String k,
    String label, {
    bool numeric = true,
    bool ltr = false,
    int lines = 1,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: PayeshTokens.space2),
    child: TextField(
      key: Key('sp-$k'),
      controller: _c[k],
      maxLines: lines,
      textDirection: ltr ? TextDirection.ltr : null,
      keyboardType: numeric ? TextInputType.number : null,
      inputFormatters: numeric
          ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9۰-۹]'))]
          : null,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    ),
  );

  Widget _select(
    String k,
    String label,
    String value,
    Map<String, String> options,
    ValueChanged<String> onChanged,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: PayeshTokens.space2),
    child: DropdownButtonFormField<String>(
      key: Key('sp-$k'),
      initialValue: options.containsKey(value) ? value : null,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
      items: [
        for (final e in options.entries)
          DropdownMenuItem(value: e.key, child: Text(e.value)),
      ],
      onChanged: (v) {
        if (v != null) setState(() => onChanged(v));
      },
    ),
  );

  Widget _title(String t) => Padding(
    padding: const EdgeInsets.only(
      top: PayeshTokens.space3,
      bottom: PayeshTokens.space2,
    ),
    child: Text(t, style: Theme.of(context).textTheme.titleSmall),
  );

  Widget _muted(String t, {Key? key}) => Padding(
    padding: const EdgeInsets.only(bottom: PayeshTokens.space2),
    child: Text(
      t,
      key: key,
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final p = _loaded;
    final cs = Theme.of(context).colorScheme;
    final cap = _num('capacity');
    final st = _num('students');
    final over = cap != null && st != null && st > cap;
    return ListView(
      key: const Key('sp-list'),
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        if (_busy) const LinearProgressIndicator(key: Key('sp-busy')),
        if (p == null && !_busy && _error != null) ...[
          Text(
            _error!,
            key: const Key('sp-error'),
            style: TextStyle(color: cs.error),
          ),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: OutlinedButton(
              key: const Key('sp-retry'),
              onPressed: _load,
              child: const Text('دوباره'),
            ),
          ),
        ],
        if (p != null) ...[
          if (p['complete'] != true)
            Card(
              key: const Key('sp-incomplete'),
              color: cs.tertiaryContainer,
              child: const Padding(
                padding: EdgeInsets.all(PayeshTokens.space3),
                child: Text(
                  'مشخصات مدرسه کامل نیست — مقطع، جنسیت و بقیهٔ موارد را پر کنید و ذخیره بزنید.',
                ),
              ),
            ),
          Card(
            key: const Key('sp-owner-part'),
            child: Padding(
              padding: const EdgeInsets.all(PayeshTokens.space3),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '${_s(p['name'])} · کد ${faDigits(_s(p['code']))}',
                    key: const Key('sp-name'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text(
                    [
                      p['province'],
                      p['county'],
                      p['district'],
                    ].where((x) => _s(x).isNotEmpty).join(' · '),
                  ),
                  _muted(
                    'نام، کد و مکان/ادارهٔ مدرسه را مالک تعیین می‌کند؛ بقیهٔ مشخصات با شماست.',
                  ),
                ],
              ),
            ),
          ),
          _title('🏫 مقطع و نوع'),
          _select('level', 'مقطع *', _level, {
            '': '— انتخاب مقطع —',
            for (final l in schoolLevels) l: l,
          }, (v) => _level = v),
          _select('type', 'نوع', _type, {
            for (final l in schoolKindsFa) l: l,
          }, (v) => _type = v),
          _select(
            'school_type',
            'نوع مدرسه (تعیین‌کنندهٔ ماژول‌ها)',
            _schoolType,
            {for (final d in schoolTypeDefs) d.$1: d.$2},
            (v) {
              _schoolType = v;
              _caps = capsForType(v);
            },
          ),
          _select('gender', 'جنسیت *', _gender, {
            '': '— انتخاب جنسیت —',
            for (final g in schoolGenders) g: g,
          }, (v) => _gender = v),
          _select('shift', 'شیفت', _shift, const {
            'صبح': 'صبح',
            'بعدازظهر': 'بعدازظهر',
            'شب': 'شب (نوبت دوم / بزرگسالان)',
            'هر دو': 'هر دو شیفت',
          }, (v) => _shift = v),
          _title('👥 ظرفیت و آمار'),
          _text('capacity', 'ظرفیت *'),
          _text('students', 'تعداد دانش‌آموزان'),
          if (over)
            Text(
              schoolProfileErrorsFa['over_capacity']!,
              key: const Key('sp-over'),
              style: TextStyle(color: cs.error),
            ),
          _text('staff', 'تعداد کارکنان'),
          _title('☎️ تلفن‌ها'),
          _text('landline', 'تلفن ثابت مدرسه', ltr: true),
          _text('phone', 'تلفن همراه رابط', ltr: true),
          _title('🗓️ روزهای کاری'),
          Wrap(
            spacing: 4,
            children: [
              for (var i = 0; i < weekDays.length; i++)
                FilterChip(
                  key: Key('sp-day-$i'),
                  label: Text(weekDays[i]),
                  selected: _days.contains(i),
                  onSelected: (v) =>
                      setState(() => v ? _days.add(i) : _days.remove(i)),
                ),
            ],
          ),
          _title('🕓 پنجرهٔ موجهِ حضور و غیاب'),
          _text('excuse', 'دقیقهٔ بعد از پایان زنگ'),
          _title('🧩 پروفایل قابلیت'),
          _muted(
            'با تغییر «نوع مدرسه» قابلیت‌ها خودکار تنظیم می‌شوند ولی دستی هم قابل اصلاح‌اند؛ شیفت شب یا هر دو، «نوبت دوم» را روشن نگه می‌دارد.',
          ),
          for (final d in capDefs)
            CheckboxListTile(
              key: Key('sp-cap-${d.$1}'),
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _caps[d.$1] == 1 || (d.$1 == 'has_evening' && _evening),
              title: Text(d.$2),
              subtitle: Text(d.$3),
              onChanged: d.$1 == 'has_evening' && _evening
                  ? null
                  : (v) => setState(() => _caps[d.$1] = v == true ? 1 : 0),
            ),
          if (_level == 'متوسطه دوم') ...[
            _title('🎓 شاخه‌ها و رشته‌های متوسطه دوم'),
            for (final b in schoolBranches.entries) ...[
              CheckboxListTile(
                key: Key('sp-branch-${b.key}'),
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: _branches.contains(b.key),
                title: Text('${b.key} (${faNumber(b.value.length)} رشته)'),
                onChanged: (v) => setState(() {
                  if (v == true) {
                    _branches.add(b.key);
                  } else {
                    _branches.remove(b.key);
                    _fields.removeAll(b.value);
                  }
                }),
              ),
              if (_branches.contains(b.key))
                Padding(
                  padding: const EdgeInsetsDirectional.only(start: 24),
                  child: Wrap(
                    spacing: 4,
                    children: [
                      for (final f in b.value)
                        FilterChip(
                          key: Key('sp-field-$f'),
                          label: Text(f),
                          selected: _fields.contains(f),
                          onSelected: (v) => setState(
                            () => v ? _fields.add(f) : _fields.remove(f),
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ],
          _title('🎯 برنامهٔ ویژه (بوم)'),
          _text('boom', 'اهداف سالانه', numeric: false, lines: 3),
          CheckboxListTile(
            key: const Key('sp-public'),
            dense: true,
            contentPadding: EdgeInsets.zero,
            value: _publicGoals,
            title: const Text('نمایش اهداف در گزارش عمومی (بدون ورود)'),
            onChanged: (v) => setState(() => _publicGoals = v == true),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: PayeshTokens.space2),
              child: Text(
                _error!,
                key: const Key('sp-error'),
                style: TextStyle(color: cs.error),
              ),
            ),
          if (_notice != null)
            Padding(
              padding: const EdgeInsets.only(top: PayeshTokens.space2),
              child: Text(_notice!, key: const Key('sp-notice')),
            ),
          Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space3),
            child: FilledButton(
              key: const Key('sp-save'),
              onPressed: _busy ? null : _save,
              child: const Text('ذخیرهٔ مشخصات مدرسه'),
            ),
          ),
        ],
      ],
    );
  }
}
