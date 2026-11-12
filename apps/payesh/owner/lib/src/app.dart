import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'platform.dart';
import 'shell.dart';

const _themeLabels = {
  ThemeMode.system: 'پوسته: سیستم',
  ThemeMode.light: 'پوسته: روشن',
  ThemeMode.dark: 'پوسته: تاریک',
};

/// Root of the native owner app: server origin → password + TOTP login → panel.
class OwnerApp extends StatefulWidget {
  const OwnerApp({
    super.key,
    required this.store,
    required this.httpFactory,
    this.now,
  });

  final SettingsStore store;
  final OwnerHttp Function() httpFactory;
  final DateTime Function()? now;

  @override
  State<OwnerApp> createState() => _OwnerAppState();
}

class _OwnerAppState extends State<OwnerApp> {
  bool _loading = true;
  Uri? _origin;
  OwnerApi? _api;
  ThemeMode _theme = ThemeMode.system;
  String? _loginNotice;
  bool _changingServer = false;
  final _nav = GlobalKey<NavigatorState>();

  /// Session over: close every dialog / sheet above the home screen.
  void _closeRoutes() => _nav.currentState?.popUntil((r) => r.isFirst);

  DateTime _now() => (widget.now ?? DateTime.now)();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final o = normalizeOrigin(await widget.store.read('origin'));
    final t = await widget.store.read('theme');
    if (!mounted) return;
    setState(() {
      _theme = switch (t) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      };
      _loading = false;
      if (o != null) _connect(o);
    });
  }

  void _connect(Uri origin) {
    _api?.close();
    _origin = origin;
    _api = OwnerApi(
      origin: origin,
      http: widget.httpFactory(),
      now: _now,
      onUnauthorized: () {
        if (!mounted) return;
        _closeRoutes();
        setState(() => _loginNotice = ownerErrors['unauthorized']);
      },
    );
  }

  Future<void> _saveOrigin(Uri origin) async {
    await widget.store.write('origin', originText(origin));
    if (!mounted) return;
    setState(() {
      _connect(origin);
      _changingServer = false;
      _loginNotice = null;
    });
  }

  Future<void> _cycleTheme() async {
    final next = switch (_theme) {
      ThemeMode.system => ThemeMode.light,
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
    };
    setState(() => _theme = next);
    await widget.store.write(
      'theme',
      next == ThemeMode.system ? null : next.name,
    );
  }

  void _signOut() {
    _closeRoutes();
    _api?.signOut();
    setState(() => _loginNotice = 'از پنل خارج شدید.');
  }

  @override
  void dispose() {
    _api?.close();
    super.dispose();
  }

  Widget get _themeButton => TextButton(
    key: const Key('theme'),
    onPressed: _cycleTheme,
    child: Text(_themeLabels[_theme]!),
  );

  @override
  Widget build(BuildContext context) {
    final Widget home;
    final api = _api;
    if (_loading) {
      home = const Scaffold(body: Center(child: CircularProgressIndicator()));
    } else if (api == null || _changingServer) {
      home = OriginScreen(
        initial: _origin == null ? '' : originText(_origin!),
        onSave: _saveOrigin,
        onCancel: api == null
            ? null
            : () => setState(() => _changingServer = false),
      );
    } else if (api.session == null) {
      home = LoginScreen(
        api: api,
        notice: _loginNotice,
        themeButton: _themeButton,
        onSignedIn: () => setState(() => _loginNotice = null),
        onChangeServer: () => setState(() => _changingServer = true),
      );
    } else {
      home = OwnerShell(
        api: api,
        now: _now,
        themeButton: _themeButton,
        onSignOut: _signOut,
      );
    }
    return PayeshMaterialApp(
      navigatorKey: _nav,
      title: 'پنل مالک پایش',
      themeMode: _theme,
      home: home,
    );
  }
}

/// First start (or «تغییر سرور»): the owner API origin, validated like the old shells.
class OriginScreen extends StatefulWidget {
  const OriginScreen({
    super.key,
    required this.initial,
    required this.onSave,
    this.onCancel,
  });
  final String initial;
  final Future<void> Function(Uri origin) onSave;
  final VoidCallback? onCancel;

  @override
  State<OriginScreen> createState() => _OriginScreenState();
}

