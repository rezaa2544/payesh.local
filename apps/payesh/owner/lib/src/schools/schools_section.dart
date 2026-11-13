// صفحهٔ «مدارس» — بخش برگردان p2: فهرست مدارس، ساخت دستی (نوع ۱) و درخواست‌های
// ثبت‌نام مدرسهٔ جدید (نوع ۲). داده در صندوقچه (schools/registry.json) است؛ سرورهای مدرسه
// همان را دنبال می‌کنند.

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'school_form.dart';
import 'school_registry.dart';

/// بارگذاری و تغییر مشترک بخش‌های مدارس/اشتراک.
mixin RegistryLoader<T extends StatefulWidget> on State<T> {
  SchoolRegistry get registry;
  void Function(bool ok, String text) get flash;

  SchoolsView? view;
  bool busy = true;

  @override
  void initState() {
    super.initState();
    reloadRegistry();
  }

  Future<void> reloadRegistry() async {
    if (mounted) setState(() => busy = true);
    final v = await registry.load();
    if (!mounted) return;
    setState(() {
      view = v;
      busy = false;
    });
  }

  /// یک تغییر؛ پیام نتیجه و بارگذاری دوباره.
  Future<bool> change(Future<Object?> Function() f, String okText) async {
    try {
      await f();
    } on SchoolsFailure catch (e) {
      // ردیف ۱۵۴: دستور در صف ماند (گم نمی‌شود) ⇒ پیام هشدار، نه شکست
      if (e.code == 'queued') {
        flash(true, e.messageFa);
        return true;
      }
      flash(false, e.messageFa);
      return false;
    }
    flash(true, okText);
    await reloadRegistry();
    return true;
  }
}

/// عدد با رقم فارسی و جداکنندهٔ هزارگان (رشته/عدد/null).
String faNum(Object? v) {
  final n = v is num ? v.round() : int.tryParse(digitsOnly('${v ?? ''}'));
  return n == null ? '—' : faNumber(n);
}

