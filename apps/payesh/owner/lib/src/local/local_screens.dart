import 'package:flutter/material.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'local_account.dart';
import 's3_client.dart';

/// قاب مشترک: کارت وسط صفحه با عنوان و توضیح.
class _CardPage extends StatelessWidget {
  const _CardPage({
    required this.title,
    required this.subtitle,
    required this.children,
    this.actions = const <Widget>[],
    this.maxWidth = 460,
  });
  final String title;
  final String subtitle;
  final List<Widget> children;
  final List<Widget> actions;
  final double maxWidth;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('پنل مالک پلتفرم پایش'), actions: actions),
    body: Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: Card(
          margin: const EdgeInsets.all(PayeshTokens.space4),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.all(PayeshTokens.space4),
            children: [
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(subtitle, style: TextStyle(color: context.tokens.muted)),
              const SizedBox(height: 12),
              ...children,
            ],
          ),
        ),
      ),
    ),
  );
}

Widget _message(BuildContext context, String? text, {bool ok = false}) =>
    text == null
    ? const SizedBox.shrink()
    : Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(
          text,
          key: const Key('local-msg'),
          style: TextStyle(
            color: ok ? context.tokens.success : context.tokens.danger,
          ),
        ),
      );

Widget _field(
  String key,
  TextEditingController c,
  String label, {
  bool secret = false,
  bool digits = false,
  String? hint,
  ValueChanged<String>? onSubmitted,
}) => Padding(
  padding: const EdgeInsets.only(bottom: 8),
  child: TextField(
    key: Key(key),
    controller: c,
    obscureText: secret,
    textDirection: TextDirection.ltr,
    autocorrect: false,
    enableSuggestions: false,
    keyboardType: digits ? TextInputType.number : TextInputType.text,
    maxLength: digits ? 6 : null,
    decoration: InputDecoration(
      labelText: label,
      hintText: hint,
      counterText: '',
    ),
    onSubmitted: onSubmitted,
  ),
);

/// اجرای اول: مالک شناسه، رمز و کد دومرحله‌ای را روی همین دستگاه تعریف می‌کند.
class LocalSetupScreen extends StatefulWidget {
  const LocalSetupScreen({
    super.key,
    required this.onCreate,
    required this.themeButton,
  });
  final Future<String?> Function(String id, String password, String code)
  onCreate;
  final Widget themeButton;

  @override
  State<LocalSetupScreen> createState() => _LocalSetupScreenState();
}

class _LocalSetupScreenState extends State<LocalSetupScreen> {
  final _id = TextEditingController();
  final _pw = TextEditingController();
  final _pw2 = TextEditingController();
  final _code = TextEditingController(text: '123456');
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_id, _pw, _pw2, _code]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final err = validateNewAccount(
      loginId: _id.text,
      password: _pw.text,
      repeat: _pw2.text,
      code: _code.text,
    );
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final failure = await widget.onCreate(_id.text, _pw.text, _code.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
    });
  }

  @override
  Widget build(BuildContext context) => _CardPage(
    title: 'تعریف حساب مالک',
    subtitle: 'این کار فقط یک‌بار انجام می‌شود. شناسه، رمز عبور و کد دومرحله‌ای فقط روی همین دستگاه و به‌صورت رمزنگاری‌شده نگه داشته می‌شوند. ورود بعدی به اینترنت نیاز ندارد.',
    actions: [widget.themeButton],
    children: [
      _message(context, _error),
      _field('setup-id', _id, 'شناسهٔ ورود'),
      _field('setup-pw', _pw, 'رمز عبور', secret: true),
      _field('setup-pw2', _pw2, 'تکرار رمز عبور', secret: true),
      _field(
        'setup-code',
        _code,
        'کد دومرحله‌ای ۶ رقمی',
        digits: true,
        onSubmitted: (_) => _submit(),
      ),
      const SizedBox(height: 8),
      Align(
        alignment: AlignmentDirectional.centerStart,
        child: FilledButton(
          key: const Key('setup-submit'),
          onPressed: _busy ? null : _submit,
          child: const Text('ذخیره و ورود'),
        ),
      ),
    ],
  );
}

/// ورود بدون اینترنت با حساب محلی.
class LocalLoginScreen extends StatefulWidget {
  const LocalLoginScreen({
    super.key,
    required this.onLogin,
    required this.onReset,
    required this.themeButton,
    this.notice,
  });
  final String? Function(String id, String password, String code) onLogin;
  final Future<void> Function() onReset;
  final Widget themeButton;
  final String? notice;

