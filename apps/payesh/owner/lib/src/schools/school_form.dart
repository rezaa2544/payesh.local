// فرم «تعریف مدرسه جدید / ویرایش مدرسه» — برگرفته از مودال p2 (src/js/18-modals.js schoolModal)
// و اعتبارسنجی «school-save» (src/js/19-actions-admin.js)، به‌اضافهٔ نام کاربری و رمز مدیر.
//
// ردیف ۱۵۰ (درخواست مالک ۱۴۰۵/۰۸/۲۲): فرم مالک فقط «مکان و ادارهٔ مربوطه» + «مشخصات مدیر»
// (برای ساخت حساب مدیر) را دارد. مقطع، نوع، جنسیت، ظرفیت، شیفت، تلفن‌ها، آمار، روزهای کاری،
// پنجرهٔ موجه، قابلیت‌ها و شاخه‌ها را خود مدیر در «سیستم ← مشخصات مدرسه» تعیین می‌کند
// (app/lib/src/system/school_profile_screen.dart · server/school-profile.js).

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
  late bool _active;
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
    _ctl('address', s['address']);
    _ctl('mg_name', _m['name']);
    _ctl('mg_nid', _m['national_id']);
    _ctl('mg_phone', _m['phone']);
    _ctl('mg_user', _m['username']);
    _ctl('mg_pass', '');
    _province = iranProvinces.contains(s['province']) ? '${s['province']}' : '';
    _areaKind = s['area_kind'] == 'village' ? 'village' : 'district';
    _active = s['active'] != false;
  }

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _t(String k) => _c[k]!.text.trim();

  /// فقط بخش مالک؛ بقیهٔ مشخصات (اگر مدرسهٔ قدیمی داشته باشد) دست‌نخورده می‌ماند.
  Map<String, Object?> _collect() => {
    'name': _t('name'),
    'code': _t('code'),
    'province': _province,
    'county': _t('county'),
    'district': _t('district'),
    'area_kind': _areaKind,
    'address': _t('address'),
    'active': _active,
    'manager': {
      'name': _t('mg_name'),
      'national_id': _t('mg_nid'),
      'phone': _t('mg_phone'),
      'username': _t('mg_user').toLowerCase(),
    },
  };

  void _submit() {
    // درخواست ثبت‌نام یا مدرسهٔ قدیمی ممکن است مقطع/تلفن/آمار داشته باشد: حفظ می‌شود.
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
              _text('address', 'آدرس', lines: 2),
              _select('active', 'وضعیت', _active ? '1' : '0', const {
                '1': 'فعال',
                '0': 'غیرفعال',
              }, (v) => _active = v == '1'),
              _muted(
                'مقطع، نوع، جنسیت، ظرفیت، شیفت، تلفن‌ها، تعداد کارکنان و دانش‌آموزان، روزهای کاری، پنجرهٔ موجه و قابلیت‌ها را خود مدیر پس از ورود در «سیستم ← مشخصات مدرسه» تعیین می‌کند.',
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