/// دیتابیس در دسترس نیست: هشدار (نه خطای صفحه)؛ داده‌های همین دستگاه نشان داده می‌شود.
class OfflineNote extends StatelessWidget {
  const OfflineNote(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Row(
    key: const Key('schools-offline'),
    children: [
      const Pill('دیتابیس وصل نیست', tone: PayeshTone.warning),
      const SizedBox(width: 8),
      Expanded(child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
    ],
  );
}

String placeText(Map<String, Object?> s) {
  final parts = [
    for (final k in const ['province', 'county', 'district'])
      if ('${s[k] ?? ''}'.trim().isNotEmpty) '${s[k]}'.trim(),
  ];
  if (parts.isEmpty) return '—';
  return parts.join(' › ') + (s['area_kind'] == 'village' ? ' (روستایی)' : '');
}

Map<String, Object?> managerOf(Map<String, Object?> s) => s['manager'] is Map
    ? (s['manager']! as Map).cast<String, Object?>()
    : const {};

class SchoolsRegistrySection extends StatefulWidget {
  const SchoolsRegistrySection({
    super.key,
    required this.registry,
    required this.flash,
    this.canManage = true,
  });
  final SchoolRegistry registry;
  final void Function(bool ok, String text) flash;
  final bool canManage;

  @override
  State<SchoolsRegistrySection> createState() => _SchoolsRegistrySectionState();
}

class _SchoolsRegistrySectionState extends State<SchoolsRegistrySection>
    with RegistryLoader {
  @override
  SchoolRegistry get registry => widget.registry;
  @override
  void Function(bool ok, String text) get flash => widget.flash;

  List<Map<String, Object?>> get _schools => view?.schools ?? const [];

  Future<void> _create() async {
    final r = await showSchoolForm(context, schools: _schools);
    if (r == null || !mounted) return;
    await change(
      () => registry.createSchool(r.fields, password: r.password),
      'مدرسه و حساب مدیر ثبت شد؛ مدیر با همین نام کاربری و رمز در پنل کاربران وارد می‌شود.',
    );
  }

  Future<void> _edit(Map<String, Object?> s) async {
    final r = await showSchoolForm(
      context,
      schools: _schools,
      initial: s,
      mode: 'edit',
      selfId: '${s['id']}',
    );
    if (r == null || !mounted) return;
    await change(
      () => registry.updateSchool(
        '${s['id']}',
        r.fields,
        password: r.password.isEmpty ? null : r.password,
      ),
      'تغییرات ذخیره شد',
    );
  }

  Future<void> _toggle(Map<String, Object?> s) async {
    final on = s['active'] != false;
    final d = await showReasonDialog(
      context,
      title: on ? 'غیرفعال کردن مدرسه' : 'فعال کردن مدرسه',
      danger: on,
      submit: on ? 'غیرفعال کن' : 'فعال کن',
      lines: [
        on
            ? 'با غیرفعال شدن «${s['name']}»، هیچ کاربری از این مدرسه نمی‌تواند وارد شود (p2). داده‌ها دست‌نخورده می‌مانند.'
            : 'کاربران «${s['name']}» دوباره می‌توانند وارد شوند.',
      ],
    );
    if (d == null) return;
    await change(
      () => registry.setActive('${s['id']}', !on),
      on ? 'مدرسه غیرفعال شد' : 'مدرسه فعال شد',
    );
  }

  Future<void> _password(Map<String, Object?> s) async {
    final d = await showReasonDialog(
      context,
      title: 'رمز تازهٔ مدیر «${s['name']}»',
      submit: 'ثبت رمز',
      lines: [
        'نام کاربری مدیر: ${managerOf(s)['username'] ?? '—'}. رمز تازه چند ثانیه بعد روی سرور مدرسه اعمال می‌شود.',
      ],
      fields: const [
        TextDialogField('password', 'رمز تازه (دست‌کم ۶ نویسه)', ltr: true),
      ],
      validate: (v) => v.text('password').length < 6
          ? 'رمز ورود مدیر دست‌کم ۶ نویسه باشد'
          : null,
    );
    if (d == null) return;
    await change(
      () => registry.resetManagerPassword('${s['id']}', d.text('password')),
      'رمز تازهٔ مدیر ثبت شد',
    );
  }

  Future<void> _gift(Map<String, Object?> s) async {
    final d = await showReasonDialog(
      context,
      title: '🎁 فعال‌سازی اشتراک «${s['name']}»',
      submit: 'فعال‌سازی',
      lines: const [
        'اشتراک کاربران این مدرسه (همهٔ نقش‌ها یا فقط یک نقش) به این تعداد روز تمدید می‌شود (p2: «🎁 فعال‌سازی»).',
      ],
      fields: [
        const TextDialogField(
          'days',
          'تعداد روز',
          numeric: true,
          initial: '30',
        ),
        SelectDialogField('role', 'برای', {
          '': 'همهٔ کاربران مدرسه',
          for (final r in subRoles) r: 'فقط ${subRoleTitles[r]}',
        }, initial: 'manager'),
      ],
      validate: (v) {
        final n = int.tryParse(digitsOnly(v.text('days')));
        return n == null || n < 1 || n > 3650
            ? 'تعداد روز باید بین ۱ تا ۳۶۵۰ باشد.'
            : null;
      },
    );
    if (d == null) return;
    final role = d.text('role');
    await change(
      () => registry.grant(
        '${s['id']}',
        'gift',
        days: int.parse(digitsOnly(d.text('days'))),
        role: role.isEmpty ? null : role,
      ),
      'فعال‌سازی ثبت شد؛ سرور مدرسه تا یک دقیقهٔ دیگر اعمال می‌کند.',
    );
  }

  Future<void> _remove(Map<String, Object?> s) async {
    final d = await showReasonDialog(
      context,
      title: 'حذف مدرسه از فهرست',
      danger: true,
      submit: 'حذف',
      retype: '${s['code']}',
      lines: [
        '«${s['name']}» از فهرست مدارس پایش حذف می‌شود و هیچ کاربری از آن نمی‌تواند وارد شود.',
        'داده‌های مدرسه روی سرور خودش و در دیتابیس نگه داشته می‌شود (هیچ داده‌ای از این پنل نابود نمی‌شود).',
      ],
    );
    if (d == null) return;
    await change(() => registry.removeSchool('${s['id']}'), 'مدرسه حذف شد');
  }

  Future<void> _approve(Map<String, Object?> r) async {
    final id = '${r['id']}';
    final res = await showSchoolForm(
      context,
      schools: _schools,
      mode: 'approve',
      initial: {
        'name': r['school_name'],
        'code': 'R${id.substring(5, 13)}',
        'province': r['province'],
        'county': r['county'],
        'district': r['village'],
        'area_kind': '${r['village'] ?? ''}'.trim().isEmpty
            ? 'district'
            : 'village',
        'level': r['level'],
        'phone': r['phone'],
        'staff_count': r['staff_count'],
        'student_count': r['student_count'],
        'school_type': '${r['village'] ?? ''}'.trim().isEmpty
            ? 'governmental'
            : 'rural',
        'capabilities': capsForType(
          '${r['village'] ?? ''}'.trim().isEmpty ? 'governmental' : 'rural',
        ),
        'manager': {
          'name': r['manager_name'],
          'phone': r['phone'],
          'username': r['username'],
        },
      },
    );
    if (res == null || !mounted) return;
    await change(
      () => registry.approveRequest(r, res.fields),
      'درخواست تأیید و پنل مدرسه ساخته شد؛ مدیر اکنون می‌تواند وارد شود (امکانات پس از اشتراک یا دورهٔ آزمایشی).',
    );
  }

  Future<void> _reject(Map<String, Object?> r) async {
    final d = await showReasonDialog(
      context,
      title: 'رد درخواست «${r['school_name']}»',
      danger: true,
      submit: 'رد درخواست',
      lines: const ['دلیل (همان «توضیح» زیر) به متقاضی نمایش داده می‌شود.'],
    );
    if (d == null) return;
    await change(
      () => registry.rejectRequest('${r['id']}', d.reason),
      'درخواست رد شد',
    );
  }

  Widget _host(Map<String, Object?> s) {
    final a = view?.acks['${s['id']}'];
    if (a == null) {
      return const Pill('هنوز وارد نشده', key: Key('host-none'));
    }
    final at = DateTime.tryParse('${a['at']}');
    final fresh =
        at != null &&
        DateTime.now().difference(at) < const Duration(minutes: 5);
    final users = a['users'] is Map ? (a['users']! as Map)['total'] : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Pill(
          fresh ? 'سرور وصل' : 'آخرین گزارش',
          tone: fresh ? PayeshTone.success : PayeshTone.warning,
        ),
        Text(faDate(a['at']), style: const TextStyle(fontSize: 11)),
        if (users != null)
          Text('${faNum(users)} کاربر', style: const TextStyle(fontSize: 11)),
      ],
    );
  }

