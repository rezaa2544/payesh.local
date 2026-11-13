import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'session_controller.dart';

/// Row 145 — «درخواست ثبت نام مدرسه جدید» (کنار ورود با نام کاربری و رمز).
///
/// فیلدها (خواستهٔ مالک): نام مدرسه، مقطع، مکان (استان، شهرستان، روستا)، شمارهٔ تلفن کامل،
/// تعداد کارکنان و دانش‌آموزان؛ به‌علاوهٔ نام مدیر و نام کاربری/رمزی که مدیر پس از تأیید با آن
/// وارد می‌شود. درخواست از راه همین سرور مدرسه به دیتابیس و پنل مالک می‌رود.
class SignupScreen extends StatefulWidget {
  const SignupScreen({
    super.key,
    required this.controller,
    required this.state,
  });
  final SessionController controller;
  final NeedSignup state;

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  final _c = {
    for (final k in [
      'school',
      'county',
      'village',
      'phone',
      'staff',
      'students',
      'manager',
      'username',
      'password',
    ])
      k: TextEditingController(),
  };
  String? _level;
  String? _province;

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  Widget _field(
    String k,
    String label, {
    bool ltr = false,
    bool numeric = false,
    bool secret = false,
    String? hint,
    TextInputType? keyboard,
  }) {
    final busy = widget.controller.busy;
    return Padding(
      padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
      child: TextField(
        key: Key('signup-$k'),
        controller: _c[k],
        enabled: !busy,
        obscureText: secret,
        autocorrect: false,
        enableSuggestions: !secret,
        textDirection: ltr ? TextDirection.ltr : null,
        keyboardType: numeric ? TextInputType.number : keyboard,
        inputFormatters: numeric
            ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9۰-۹٠-٩]'))]
            : null,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }

  Widget _select(
    String k,
    String label,
    String? value,
    List<String> options,
    ValueChanged<String?> onChanged,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
    child: DropdownButtonFormField<String>(
      key: Key('signup-$k'),
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: [
        for (final o in options) DropdownMenuItem(value: o, child: Text(o)),
      ],
      onChanged: widget.controller.busy
          ? null
          : (v) => setState(() => onChanged(v)),
    ),
  );

  void _submit() => widget.controller.submitSignup(
    SchoolSignup(
      schoolName: _c['school']!.text,
      level: _level ?? '',
      province: _province ?? '',
      county: _c['county']!.text,
      village: _c['village']!.text,
      phone: _c['phone']!.text,
      staffCount: _c['staff']!.text,
      studentCount: _c['students']!.text,
      managerName: _c['manager']!.text,
      username: _c['username']!.text,
      password: _c['password']!.text,
    ),
  );

  Widget _frame(List<Widget> children) => Scaffold(
    appBar: AppBar(
      title: const Text('درخواست ثبت نام مدرسه جدید'),
      leading: IconButton(
        key: const Key('signup-back'),
        tooltip: 'بازگشت به ورود',
        icon: const BackButtonIcon(),
        onPressed: widget.controller.busy
            ? null
            : () => widget.controller.closeSignup(),
      ),
    ),
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space5),
            children: children,
          ),
        ),
      ),
    ),
  );

  Widget _error(String? e) => e == null
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
          child: Semantics(
            liveRegion: true,
            child: Text(
              e,
              key: const Key('signup-error'),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        );

  Widget _busyOr(String label) => widget.controller.busy
      ? const SizedBox.square(
          dimension: 20,
          child: CircularProgressIndicator(
            key: Key('login-busy'),
            strokeWidth: 2,
          ),
        )
      : Text(label);

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final s = widget.state;
    final t = s.ticket;
    if (t != null) return _status(c, s, t);
    return _frame([
      Text(
        'پس از بررسی و تأیید پشتیبانی پایش، پنل مدرسه ساخته می‌شود و مدیر با همین نام کاربری و رمز وارد می‌شود. '
        'امکانات پس از خرید اشتراک — یا در دورهٔ آزمایشی، اگر تعریف شده باشد — فعال می‌شوند.',
        key: const Key('signup-help'),
        style: Theme.of(context).textTheme.bodyMedium,
      ),
      const SizedBox(height: PayeshTokens.space4),
      _field('school', 'نام مدرسه *'),
      _select('level', 'مقطع *', _level, signupLevels, (v) => _level = v),
      Text('مکان', style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: PayeshTokens.space2),
      _select(
        'province',
        'استان *',
        _province,
        signupProvinces,
        (v) => _province = v,
      ),
      _field('county', 'شهرستان *'),
      _field('village', 'روستا / منطقه'),
      _field(
        'phone',
        'شمارهٔ تلفن کامل *',
        ltr: true,
        numeric: true,
        hint: '09121234567',
      ),
      _field('staff', 'تعداد کارکنان *', numeric: true),
      _field('students', 'تعداد دانش‌آموزان *', numeric: true),
      Text('حساب مدیر', style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: PayeshTokens.space2),
      _field('manager', 'نام و نام خانوادگی مدیر *'),
      _field(
        'username',
        'نام کاربری (حروف انگلیسی) *',
        ltr: true,
        keyboard: TextInputType.visiblePassword,
        hint: 'ali.rezaei',
      ),
      _field(
        'password',
        'رمز عبور (دست‌کم ۶ نویسه) *',
        ltr: true,
        secret: true,
      ),
      _error(s.error),
      FilledButton(
        key: const Key('signup-submit'),
        onPressed: c.busy ? null : _submit,
        child: _busyOr('ارسال درخواست'),
      ),
    ]);
  }

  Widget _status(SessionController c, NeedSignup s, SignupTicket t) {
    final st = s.status;
    final tone = switch (st?.status) {
      'approved' => PayeshTone.success,
      'rejected' || 'inactive' => PayeshTone.danger,
      _ => PayeshTone.warning,
    };
    return _frame([
      PayeshSection(
        title: t.schoolName.isEmpty ? 'درخواست شما' : t.schoolName,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            StatusBadge(
              st?.titleFa ?? 'در حال بررسی وضعیت…',
              key: const Key('signup-status'),
              tone: tone,
            ),
            const SizedBox(height: PayeshTokens.space3),
            SelectableText(
              'کد پیگیری: ${t.id}',
              key: const Key('signup-id'),
              textDirection: TextDirection.ltr,
            ),
            Text(
              'نام کاربری مدیر: ${t.username}',
              key: const Key('signup-username'),
            ),
            if (st?.status == 'rejected' && (st?.reason ?? '').isNotEmpty) ...[
              const SizedBox(height: PayeshTokens.space2),
              Text('دلیل: ${st!.reason}', key: const Key('signup-reason')),
            ],
            if (st?.approved == true) ...[
              const SizedBox(height: PayeshTokens.space2),
              Text(
                s.info.setupDone
                    // each school runs on its own server (row 127 / 145): a server that already
                    // hosts another school cannot host this one
                    ? 'پنل مدرسه ساخته شد. این سرور میزبان مدرسهٔ دیگری است؛ سرور پایش را روی رایانهٔ مدرسهٔ خودتان نصب کنید و در آن با همین نام کاربری و رمز وارد شوید.'
                    : 'پنل مدرسه ساخته شد. با نام کاربری و رمزی که هنگام درخواست انتخاب کردید وارد شوید؛ همین سرور میزبان مدرسهٔ شما می‌شود.',
                key: const Key('signup-approved'),
              ),
            ],
            if (st == null || st.status == 'pending') ...[
              const SizedBox(height: PayeshTokens.space2),
              const Text(
                'درخواست شما ثبت شد و در صف بررسی پشتیبانی پایش است. هر زمان خواستید «بررسی وضعیت» را بزنید.',
                key: Key('signup-pending'),
              ),
            ],
          ],
        ),
      ),
      const SizedBox(height: PayeshTokens.space3),
      _error(s.error),
      if (st?.approved == true)
        FilledButton(
          key: const Key('signup-login'),
          onPressed: c.busy
              ? null
              : () => c.closeSignup(login: st?.username ?? t.username),
          child: const Text('ورود'),
        )
      else
        FilledButton(
          key: const Key('signup-check'),
          onPressed: c.busy ? null : c.checkSignup,
          child: _busyOr('بررسی وضعیت'),
        ),
      const SizedBox(height: PayeshTokens.space2),
      TextButton(
        key: const Key('signup-new'),
        onPressed: c.busy ? null : c.forgetSignup,
        child: const Text('ثبت درخواست تازه'),
      ),
    ]);
  }
}
