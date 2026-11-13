// فرم «تعریف مدرسه جدید / ویرایش مدرسه» — همان مودال p2 (src/js/18-modals.js schoolModal)
// و اعتبارسنجی «school-save» (src/js/19-actions-admin.js)، به‌اضافهٔ نام کاربری و رمز مدیر.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'school_registry.dart';

/// نتیجهٔ فرم: فیلدهای مدرسه + رمز (برای ساخت/تغییر؛ خالی = بدون تغییر).
final class SchoolFormResult {
  const SchoolFormResult(this.fields, this.password);
  final Map<String, Object?> fields;
  final String password;
}

/// [initial] = مدرسهٔ موجود (ویرایش) یا مقادیر پیش‌پر (تأیید درخواست ثبت‌نام).
/// [mode]: `create` · `edit` · `approve` (رمز را خود متقاضی داده؛ نام کاربری ثابت).
Future<SchoolFormResult?> showSchoolForm(
  BuildContext context, {
  required List<Map<String, Object?>> schools,
  Map<String, Object?>? initial,
  String mode = 'create',
  String? selfId,
}) => showDialog<SchoolFormResult>(
  context: context,
  barrierDismissible: false,
  builder: (_) => SchoolFormDialog(
    schools: schools,
    initial: initial ?? const {},
    mode: mode,
    selfId: selfId,
  ),
);

class SchoolFormDialog extends StatefulWidget {
  const SchoolFormDialog({
    super.key,
    required this.schools,
    required this.initial,
    required this.mode,
    this.selfId,
  });
  final List<Map<String, Object?>> schools;
  final Map<String, Object?> initial;
  final String mode;
  final String? selfId;

  @override
  State<SchoolFormDialog> createState() => _SchoolFormDialogState();
}

class _SchoolFormDialogState extends State<SchoolFormDialog> {
  final Map<String, TextEditingController> _c = {};
  late String _province;
  late String _areaKind;
  late String _level;
  late String _type;
  late String _schoolType;
  late String _gender;
  late String _shift;
  late bool _active;
  late bool _publicGoals;
  late Set<int> _days;
  late Map<String, int> _caps;
  late Set<String> _branches;
  late Set<String> _fields;
  String? _error;

  Map<String, Object?> get _m => widget.initial['manager'] is Map
      ? (widget.initial['manager']! as Map).cast<String, Object?>()
      : const {};

  TextEditingController _ctl(String k, Object? v) =>
      _c[k] = TextEditingController(text: v == null ? '' : '$v');

  @override
  void initState() {
    super.initState();
    final s = widget.initial;
    _ctl('name', s['name']);
    _ctl('code', s['code']);
    _ctl('county', s['county']);
    _ctl('district', s['district']);
    _ctl('landline', s['landline']);
    _ctl('phone', s['phone']);
    _ctl('capacity', s['capacity'] ?? 300);
    _ctl('excuse', s['excuse_window_minutes'] ?? 15);
    _ctl('address', s['address']);
    _ctl('boom', s['boom_goals']);
    _ctl('staff', s['staff_count']);
    _ctl('students', s['student_count']);
    _ctl('mg_name', _m['name']);
    _ctl('mg_nid', _m['national_id']);
    _ctl('mg_phone', _m['phone']);
    _ctl('mg_user', _m['username']);
    _ctl('mg_pass', '');
    _province = iranProvinces.contains(s['province']) ? '${s['province']}' : '';
    _areaKind = s['area_kind'] == 'village' ? 'village' : 'district';
    _level = schoolLevels.contains(s['level']) ? '${s['level']}' : 'متوسطه اول';
    _type = schoolKindsFa.contains(s['type']) ? '${s['type']}' : 'عادی';
    _schoolType = schoolTypeDefs.any((d) => d.$1 == s['school_type'])
        ? '${s['school_type']}'
        : 'governmental';
    _gender = schoolGenders.contains(s['gender']) ? '${s['gender']}' : 'پسرانه';
    _shift = schoolShifts.contains(s['shift']) ? '${s['shift']}' : 'صبح';
    _active = s['active'] != false;
    _publicGoals = s['public_goals'] == true;
    final wd = s['work_days'];
    _days = wd is List && wd.isNotEmpty
        ? {
            for (final d in wd)
              if (d is int) d,
          }
        : defaultWorkDays.toSet();
    final rc = s['capabilities'];
    _caps = rc is Map
        ? {
            for (final d in capDefs)
              d.$1: rc[d.$1] == 1 || rc[d.$1] == true ? 1 : 0,
          }
        : capsForType(_schoolType);
    _branches = {
      if (s['branches'] is List)
        for (final b in s['branches']! as List) '$b',
    };
    _fields = {
      if (s['fields'] is List)
        for (final b in s['fields']! as List) '$b',
    };
  }

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _t(String k) => _c[k]!.text.trim();
  int? _int(String k) => int.tryParse(digitsOnly(_t(k)));

