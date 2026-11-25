// فرم «تعریف مدرسه جدید / ویرایش مدرسه» — برگرفته از مودال p2 (src/js/18-modals.js schoolModal)
// و اعتبارسنجی «school-save» (src/js/19-actions-admin.js)، به‌اضافهٔ نام کاربری و رمز مدیر.
//
// ردیف ۱۵۸ (درخواست مالک ۱۴۰۵/۰۸/۲۳، بازگرداندن بخشی از ردیف ۱۵۰): فرم مالک دوباره همهٔ
// مشخصات اصلی p2 را دارد — مقطع، نوع، نوع مدرسه، جنسیت، تلفن ثابت، تلفن همراه رابط،
// وضعیت، شیفت، تعداد کارکنان و دانش‌آموزان. روزهای کاری، پنجرهٔ موجه، قابلیت‌ها و شاخه‌ها
// همچنان در «سیستم ← مشخصات مدرسه» پنل مدیر است. مدیر همهٔ این مشخصات را آنجا هم می‌تواند
// اصلاح کند؛ تغییر بعدی مالک فقط همان فیلدی را که مالک عوض کرده روی سرور مدرسه می‌نویسد
// (server/school-registry.js applySchool · OWNER_PROFILE_KEYS).
//
// ردیف ۱۶۶ (خواستهٔ مالک):
//  • نام کاربری مدیر به‌طور پیش‌فرض همان تلفن همراه مدیر و رمز همان کد ملی است (تا مالک خودش
//    چیز دیگری ننویسد)؛ قاعدهٔ «حروف کوچک لاتین، شروع با حرف» برداشته شد (۰۹۱۴۲۸۶۹۵۰۵ درست است).
//  • با انتخاب استان، فهرست شهرستان‌های همان استان خودکار پر می‌شود (بدون تایپ دستی).
//  • «ظرفیت» حذف شد؛ فقط «تعداد دانش‌آموزان»، بدون سقف.
//  • شیفت «چرخشی»: کل مدرسه یک هفته صبح و هفتهٔ بعد بعدازظهر (زنگ‌ها در پنل مدیر).
//  • پس از «ثبت» دور هر کادر نادرست قرمز می‌شود و پیامش زیر همان کادر می‌آید.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_ui/payesh_ui.dart'
    show
        FieldBox,
        FieldIssues,
        fieldsToFixFa,
        iranCountiesOf,
        kFieldDigits,
        kFieldText;

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
  late String _county;
  late String _areaKind;
  late String _level;
  late String _type;
  late String _schoolType;
  late String _gender;
  late String _shift;
  late bool _active;
  late Map<String, int> _caps;
  String? _error;

  /// ایراد هر کادر پس از آخرین «ثبت» (ردیف ۱۶۶).
  final FieldIssues _issues = FieldIssues();

  /// نام کاربری / رمز مدیر تا وقتی مالک دستی ننوشته، از همراه / کد ملی پر می‌شود.
  late bool _userAuto;
  late bool _passAuto;

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
    _ctl('district', s['district']);
    _ctl('landline', s['landline']);
    _ctl('phone', s['phone']);
    _ctl('staff', s['staff_count']);
    _ctl('students', s['student_count']);
    _ctl('address', s['address']);
    _ctl('mg_name', _m['name']);
    _ctl('mg_nid', _m['national_id']);
    _ctl('mg_phone', _m['phone']);
    _ctl('mg_user', _m['username']);
    _ctl('mg_pass', '');
    _province = iranProvinces.contains(s['province']) ? '${s['province']}' : '';
    // شهرستانِ قدیمیِ تایپ‌شده (خارج از فهرست) هم نگه داشته می‌شود تا ویرایش آن را پاک نکند
    _county = '${s['county'] ?? ''}'.trim();
    final mode = widget.mode;
    _userAuto = mode == 'create' && '${_m['username'] ?? ''}'.trim().isEmpty;
    _passAuto = mode == 'create';
    if (_userAuto) _c['mg_user']!.text = digitsOnly(_m['phone']);
    if (_passAuto) _c['mg_pass']!.text = digitsOnly(_m['national_id']);
    _areaKind = s['area_kind'] == 'village' ? 'village' : 'district';
    _level = schoolLevels.contains(s['level']) ? '${s['level']}' : 'متوسطه اول';
    _type = schoolKindsFa.contains(s['type']) ? '${s['type']}' : 'عادی';
    _schoolType = schoolTypeDefs.any((d) => d.$1 == s['school_type'])
        ? '${s['school_type']}'
        : 'governmental';
    _gender = schoolGenders.contains(s['gender']) ? '${s['gender']}' : 'پسرانه';
    _shift = schoolShifts.contains(s['shift']) ? '${s['shift']}' : 'صبح';
    _active = s['active'] != false;
    final rc = s['capabilities'];
    _caps = rc is Map
        ? {
            for (final d in capDefs)
              d.$1: rc[d.$1] == 1 || rc[d.$1] == true ? 1 : 0,
          }
        : capsForType(_schoolType);
  }

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    _issues.dispose();
    super.dispose();
  }

  String _t(String k) => _c[k]!.text.trim();
  int? _int(String k) => int.tryParse(digitsOnly(_t(k)));

  /// بخش مالک؛ روزهای کاری، پنجرهٔ موجه، شاخه‌ها و بوم (اگر مدرسه داشته باشد) دست‌نخورده می‌ماند.
  Map<String, Object?> _collect() => {
    'name': _t('name'),
    'code': _t('code'),
    'province': _province,
    'county': _county,
    'district': _t('district'),
    'area_kind': _areaKind,
    'phone': _t('phone'),
    'landline': _t('landline'),
    'level': _level,
    'type': _type,
    'school_type': _schoolType,
    'gender': _gender,
    'shift': _shift,
    'active': _active,
    'capabilities': {
      ..._caps,
      if (_shift == 'شب' || _shift == 'هر دو') 'has_evening': 1,
    },
    'staff_count': _int('staff'),
    'student_count': _int('students'),
    'address': _t('address'),
    'manager': {
      'name': _t('mg_name'),
      'national_id': _t('mg_nid'),
      'phone': _t('mg_phone'),
      'username': normalizeUsername(_t('mg_user')),
    },
  };

  void _submit() {
    // روزهای کاری/شاخه‌ها/بوم مدرسهٔ موجود یا درخواست ثبت‌نام حفظ می‌شود.
    final f = {
      for (final k in SchoolRegistry.managerOwnedKeys)
        if (widget.initial.containsKey(k)) k: widget.initial[k],
      ..._collect(),
    };
    final pw = _c['mg_pass']!.text;
    final err = SchoolRegistry.validateSchool(
      f,
      widget.schools,
      selfId: widget.selfId,
      needPassword: widget.mode == 'create',
      password: widget.mode == 'approve' ? null : pw,
    );
    final all = SchoolRegistry.validateSchoolFields(
      f,
      widget.schools,
      selfId: widget.selfId,
      needPassword: widget.mode == 'create',
      password: widget.mode == 'approve' ? null : pw,
    );
    if (err != null) {
      _issues.setAll(all);
      setState(() => _error = all.isEmpty ? err : fieldsToFixFa(all.length));
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
    String? helper,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: FieldBox(
      width: lines > 1
          ? double.infinity
          : (numeric ? kFieldDigits : kFieldText),
      child: TextField(
        key: Key('sf-$k'),
        controller: _c[k],
        onChanged: (v) => _changed(k, v),
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
          helperText: helper,
          helperMaxLines: 2,
          errorText: _issues.of(k),
          errorMaxLines: 3,
          border: const OutlineInputBorder(),
          isDense: true,
        ),
      ),
    ),
  );

  /// کاربر کادر را اصلاح کرد ⇒ قرمزیِ همان کادر برداشته می‌شود؛ پیش‌فرض‌های نام کاربری/رمز.
  void _changed(String k, String v) {
    var dirty = _issues.has(k);
    _issues.clear(k);
    if (k == 'mg_user') _userAuto = false;
    if (k == 'mg_pass') _passAuto = false;
    if (k == 'mg_phone' && _userAuto) {
      _c['mg_user']!.text = digitsOnly(v);
      dirty |= _issues.has('mg_user');
      _issues.clear('mg_user');
    }
    if (k == 'mg_nid' && _passAuto) {
      _c['mg_pass']!.text = digitsOnly(v);
      dirty |= _issues.has('mg_pass');
      _issues.clear('mg_pass');
    }
    if (dirty) setState(() {});
  }

  Widget _select(
    String k,
    String label,
    String value,
    Map<String, String> options,
    ValueChanged<String> onChanged,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: FieldBox(
      width: kFieldText,
      child: DropdownButtonFormField<String>(
        key: Key('sf-$k'),
        initialValue: options.containsKey(value) ? value : null,
        isExpanded: true,
        decoration: InputDecoration(
          labelText: label,
          errorText: _issues.of(k),
          errorMaxLines: 3,
          border: const OutlineInputBorder(),
          isDense: true,
        ),
        items: [
          for (final e in options.entries)
            DropdownMenuItem(value: e.key, child: Text(e.value)),
        ],
        onChanged: options.length <= 1
            ? null
            : (v) {
                if (v != null) {
                  setState(() {
                    _issues.clear(k);
                    onChanged(v);
                  });
                }
              },
      ),
    ),
  );

  Widget _title(String t) => Padding(
    padding: const EdgeInsets.only(top: 8, bottom: 8),
    child: Text(t, style: Theme.of(context).textTheme.titleSmall),
  );

  Widget _muted(String t, {Key? key}) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      t,
      key: key,
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
                _select(
                  'province',
                  'استان *',
                  _province,
                  {'': '— انتخاب استان —', for (final p in iranProvinces) p: p},
                  (v) {
                    if (v != _province) {
                      _county = '';
                      _issues.clear('county');
                    }
                    _province = v;
                  },
                ),
                // ردیف ۱۶۶: شهرستان‌های همان استان (کلید تازه با هر استان ⇒ فهرست از نو)
                KeyedSubtree(
                  key: ValueKey('sf-county-of-$_province'),
                  child: _select('county', 'شهرستان *', _county, {
                    '': _province.isEmpty
                        ? '— اول استان را انتخاب کنید —'
                        : '— انتخاب شهرستان —',
                    if (_county.isNotEmpty &&
                        !iranCountiesOf(_province).contains(_county))
                      _county: _county,
                    for (final c in iranCountiesOf(_province)) c: c,
                  }, (v) => _county = v),
                ),
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
                _select('active', 'وضعیت', _active ? '1' : '0', const {
                  '1': 'فعال',
                  '0': 'غیرفعال',
                }, (v) => _active = v == '1'),
                _select('shift', 'شیفت', _shift, const {
                  'صبح': 'صبح',
                  'بعدازظهر': 'بعدازظهر',
                  'شب': 'شب (نوبت دوم / بزرگسالان)',
                  'هر دو': 'هر دو شیفت',
                  'چرخشی': 'چرخشی (هفته‌ای صبح، هفته‌ای بعدازظهر)',
                }, (v) => _shift = v),
                _text('staff', 'تعداد کارکنان', numeric: true),
                _text('students', 'تعداد دانش‌آموزان', numeric: true),
              ]),
              if (_shift == 'چرخشی')
                _muted(
                  'شیفت چرخشی: کل مدرسه یک هفته صبح و هفتهٔ بعد بعدازظهر است. مدیر در «برنامهٔ هفتگی ← زنگ‌ها» زنگ‌های صبح و بعدازظهر را جدا ثبت می‌کند و شیفت هفتهٔ اول را انتخاب می‌کند؛ برنامه هر هفته خودکار جابه‌جا می‌شود.',
                  key: const Key('sf-rotating-note'),
                ),
              _muted(
                'نوع مدرسه تعیین می‌کند کدام ماژول‌ها (شهریه، خوابگاه، IEP، چندپایه، کارگاه) فعال باشند؛ با تغییر آن، چک‌باکس‌های «پروفایل قابلیت» خودکار تنظیم می‌شوند ولی مدیر در «مشخصات مدرسه» دستی هم می‌تواند اصلاح کند.',
              ),
              _text('address', 'آدرس', lines: 2),
              _muted(
                'روزهای کاری، پنجرهٔ موجه، پروفایل قابلیت و شاخه‌های متوسطه دوم را مدیر پس از ورود در «سیستم ← مشخصات مدرسه» تنظیم می‌کند؛ مدیر همهٔ مشخصات بالا را هم آنجا می‌تواند اصلاح کند.',
                key: const Key('sf-profile-note'),
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
                  hint: 'مثلاً 09121234567',
                  helper: approve ? null : 'پیش‌فرض: تلفن همراه مدیر',
                ),
                if (!approve)
                  _text(
                    'mg_pass',
                    edit ? 'رمز تازه (خالی = بدون تغییر)' : 'رمز ورود مدیر *',
                    ltr: true,
                    obscure: true,
                    helper: edit ? null : 'پیش‌فرض: کد ملی مدیر',
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