  @override
  State<LocalLoginScreen> createState() => _LocalLoginScreenState();
}

class _LocalLoginScreenState extends State<LocalLoginScreen> {
  final _id = TextEditingController();
  final _pw = TextEditingController();
  final _code = TextEditingController();
  String? _error;

  @override
  void dispose() {
    for (final c in [_id, _pw, _code]) {
      c.dispose();
    }
    super.dispose();
  }

  void _submit() {
    final err = widget.onLogin(_id.text, _pw.text, _code.text);
    _pw.clear();
    _code.clear();
    setState(() => _error = err);
  }

  Future<void> _confirmReset() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تعریف دوباره حساب'),
        content: const Text(
          'حساب محلی و تنظیمات دیتابیس (آدرس و کلیدها) از این دستگاه پاک می‌شوند و باید از نو تعریف شوند. ادامه می‌دهید؟',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: const Key('reset-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('پاک کن'),
          ),
        ],
      ),
    );
    if (yes ?? false) await widget.onReset();
  }

  @override
  Widget build(BuildContext context) {
    final msg = _error ?? widget.notice;
    return _CardPage(
      title: 'ورود به پنل مالک',
      subtitle: 'ورود روی همین دستگاه انجام می‌شود و به اینترنت نیاز ندارد.',
      actions: [widget.themeButton],
      children: [
        _message(context, msg, ok: _error == null),
        _field('local-id', _id, 'شناسهٔ ورود'),
        _field('local-pw', _pw, 'رمز عبور', secret: true),
        _field(
          'local-code',
          _code,
          'کد دومرحله‌ای ۶ رقمی',
          digits: true,
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: 8),
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton(
              key: const Key('local-submit'),
              onPressed: _submit,
              child: const Text('ورود'),
            ),
            TextButton(
              key: const Key('local-reset'),
              onPressed: _confirmReset,
              child: const Text('فراموشی رمز / تعریف دوباره'),
            ),
          ],
        ),
      ],
    );
  }
}

/// پس از ورود: تنظیم و آزمایش دیتابیس (فضای ابری سازگار با S3).
class DatabaseSettingsScreen extends StatefulWidget {
  const DatabaseSettingsScreen({
    super.key,
    required this.secure,
    required this.transportFactory,
    required this.themeButton,
    required this.onSignOut,
    required this.onOpenServer,
    this.now,
  });
  final SecureStore secure;
  final S3Transport Function() transportFactory;
  final Widget themeButton;
  final VoidCallback onSignOut;
  final VoidCallback onOpenServer;
  final DateTime Function()? now;

  @override
  State<DatabaseSettingsScreen> createState() => _DatabaseSettingsScreenState();
}