  Map<String, Object?> _collect() => {
    'name': _t('name'),
    'code': _t('code'),
    'province': _province,
    'county': _t('county'),
    'district': _t('district'),
    'area_kind': _areaKind,
    'phone': _t('phone'),
    'landline': _t('landline'),
    'level': _level,
    'type': _type,
    'school_type': _schoolType,
    'gender': _gender,
    'shift': _shift,
    'capacity': _int('capacity') ?? 300,
    'active': _active,
    'work_days': _days.toList()..sort(),
    'excuse_window_minutes': _int('excuse') ?? 15,
    'capabilities': Map<String, int>.of(_caps),
    'branches': _level == 'متوسطه دوم' ? _branches.toList() : <String>[],
    'fields': _level == 'متوسطه دوم' ? _fields.toList() : <String>[],
    'address': _t('address'),
    'boom_goals': _t('boom'),
    'public_goals': _publicGoals,
    'staff_count': _int('staff'),
    'student_count': _int('students'),
    'manager': {
      'name': _t('mg_name'),
      'national_id': _t('mg_nid'),
      'phone': _t('mg_phone'),
      'username': _t('mg_user').toLowerCase(),
    },
  };

  void _submit() {
    final f = _collect();
    final pw = _c['mg_pass']!.text;
    final err = SchoolRegistry.validateSchool(
      f,
      widget.schools,
      selfId: widget.selfId,
      needPassword: widget.mode == 'create',
      password: widget.mode == 'approve' ? null : pw,
    );
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    Navigator.of(context).pop(SchoolFormResult(f, pw));
  }

