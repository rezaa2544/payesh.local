// ردیف ۱۶۰ — کارت «ورود کاربران و پنل پیامک» در تنظیمات پنل مالک.
//
// • صفحهٔ اول ورود کاربران: «نام کاربری و رمز» (و «ورود با شماره» زیرش) یا برعکس؛
// • پنل پیامکِ کل سامانه: مالک فقط «پیوند» سرویس‌دهنده را می‌گذارد (GET یا POST، با
//   جای‌نگهدارهای {mobile} {mobile98} {code} {message} {minutes} {school})؛ همهٔ سرورهای مدرسه از
//   همین فهرست مهرشده می‌خوانند. تا پیوند خالی یا خاموش است، ورود با پیامک «به‌زودی» است و
//   صفحهٔ اول همیشه نام کاربری/رمز می‌ماند.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../widgets.dart';
import 'school_registry.dart';
import 'schools_section.dart';

class LoginMethodsSection extends StatefulWidget {
  const LoginMethodsSection({
    super.key,
    required this.registry,
    this.sender,
    this.canManage = true,
  });
  final SchoolRegistry registry;

  /// آزمون‌ها ارسال جعلی می‌دهند؛ null = HttpClient واقعی.
  final SmsSender? sender;
  final bool canManage;

  @override
  State<LoginMethodsSection> createState() => _LoginMethodsSectionState();
}