class _DatabaseSettingsScreenState extends State<DatabaseSettingsScreen> {
  final _endpoint = TextEditingController();
  final _access = TextEditingController();
  final _secret = TextEditingController();
  bool _loading = true;
  bool _busy = false;
  bool _showSecret = false;
  bool _connected = false;
  String? _message;
  bool _messageOk = false;
  List<String> _buckets = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    S3Settings? s;
    String? err;
    try {
      s = await S3Settings.load(widget.secure);
    } on SecureStoreException {
      err = 'تنظیمات ذخیره‌شدهٔ دیتابیس خوانده نشد. لطفاً دوباره وارد کنید.';
    } on FormatException {
      err = 'تنظیمات ذخیره‌شدهٔ دیتابیس خراب است. لطفاً دوباره وارد کنید.';
    }
    if (!mounted) return;
    setState(() {
      _loading = false;
      _message = err;
      if (s != null) {
        _endpoint.text = endpointText(s.endpoint);
        _access.text = s.accessKey;
        _secret.text = s.secretKey;
        _message = 'تنظیمات ذخیره‌شده بارگذاری شد. برای بررسی، «آزمایش اتصال» را بزنید.';
        _messageOk = true;
      }
    });
  }

  @override
  void dispose() {
    for (final c in [_endpoint, _access, _secret]) {
      c.dispose();
    }
    super.dispose();
  }

  S3Settings? _form() {
    final err = validateS3Form(
      endpoint: _endpoint.text,
      accessKey: _access.text,
      secretKey: _secret.text,
    );
    if (err != null) {
      setState(() {
        _message = err;
        _messageOk = false;
      });
      return null;
    }
    return S3Settings(
      endpoint: normalizeS3Endpoint(_endpoint.text)!,
      accessKey: _access.text.trim(),
      secretKey: _secret.text.trim(),
    );
  }

  Future<void> _run({required bool save}) async {
    if (_busy) return;
    final s = _form();
    if (s == null) return;
    setState(() {
      _busy = true;
      _message = 'در حال اتصال به ${endpointText(s.endpoint)} …';
      _messageOk = true;
    });
    final t = widget.transportFactory();
    final S3TestResult r;
    try {
      r = await testS3Connection(s, t, now: widget.now);
    } finally {
      t.close();
    }
    String msg;
    var ok = r.ok;
    if (r.ok && save) {
      try {
        await s.save(widget.secure);
        msg = 'اتصال برقرار شد و تنظیمات دیتابیس ذخیره شد.';
      } on SecureStoreException {
        msg = 'اتصال برقرار شد، ولی ذخیرهٔ امن تنظیمات ممکن نشد.';
        ok = false;
      }
    } else if (r.ok) {
      msg = 'اتصال برقرار است.';
    } else {
      msg = r.error!;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _connected = r.ok;
      _buckets = r.buckets;
      _message = msg;
      _messageOk = ok;
    });
  }

  Future<void> _clear() async {
    try {
      await S3Settings.clear(widget.secure);
    } on SecureStoreException {
      // حذف ناموفق: فرم دست نمی‌خورد.
      return;
    }
    if (!mounted) return;
    setState(() {
      _endpoint.clear();
      _access.clear();
      _secret.clear();
      _connected = false;
      _buckets = const [];
      _message = 'تنظیمات دیتابیس از این دستگاه پاک شد.';
      _messageOk = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return _CardPage(
      title: 'تنظیم دیتابیس',
      subtitle: 'آدرس فضای ابری (مثلاً آروان‌کلاد) و کلیدهای دسترسی را وارد کنید. کلیدها فقط روی همین دستگاه و به‌صورت رمزنگاری‌شده نگه داشته می‌شوند.',
      maxWidth: 560,
      actions: [
        widget.themeButton,
        TextButton(
          key: const Key('local-signout'),
          onPressed: widget.onSignOut,
          child: const Text('خروج'),
        ),
      ],
      children: [
        if (_message != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              _message!,
              key: const Key('db-msg'),
              style: TextStyle(color: _messageOk ? tk.success : tk.danger),
            ),
          ),
        _field(
          'db-endpoint',
          _endpoint,
          'آدرس دیتابیس',
          hint: 's3.ir-central1.arvanstorage.ir',
        ),
        _field('db-access', _access, 'Access Key'),
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: TextField(
            key: const Key('db-secret'),
            controller: _secret,
            obscureText: !_showSecret,
            textDirection: TextDirection.ltr,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: 'Secret Key',
              suffixIcon: IconButton(
                key: const Key('db-secret-toggle'),
                tooltip: _showSecret ? 'پنهان کردن' : 'نمایش',
                icon: Icon(
                  _showSecret
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                ),
                onPressed: () => setState(() => _showSecret = !_showSecret),
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton(
              key: const Key('db-save'),
              onPressed: _busy ? null : () => _run(save: true),
              child: const Text('آزمایش اتصال و ذخیره'),
            ),
            OutlinedButton(
              key: const Key('db-test'),
              onPressed: _busy ? null : () => _run(save: false),
              child: const Text('فقط آزمایش اتصال'),
            ),
            TextButton(
              key: const Key('db-clear'),
              onPressed: _busy ? null : _clear,
              child: const Text('پاک کردن تنظیمات'),
            ),
          ],
        ),
        if (_busy)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: LinearProgressIndicator(),
          ),
        if (_connected) ...[
          const SizedBox(height: 16),
          Text(
            _buckets.isEmpty
                ? 'هنوز صندوقچه‌ای (Bucket) در این حساب نیست.'
                : 'صندوقچه‌ها (${_buckets.length}):',
            key: const Key('db-buckets-title'),
          ),
          for (final b in _buckets)
            ListTile(
              dense: true,
              leading: const Icon(Icons.inventory_2_outlined),
              title: Text(b, textDirection: TextDirection.ltr),
            ),
        ],
        const Divider(height: 32),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            key: const Key('open-server'),
            onPressed: widget.onOpenServer,
            icon: const Icon(Icons.dns_outlined),
            label: const Text('اتصال به سرور پلتفرم (اختیاری)'),
          ),
        ),
      ],
    );
  }
}