  Widget _text(
    String k,
    String label, {
    bool ltr = false,
    bool numeric = false,
    bool obscure = false,
    bool enabled = true,
    int lines = 1,
    String? hint,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: TextField(
      key: Key('sf-$k'),
      controller: _c[k],
      enabled: enabled,
      obscureText: obscure,
      maxLines: obscure ? 1 : lines,
      textDirection: ltr ? TextDirection.ltr : null,
      keyboardType: numeric ? TextInputType.number : null,
      inputFormatters: numeric
          ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9۰-۹]'))]
          : null,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
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
    padding: const EdgeInsets.only(bottom: 10),
    child: DropdownButtonFormField<String>(
      key: Key('sf-$k'),
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
    padding: const EdgeInsets.only(top: 8, bottom: 8),
    child: Text(t, style: Theme.of(context).textTheme.titleSmall),
  );

  Widget _muted(String t) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      t,
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );

  Widget _grid(List<Widget> children) => LayoutBuilder(
    builder: (context, c) {
      final cols = c.maxWidth > 640 ? 3 : (c.maxWidth > 420 ? 2 : 1);
      final w = (c.maxWidth - (cols - 1) * 10) / cols;
      return Wrap(
        spacing: 10,
        children: [for (final x in children) SizedBox(width: w, child: x)],
      );
    },
  );

  @override
  Widget build(BuildContext context) {
    final edit = widget.mode == 'edit';
    final approve = widget.mode == 'approve';
    return AlertDialog(
      key: const Key('school-form'),
      title: Text(
        approve
            ? 'تأیید درخواست و ساخت مدرسه'
            : edit
            ? 'ویرایش مدرسه'
            : 'تعریف مدرسه جدید',
      ),
      content: SizedBox(
        width: 760,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              _grid([
                _text('name', 'نام مدرسه *'),
                _text('code', 'کد مدرسه *', ltr: true),
              ]),
              _title('📍 مکان و اداره مربوطه'),
              _grid([
                _select('province', 'استان *', _province, {
                  '': '— انتخاب استان —',
                  for (final p in iranProvinces) p: p,
                }, (v) => _province = v),
                _text('county', 'شهرستان *'),
                _text('district', 'منطقه / ناحیه یا روستا'),
                _select('area_kind', 'نوع محل', _areaKind, const {
                  'district': 'منطقه / ناحیه (شهری)',
                  'village': 'روستا (روستایی)',
                }, (v) => _areaKind = v),
              ]),
              _grid([
                _select('level', 'مقطع', _level, {
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
                _select('gender', 'جنسیت', _gender, {
                  for (final g in schoolGenders) g: g,
                }, (v) => _gender = v),
                _text('landline', 'تلفن ثابت مدرسه', ltr: true, numeric: true),
                _text('phone', 'تلفن همراه رابط', ltr: true, numeric: true),
                _text('capacity', 'ظرفیت', numeric: true),
                _select('active', 'وضعیت', _active ? '1' : '0', const {
                  '1': 'فعال',
                  '0': 'غیرفعال',
                }, (v) => _active = v == '1'),
                _select('shift', 'شیفت', _shift, const {
                  'صبح': 'صبح',
                  'بعدازظهر': 'بعدازظهر',
                  'شب': 'شب (نوبت دوم / بزرگسالان)',
                  'هر دو': 'هر دو شیفت',
                }, (v) => _shift = v),
                _text('staff', 'تعداد کارکنان', numeric: true),
                _text('students', 'تعداد دانش‌آموزان', numeric: true),
              ]),
              _muted(
                'نوع مدرسه تعیین می‌کند کدام ماژول‌ها (شهریه، خوابگاه، IEP، چندپایه، کارگاه) فعال باشند؛ با تغییر آن، چک‌باکس‌های «پروفایل قابلیت» خودکار تنظیم می‌شوند ولی دستی هم قابل اصلاح‌اند.',
              ),
              _title('🗓️ روزهای کاری'),
              Wrap(
                spacing: 4,
                children: [
                  for (var i = 0; i < weekDays.length; i++)
                    FilterChip(
                      key: Key('sf-day-$i'),
                      label: Text(weekDays[i]),
                      selected: _days.contains(i),
                      onSelected: (v) =>
                          setState(() => v ? _days.add(i) : _days.remove(i)),
                    ),
                ],
              ),
              _title('🕓 پنجرهٔ موجهِ حضور و غیاب'),
              _text('excuse', 'دقیقهٔ بعد از پایان زنگ', numeric: true),
              _title('🏫 پروفایل قابلیت این مدرسه'),
              for (final d in capDefs)
                CheckboxListTile(
                  key: Key('sf-cap-${d.$1}'),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  value: _caps[d.$1] == 1,
                  title: Text(d.$2),
                  subtitle: Text(d.$3),
                  onChanged: (v) =>
                      setState(() => _caps[d.$1] = v == true ? 1 : 0),
                ),
              if (_level == 'متوسطه دوم') ...[
                _title('🎓 شاخه‌ها و رشته‌های متوسطه دوم'),
                for (final b in schoolBranches.entries) ...[
                  CheckboxListTile(
                    key: Key('sf-branch-${b.key}'),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    value: _branches.contains(b.key),
                    title: Text('${b.key} (${b.value.length} رشته)'),
                    onChanged: (v) => setState(
                      () => v == true
                          ? _branches.add(b.key)
                          : _branches.remove(b.key),
                    ),
                  ),
                  if (_branches.contains(b.key))
                    Padding(
                      padding: const EdgeInsetsDirectional.only(start: 24),
                      child: Wrap(
                        spacing: 4,
                        children: [
                          for (final f in b.value)
                            FilterChip(
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
              _text('address', 'آدرس', lines: 2),
              _text('boom', '🎯 برنامه ویژه (بوم) — اهداف سالانه', lines: 3),
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: _publicGoals,
                title: const Text('نمایش اهداف در گزارش عمومی (بدون ورود)'),
                onChanged: (v) => setState(() => _publicGoals = v == true),
              ),
              _title(
                edit
                    ? '👤 مشخصات مدیر مدرسه'
                    : '👤 مشخصات مدیر مدرسه (حساب کاربری او ساخته می‌شود)',
              ),
              _grid([
                _text('mg_name', 'نام و نام خانوادگی *'),
                _text('mg_nid', 'کد ملی', ltr: true, numeric: true),
                _text('mg_phone', 'تلفن همراه', ltr: true, numeric: true),
                _text(
                  'mg_user',
                  'نام کاربری *',
                  ltr: true,
                  enabled: !approve,
                  hint: 'لاتین، مثلاً ali.rezaei',
                ),
                if (!approve)
                  _text(
                    'mg_pass',
                    edit ? 'رمز تازه (خالی = بدون تغییر)' : 'رمز ورود مدیر *',
                    ltr: true,
                    obscure: true,
                  ),
              ]),
              _muted(
                approve
                    ? 'رمز را خود متقاضی هنگام درخواست تعیین کرده است (فقط هش آن ذخیره شده). مدیر با همین نام کاربری و رمز در «پنل کاربران» وارد می‌شود.'
                    : 'مدیر با همین نام کاربری و رمز در «پنل کاربران» وارد می‌شود و ورودی‌ها، دبیران و کاربران مدرسهٔ خودش را تعریف می‌کند. رمز فقط به‌صورت هش (PBKDF2) ذخیره می‌شود.',
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    _error!,
                    key: const Key('sf-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('sf-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('انصراف'),
        ),
        FilledButton(
          key: const Key('sf-submit'),
          onPressed: _submit,
          child: Text(
            approve
                ? 'تأیید و ساخت'
                : edit
                ? 'ذخیره'
                : 'ثبت مدرسه',
          ),
        ),
      ],
    );
  }
}
