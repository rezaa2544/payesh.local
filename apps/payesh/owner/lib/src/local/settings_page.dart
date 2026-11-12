import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 's3_client.dart';

/// صفحهٔ «تنظیمات» داخل برنامه: دیتابیس (فضای ابری S3) و سرور پلتفرم.
class OwnerSettingsPage extends StatelessWidget {
  const OwnerSettingsPage({
    super.key,
    required this.database,
    required this.server,
  });
  final Widget database;
  final Widget server;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(PayeshTokens.space4),
    children: [
      Align(
        alignment: AlignmentDirectional.topStart,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              database,
              const SizedBox(height: PayeshTokens.space4),
              server,
            ],
          ),
        ),
      ),
    ],
  );
}

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.subtitle,
    required this.children,
  });
  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(subtitle, style: TextStyle(color: context.tokens.muted)),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    ),
  );
}

Widget _msg(BuildContext context, String key, String? text, bool ok) =>
    text == null
    ? const SizedBox.shrink()
    : Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(
          text,
          key: Key(key),
          style: TextStyle(
            color: ok ? context.tokens.success : context.tokens.danger,
          ),
        ),
      );

Widget _input(
  String key,
  TextEditingController c,
  String label, {
  bool secret = false,
  bool digits = false,
  String? hint,
  Widget? suffix,
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
      suffixIcon: suffix,
    ),
  ),
);

/// دیتابیس: آدرس، Access Key، Secret Key، آزمایش اتصال (ListBuckets با SigV4) و ذخیرهٔ امن.
class DatabaseSettingsPanel extends StatefulWidget {
  const DatabaseSettingsPanel({
    super.key,
    required this.secure,
    required this.transportFactory,
    this.now,
  });
  final SecureStore secure;
  final S3Transport Function() transportFactory;
  final DateTime Function()? now;

  @override
  State<DatabaseSettingsPanel> createState() => _DatabaseSettingsPanelState();
}

class _DatabaseSettingsPanelState extends State<DatabaseSettingsPanel> {
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
        _message = 'تنظیمات ذخیره‌شده بارگذاری شد.';
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
      return; // حذف ناموفق: فرم دست نمی‌خورد
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
    if (_loading) {
      return const Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: EdgeInsets.all(PayeshTokens.space4),
          child: LinearProgressIndicator(),
        ),
      );
    }
    return _Section(
      title: 'دیتابیس (فضای ابری)',
      subtitle: 'آدرس فضای ابری (مثلاً آروان‌کلاد) و کلیدهای دسترسی را وارد کنید. کلیدها فقط روی همین دستگاه و به‌صورت رمزنگاری‌شده نگه داشته می‌شوند.',
      children: [
        _msg(context, 'db-msg', _message, _messageOk),
        _input(
          'db-endpoint',
          _endpoint,
          'آدرس دیتابیس',
          hint: 's3.ir-central1.arvanstorage.ir',
        ),
        _input('db-access', _access, 'Access Key'),
        _input(
          'db-secret',
          _secret,
          'Secret Key',
          secret: !_showSecret,
          suffix: IconButton(
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
      ],
    );
  }
}

/// سرور پلتفرم (اختیاری): نشانی + ورود به حساب سرور. بخش‌های مدارس، پلن‌ها و … از آن خوانده می‌شوند.
class ServerSettingsPanel extends StatefulWidget {
  const ServerSettingsPanel({
    super.key,
    required this.origin,
    required this.session,
    required this.onSaveOrigin,
    required this.onLogin,
    required this.onDisconnect,
  });
  final Uri? origin;
  final OwnerSession? session;
  final Future<void> Function(Uri origin) onSaveOrigin;
  final Future<String?> Function(String id, String password, String totp)
  onLogin;
  final VoidCallback onDisconnect;

  @override
  State<ServerSettingsPanel> createState() => _ServerSettingsPanelState();
}

class _ServerSettingsPanelState extends State<ServerSettingsPanel> {
  late final _origin = TextEditingController(
    text: widget.origin == null ? '' : originText(widget.origin!),
  );
  final _id = TextEditingController();
  final _pw = TextEditingController();
  final _totp = TextEditingController();
  String? _message;
  bool _ok = false;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_origin, _id, _pw, _totp]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _saveOrigin() async {
    final o = normalizeOrigin(_origin.text);
    if (o == null) {
      setState(() {
        _message = 'نشانی معتبر نیست: فقط https://نام‌سرور[:درگاه] (یا http://127.0.0.1 برای آزمایش محلی)، بدون مسیر.';
        _ok = false;
      });
      return;
    }
    await widget.onSaveOrigin(o);
    if (!mounted) return;
    setState(() {
      _message = 'نشانی سرور ذخیره شد. حالا با حساب سرور وارد شوید.';
      _ok = true;
    });
  }

  Future<void> _login() async {
    if (_busy) return;
    final id = _id.text, pw = _pw.text, code = _totp.text;
    _pw.clear();
    _totp.clear();
    setState(() => _busy = true);
    final err = await widget.onLogin(id, pw, code);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _message = err ?? 'به سرور پلتفرم وصل شدید.';
      _ok = err == null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    return _Section(
      title: 'سرور پلتفرم (اختیاری)',
      subtitle: 'بخش‌های داشبورد، مدارس، پلن‌ها، سقف‌ها، سلامت، زیرساخت، اپراتورها، گزارش‌ها و ممیزی از سرور پلتفرم خوانده می‌شوند.',
      children: [
        _msg(context, 'srv-msg', _message, _ok),
        _input(
          'srv-origin',
          _origin,
          'نشانی سرور',
          hint: 'https://owner.example.ir',
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: OutlinedButton(
            key: const Key('srv-origin-save'),
            onPressed: _saveOrigin,
            child: const Text('ذخیرهٔ نشانی'),
          ),
        ),
        if (widget.origin != null && s == null) ...[
          const SizedBox(height: 16),
          _input('srv-id', _id, 'شناسهٔ ورود سرور'),
          _input('srv-pw', _pw, 'رمز عبور سرور', secret: true),
          _input('srv-totp', _totp, 'کد دومرحله‌ای سرور', digits: true),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: FilledButton(
              key: const Key('srv-login'),
              onPressed: _busy ? null : _login,
              child: const Text('ورود به سرور'),
            ),
          ),
        ],
        if (s != null) ...[
          const SizedBox(height: 16),
          Text(
            'وصل است — نقش: ${s.role.label}',
            key: const Key('srv-status'),
            style: TextStyle(color: context.tokens.success),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(
              key: const Key('srv-disconnect'),
              onPressed: widget.onDisconnect,
              child: const Text('قطع اتصال از سرور'),
            ),
          ),
        ],
      ],
    );
  }
}