class _OriginScreenState extends State<OriginScreen> {
  late final _c = TextEditingController(text: widget.initial);
  String? _error;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _save() {
    final o = normalizeOrigin(_c.text);
    if (o == null) {
      setState(
        () => _error = 'نشانی معتبر نیست: فقط https://نام‌سرور[:درگاه] (یا http://127.0.0.1 برای آزمایش محلی)، بدون مسیر.',
      );
      return;
    }
    widget.onSave(o);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('نشانی سرور پنل مالک')),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            const Text(
              'نشانی سرور API پلتفرم (Gateway یا سرور پنل مالک) را وارد کنید. این نشانی فقط روی همین دستگاه نگه داشته می‌شود؛ رمز و نشست هرگز ذخیره نمی‌شوند.',
            ),
            const SizedBox(height: PayeshTokens.space3),
            TextField(
              key: const Key('origin'),
              controller: _c,
              textDirection: TextDirection.ltr,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'نشانی سرور',
                hintText: 'https://owner.example.ir',
              ),
              onSubmitted: (_) => _save(),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  key: const Key('origin-error'),
                  style: TextStyle(color: context.tokens.danger),
                ),
              ),
            const SizedBox(height: PayeshTokens.space3),
            Row(
              children: [
                FilledButton(
                  key: const Key('origin-save'),
                  onPressed: _save,
                  child: const Text('ذخیره و ادامه'),
                ),
                if (widget.onCancel != null) ...[
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: widget.onCancel,
                    child: const Text('انصراف'),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    ),
  );
}

/// Password + six-digit TOTP (mandatory two-factor, decision D-45). Fail closed.
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.api,
    required this.onSignedIn,
    required this.onChangeServer,
    required this.themeButton,
    this.notice,
  });
  final OwnerApi api;
  final VoidCallback onSignedIn;
  final VoidCallback onChangeServer;
  final Widget themeButton;
  final String? notice;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _id = TextEditingController();
  final _pw = TextEditingController();
  final _totp = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _id.dispose();
    _pw.dispose();
    _totp.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final id = _id.text, pw = _pw.text, code = _totp.text;
    _pw.clear();
    _totp.clear();
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await widget.api.login(loginId: id, password: pw, totp: code);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r.ok) {
      widget.onSignedIn();
    } else {
      setState(() => _error = r.error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final msg = _error ?? widget.notice;
    return Scaffold(
      appBar: AppBar(
        title: const Text('پنل مالک پلتفرم پایش'),
        actions: [widget.themeButton],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Card(
            margin: const EdgeInsets.all(PayeshTokens.space4),
            child: AutofillGroup(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.all(PayeshTokens.space4),
                children: [
                  Text(
                    'ورود به پنل مالک',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'این برنامه از برنامهٔ مدرسه جداست. ورود دومرحله‌ای (TOTP) اجباری است.',
                    style: TextStyle(color: tk.muted),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'سرور: ${originText(widget.api.origin)}',
                    key: const Key('login-origin'),
                    textDirection: TextDirection.ltr,
                    style: TextStyle(color: tk.muted, fontSize: 12),
                  ),
                  if (msg != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(
                        msg,
                        key: const Key('login-msg'),
                        style: TextStyle(
                          color:
                              _error != null ||
                                  msg == ownerErrors['unauthorized']
                              ? tk.danger
                              : tk.success,
                        ),
                      ),
                    ),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('login_id'),
                    controller: _id,
                    textDirection: TextDirection.ltr,
                    autofillHints: const [AutofillHints.username],
                    decoration: const InputDecoration(labelText: 'شناسهٔ ورود'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    key: const Key('password'),
                    controller: _pw,
                    obscureText: true,
                    textDirection: TextDirection.ltr,
                    autofillHints: const [AutofillHints.password],
                    decoration: const InputDecoration(labelText: 'رمز عبور'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    key: const Key('totp'),
                    controller: _totp,
                    textDirection: TextDirection.ltr,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    autofillHints: const [AutofillHints.oneTimeCode],
                    decoration: const InputDecoration(
                      labelText: 'کد دومرحله‌ای ۶ رقمی',
                      counterText: '',
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      FilledButton(
                        key: const Key('login-submit'),
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Text('ورود'),
                      ),
                      const Spacer(),
                      TextButton(
                        key: const Key('change-server'),
                        onPressed: widget.onChangeServer,
                        child: const Text('تغییر سرور'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