class _LoginMethodsSectionState extends State<LoginMethodsSection>
    with RegistryLoader {
  @override
  SchoolRegistry get registry => widget.registry;
  @override
  void Function(bool ok, String text) get flash => _flash;

  AuthSettings? _a;
  int _loadedRev = -1;
  (bool, String)? _msg;
  bool _testing = false;
  final _url = TextEditingController();
  final _headers = TextEditingController();
  final _body = TextEditingController();
  final _message = TextEditingController();
  final _okMatch = TextEditingController();
  final _testMobile = TextEditingController();

  void _flash(bool ok, String text) {
    if (mounted) setState(() => _msg = (ok, text));
  }

  @override
  void dispose() {
    for (final c in [_url, _headers, _body, _message, _okMatch, _testMobile]) {
      c.dispose();
    }
    super.dispose();
  }

  void _sync() {
    final v = view;
    if (v == null || v.rev == _loadedRev) return;
    _loadedRev = v.rev;
    final a = _a = v.auth;
    _url.text = a.url;
    _headers.text = a.headersText;
    _body.text = a.body;
    _message.text = a.message;
    _okMatch.text = a.okMatch;
  }

  AuthSettings _typed() => _a!.copyWith(
    url: safeSmsUrl(_url.text),
    headersText: _headers.text,
    body: _body.text,
    message: _message.text.trim().isEmpty
        ? defaultSmsMessage
        : _message.text.trim(),
    okMatch: _okMatch.text,
  );

  Future<void> _save() async {
    if (_a == null) return;
    final a = _typed();
    // فرم پس از ذخیرهٔ موفق با rev تازه دوباره پر می‌شود؛ خطا ⇒ نوشته‌های مالک می‌ماند
    await change(
      () => registry.saveAuth(a, rawUrl: _url.text),
      a.smsReady
          ? 'ذخیره شد؛ ورود با پیامک روی همهٔ سرورهای مدرسه تا یک دقیقهٔ دیگر فعال می‌شود.'
          : 'ذخیره شد؛ سرورهای مدرسه تا یک دقیقهٔ دیگر دنبال می‌کنند.',
    );
  }

  Future<void> _test() async {
    if (_a == null || _testing) return;
    final a = _typed();
    final bad = a.copyWith(enabled: true).problem(rawUrl: _url.text);
    if (bad != null) return _flash(false, bad);
    setState(() => _testing = true);
    try {
      _flash(true, await a.sendTest(_testMobile.text, sender: widget.sender));
    } on FormatException catch (e) {
      _flash(false, e.message);
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Widget _field(
    TextEditingController c,
    String key,
    String label, {
    String? hint,
    int lines = 1,
    bool ltr = true,
    TextInputType? keyboard,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: TextField(
      key: Key(key),
      controller: c,
      enabled: widget.canManage,
      minLines: lines,
      maxLines: lines == 1 ? 1 : lines + 2,
      textDirection: ltr ? TextDirection.ltr : null,
      keyboardType: keyboard,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    _sync();
    final v = view;
    final a = _a;
    if (v == null || a == null) {
      return const PayeshSection(
        title: 'ورود کاربران و پنل پیامک',
        child: StateBox.loading('در حال دریافت تنظیمات ورود…'),
      );
    }
    final edit = widget.canManage;
    final msg = _msg;
    return PayeshSection(
      key: const Key('auth-section'),
      title: 'ورود کاربران و پنل پیامک',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!v.connected)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: OfflineNote(v.error ?? 'دیتابیس در دسترس نیست.'),
            ),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: a.smsReady
                ? const Pill(
                    'پیامک فعال است',
                    key: Key('auth-sms-state'),
                    tone: PayeshTone.success,
                  )
                : const Pill(
                    'پیامک غیرفعال — به‌زودی',
                    key: Key('auth-sms-state'),
                    tone: PayeshTone.warning,
                  ),
          ),
          const SizedBox(height: 10),
          Text(
            'صفحهٔ اول ورود کاربران',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 6),
          SegmentedButton<String>(
            key: const Key('auth-primary'),
            segments: const [
              ButtonSegment(
                value: 'password',
                label: Text('نام کاربری و رمز عبور'),
                icon: Icon(Icons.password),
              ),
              ButtonSegment(
                value: 'mobile',
                label: Text('شمارهٔ همراه و کد پیامکی'),
                icon: Icon(Icons.sms_outlined),
              ),
            ],
            selected: {a.primary},
            onSelectionChanged: edit
                ? (x) =>
                      setState(() => _a = _typed().copyWith(primary: x.first))
                : null,
          ),
          Notice(
            a.primary == 'mobile' && !a.smsReady
                ? 'تا پنل پیامک وصل و روشن نشود، کاربران همچنان اول «نام کاربری و رمز» را می‌بینند تا کسی پشت پیامکِ نرسیده نماند.'
                : 'روش دیگر همیشه زیر روش اول نوشته می‌شود («ورود با شماره» یا «ورود با نام کاربری و رمز عبور»). «فراموشی رمز» هم با همین پیامک کار می‌کند.',
          ),
          const Divider(height: 28),
          SwitchListTile(
            key: const Key('auth-sms-enabled'),
            contentPadding: EdgeInsets.zero,
            value: a.enabled,
            title: const Text('ورود و بازیابی رمز با پیامک'),
            subtitle: const Text(
              'یک پنل پیامک برای کل سامانه؛ همهٔ سرورهای مدرسه از همین تنظیم استفاده می‌کنند.',
            ),
            onChanged: edit
                ? (x) => setState(() => _a = _typed().copyWith(enabled: x))
                : null,
          ),
          _field(
            _url,
            'auth-sms-url',
            'پیوند پنل پیامک',
            hint: 'https://…/send?to={mobile}&text={message}  یا  …/verify?receptor={mobile}&token={code}',
          ),
          Row(
            children: [
              const Text('روش درخواست:'),
              const SizedBox(width: 8),
              SegmentedButton<String>(
                key: const Key('auth-sms-method'),
                segments: const [
                  ButtonSegment(value: 'GET', label: Text('GET')),
                  ButtonSegment(value: 'POST', label: Text('POST')),
                ],
                selected: {a.method},
                onSelectionChanged: edit
                    ? (x) => setState(
                        () => _a = _typed().copyWith(method: x.first),
                      )
                    : null,
              ),
              const Spacer(),
              const Text('طول کد:'),
              const SizedBox(width: 8),
              DropdownButton<int>(
                key: const Key('auth-sms-length'),
                value: a.codeLength,
                items: [
                  for (var n = 4; n <= 8; n++)
                    DropdownMenuItem(value: n, child: Text(faNumber(n))),
                ],
                onChanged: edit
                    ? (n) => setState(
                        () => _a = _typed().copyWith(codeLength: n ?? 6),
                      )
                    : null,
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (a.method == 'POST')
            _field(
              _body,
              'auth-sms-body',
              'بدنهٔ درخواست (JSON یا فرم)',
              hint: '{"mobile":"{mobile}","code":"{code}"}',
              lines: 3,
            ),
          _field(
            _headers,
            'auth-sms-headers',
            'سرآیندها (هر خط «نام: مقدار»، اختیاری)',
            hint: 'x-api-key: …',
            lines: 2,
          ),
          _field(
            _message,
            'auth-sms-message',
            'متن پیامک ({message})',
            lines: 2,
            ltr: false,
          ),
          _field(
            _okMatch,
            'auth-sms-ok',
            'نشانهٔ موفقیت در پاسخ (اختیاری)',
            hint: 'مثلاً "status":200 — خالی = هر پاسخ 2xx',
          ),
          const Notice(
            'جای‌نگهدارها: {mobile} شمارهٔ ۰۹… · {mobile98} شمارهٔ ۹۸… · {code} کد · {message} متن بالا · {minutes} اعتبار (دقیقه) · {school} نام مدرسه. کد فقط درهم‌سازی‌شده در سرور مدرسه می‌ماند، ۲ دقیقه اعتبار دارد، ۵ بار امتحان، یک‌بارمصرف؛ هر شماره حداکثر ۵ پیامک در ساعت.',
          ),
          const SizedBox(height: 10),
          if (edit)
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('auth-test-mobile'),
                    controller: _testMobile,
                    textDirection: TextDirection.ltr,
                    keyboardType: TextInputType.phone,
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[0-9۰-۹]')),
                    ],
                    decoration: const InputDecoration(
                      labelText: 'شمارهٔ همراه برای پیامک آزمایشی',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  key: const Key('auth-test'),
                  onPressed: _testing ? null : _test,
                  icon: _testing
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send_outlined),
                  label: const Text('ارسال آزمایشی'),
                ),
              ],
            ),
          if (msg != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                msg.$2,
                key: const Key('auth-msg'),
                style: TextStyle(
                  color: msg.$1
                      ? context.tokens.success
                      : Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          const SizedBox(height: 10),
          if (edit)
            ActionRow([
              actionButton(
                'auth-save',
                'ذخیرهٔ تنظیمات ورود',
                _save,
                primary: true,
              ),
            ]),
        ],
      ),
    );
  }
}
