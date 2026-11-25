import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'local_account.dart';

/// قاب مشترک: کارت وسط صفحه با عنوان و توضیح.
class _CardPage extends StatelessWidget {
  const _CardPage({
    required this.title,
    required this.subtitle,
    required this.children,
    this.actions = const <Widget>[],
  });
  final String title;
  final String subtitle;
  final List<Widget> children;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('پنل مالک پلتفرم پایش'), actions: actions),
    body: PayeshBackdrop(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Card(
            margin: const EdgeInsets.all(PayeshTokens.space4),
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.all(PayeshTokens.space4),
              children: [
                const Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: PayeshBrandMark(size: 44),
                ),
                const SizedBox(height: 12),
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
  Map<String, String> issues = const {},
  void Function(String key)? onEdit,
}) => Padding(
  padding: const EdgeInsets.only(bottom: 8),
  child: FieldBox(
    width: digits ? kFieldTiny : kFieldText,
    child: TextField(
      key: Key(key),
      controller: c,
      obscureText: secret,
      textDirection: TextDirection.ltr,
      autocorrect: false,
      enableSuggestions: false,
      keyboardType: digits ? TextInputType.number : TextInputType.text,
      maxLength: digits ? 6 : null,
      // row 166: a refused field is outlined red until it is edited
      onChanged: onEdit == null ? null : (_) => onEdit(key),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        counterText: '',
        errorText: issues[key],
        errorMaxLines: 2,
      ),
      onSubmitted: onSubmitted,
    ),
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
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;
  Map<String, String> _issues = const {};

  void _fix(String k) {
    if (_issues.containsKey(k)) {
      setState(() => _issues = {..._issues}..remove(k));
    }
  }

  Map<String, String> _guess(String? e, String id, String pw, String code) =>
      e == null
      ? const {}
      : FieldIssues.guess(e, {
          'setup-id': (label: 'شناسه *', value: id),
          'setup-pw': (label: 'رمز *', value: pw),
          'setup-code': (label: 'کد دومرحله‌ای *', value: code),
        });

  @override
  void dispose() {
    for (final c in [_id, _pw, _code]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final err = validateNewAccount(
      loginId: _id.text,
      password: _pw.text,
      code: _code.text,
    );
    if (err != null) {
      setState(() {
        _error = err;
        _issues = _guess(err, _id.text, _pw.text, _code.text);
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _issues = const {};
    });
    final failure = await widget.onCreate(_id.text, _pw.text, _code.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
      _issues = _guess(failure, _id.text, _pw.text, _code.text);
    });
  }

  @override
  Widget build(BuildContext context) => _CardPage(
    title: 'تعریف حساب مالک',
    subtitle: 'این کار فقط یک‌بار انجام می‌شود. شناسه، رمز عبور و کد دومرحله‌ای فقط روی همین دستگاه و به‌صورت رمزنگاری‌شده نگه داشته می‌شوند. ورود بعدی به اینترنت نیاز ندارد.',
    actions: [widget.themeButton],
    children: [
      _message(context, _error),
      _field('setup-id', _id, 'شناسهٔ ورود', issues: _issues, onEdit: _fix),
      _field(
        'setup-pw',
        _pw,
        'رمز عبور',
        secret: true,
        issues: _issues,
        onEdit: _fix,
      ),
      _field(
        'setup-code',
        _code,
        'کد دومرحله‌ای ۶ رقمی',
        digits: true,
        onSubmitted: (_) => _submit(),
        issues: _issues,
        onEdit: _fix,
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
  Map<String, String> _issues = const {};

  void _fix(String k) {
    if (_issues.containsKey(k)) {
      setState(() => _issues = {..._issues}..remove(k));
    }
  }

  @override
  void dispose() {
    for (final c in [_id, _pw, _code]) {
      c.dispose();
    }
    super.dispose();
  }

  void _submit() {
    final id = _id.text, pw = _pw.text, code = _code.text;
    final err = widget.onLogin(id, pw, code);
    _pw.clear();
    _code.clear();
    setState(() {
      _error = err;
      _issues = err == null
          ? const {}
          : FieldIssues.guess(err, {
              'local-id': (label: 'شناسه *', value: id),
              'local-pw': (label: 'رمز *', value: pw),
              'local-code': (label: 'کد دومرحله‌ای *', value: code),
            });
    });
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
        _field('local-id', _id, 'شناسهٔ ورود', issues: _issues, onEdit: _fix),
        _field(
          'local-pw',
          _pw,
          'رمز عبور',
          secret: true,
          issues: _issues,
          onEdit: _fix,
        ),
        _field(
          'local-code',
          _code,
          'کد دومرحله‌ای ۶ رقمی',
          digits: true,
          onSubmitted: (_) => _submit(),
          issues: _issues,
          onEdit: _fix,
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