  Widget _actions(Map<String, Object?> s) {
    if (!widget.canManage) return const Pill('فقط مشاهده');
    final id = '${s['id']}';
    final on = s['active'] != false;
    return ActionRow([
      actionButton('school-edit-$id', 'ویرایش', () => _edit(s)),
      actionButton(
        'school-toggle-$id',
        on ? 'غیرفعال' : 'فعال',
        () => _toggle(s),
      ),
      actionButton('school-pass-$id', 'رمز مدیر', () => _password(s)),
      actionButton('school-gift-$id', '🎁 فعال‌سازی', () => _gift(s)),
      actionButton('school-del-$id', 'حذف', () => _remove(s), danger: true),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final v = view;
    Widget list;
    if (busy && v == null) {
      list = const StateBox.loading('در حال دریافت مدارس…');
    } else if (_schools.isEmpty) {
      list = const StateBox.empty(
        'هنوز مدرسه‌ای تعریف نشده است. «تعریف مدرسه جدید» را بزنید یا درخواست‌های ثبت‌نام را تأیید کنید.',
      );
    } else {
      list = OwnerTable(
        columns: const [
          'مدرسه',
          'مقطع',
          'مکان',
          'مدیر (نام کاربری)',
          'سرور مدرسه',
          'وضعیت',
          'عملیات',
        ],
        rows: [
          for (final s in _schools)
            [
              Text(
                '${s['name']} (${s['code']})',
                key: Key('reg-school-${s['id']}'),
              ),
              '${s['level'] ?? '—'}',
              placeText(s),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('${managerOf(s)['name'] ?? '—'}'),
                  Code('${managerOf(s)['username'] ?? ''}'),
                ],
              ),
              _host(s),
              Pill(
                s['active'] == false ? 'غیرفعال' : 'فعال',
                tone: s['active'] == false
                    ? PayeshTone.danger
                    : PayeshTone.success,
              ),
              _actions(s),
            ],
        ],
      );
    }
    final reqs = v?.requests ?? const <Map<String, Object?>>[];
    Widget reqBox;
    if (busy && v == null) {
      reqBox = const StateBox.loading('در حال دریافت درخواست‌ها…');
    } else if (reqs.isEmpty) {
      reqBox = const StateBox.empty('درخواست ثبت‌نام تازه‌ای نیست.');
    } else {
      reqBox = OwnerTable(
        columns: const [
          'زمان',
          'مدرسه',
          'مقطع',
          'مکان',
          'تلفن',
          'کارکنان / دانش‌آموزان',
          'مدیر',
          'عملیات',
        ],
        rows: [
          for (final r in reqs)
            [
              faDate(r['at']),
              Text('${r['school_name']}', key: Key('req-${r['id']}')),
              '${r['level'] ?? '—'}',
              placeText({
                'province': r['province'],
                'county': r['county'],
                'district': r['village'],
                'area_kind': '${r['village'] ?? ''}'.trim().isEmpty
                    ? 'district'
                    : 'village',
              }),
              Code('${r['phone'] ?? ''}'),
              '${faNum(r['staff_count'] ?? 0)} / ${faNum(r['student_count'] ?? 0)}',
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('${r['manager_name'] ?? '—'}'),
                  Code('${r['username'] ?? ''}'),
                ],
              ),
              widget.canManage
                  ? ActionRow([
                      actionButton(
                        'req-approve-${r['id']}',
                        'تأیید و ساخت',
                        () => _approve(r),
                        primary: true,
                      ),
                      actionButton(
                        'req-reject-${r['id']}',
                        'رد',
                        () => _reject(r),
                      ),
                    ])
                  : const Pill('فقط مشاهده'),
            ],
        ],
      );
    }
    return Column(
      key: const Key('schools-registry'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PayeshSection(
          title: 'مدارس',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (v != null && !v.connected)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: OfflineNote(
                    '${v.error ?? 'دیتابیس در دسترس نیست.'} (آخرین نسخهٔ همین دستگاه نمایش داده می‌شود)',
                  ),
                ),
              ActionRow([
                if (widget.canManage)
                  actionButton(
                    'p2-create-school',
                    'تعریف مدرسه جدید',
                    _create,
                    primary: true,
                  ),
                actionButton('schools-refresh', 'بروزرسانی', reloadRegistry),
              ]),
              const SizedBox(height: 8),
              list,
              const Notice(
                'مدیر هر مدرسه با نام کاربری و رمزی که این‌جا تعیین می‌شود در «پنل کاربران» وارد می‌شود؛ سرور مدرسه با اولین ورود او، همین مدرسه را می‌سازد و ورودی‌ها، دبیران و کاربران را خود مدیر تعریف می‌کند.',
              ),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: reqs.isEmpty
              ? 'درخواست‌های ثبت‌نام مدرسهٔ جدید'
              : 'درخواست‌های ثبت‌نام مدرسهٔ جدید (${faNum(reqs.length)})',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              reqBox,
              const Notice(
                'این درخواست‌ها از بخش «درخواست ثبت نام مدرسه جدید» صفحهٔ ورود پنل کاربران (و بعداً سایت معرفی) می‌آیند. پس از تأیید، مدیر وارد می‌شود ولی تا خرید اشتراک یا شروع دورهٔ آزمایشی هیچ امکانی فعال نیست.',
              ),
            ],
          ),
        ),
      ],
    );
  }
}
