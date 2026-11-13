import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_sync/payesh_sync.dart' show LanServerRules;
import 'package:payesh_ui/payesh_ui.dart';

import '../app.dart';
import '../sync_badge.dart';
import '../flags.dart';
import 'paywall.dart';
import 'session_controller.dart';
import 'signup_screen.dart';

/// Root of the native client when the login wave is on: picks the screen for the session state.
class SessionGate extends StatelessWidget {
  const SessionGate({
    super.key,
    required this.controller,
    this.home,
    this.pages,
  });

  final SessionController controller;

  /// Body under the signed-in header (the existing home content).
  final Widget? home;

  /// Native pages of later waves for the signed-in user (row 74, wave 2+).
  final Widget Function(BuildContext context, SignedIn state)? pages;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => switch (controller.state) {
        SessionLoading() => const Scaffold(
          body: Center(
            child: CircularProgressIndicator(key: Key('session-loading')),
          ),
        ),
        LegacyClient() => LegacyClientScreen(controller: controller),
        final NeedSchool s => SchoolSelectScreen(
          controller: controller,
          state: s,
        ),
        final NeedCode s => ActivationScreen(controller: controller, state: s),
        final NeedLan s => LanServerScreen(
          // a new server answer rebuilds the form (address step ↔ login/setup step)
          key: ValueKey('lan-${s.info?.server}-${s.info?.setupDone}'),
          controller: controller,
          state: s,
        ),
        final NeedSignup s => SignupScreen(controller: controller, state: s),
        final Locked s => LockScreen(controller: controller, state: s),
        final NeedClaim s => ClaimScreen(controller: controller, state: s),
        final SignedIn s => SignedInScreen(
          controller: controller,
          state: s,
          home: home,
          pages: pages,
        ),
      },
    );
  }
}

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.text);
  final String? text;

  @override
  Widget build(BuildContext context) {
    final t = text;
    if (t == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: PayeshTokens.space3),
      child: Semantics(
        liveRegion: true,
        child: Text(
          t,
          key: const Key('login-error'),
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      ),
    );
  }
}

/// Wrapping warning panel (long text; StatusBadge is for short labels).
class _Notice extends StatelessWidget {
  const _Notice(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = context.tokens.tone(PayeshTone.warning);
    return Container(
      padding: const EdgeInsets.all(PayeshTokens.space3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(PayeshTokens.space2),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.swap_horiz, color: fg),
          const SizedBox(width: PayeshTokens.space2),
          Expanded(
            child: Text(text, style: TextStyle(color: fg)),
          ),
        ],
      ),
    );
  }
}

class _LoginFrame extends StatelessWidget {
  const _LoginFrame({required this.title, required this.children});
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(title)),
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space5),
            shrinkWrap: true,
            children: children,
          ),
        ),
      ),
    ),
  );
}

class SchoolSelectScreen extends StatefulWidget {
  const SchoolSelectScreen({
    super.key,
    required this.controller,
    required this.state,
  });

  final SessionController controller;
  final NeedSchool state;

  @override
  State<SchoolSelectScreen> createState() => _SchoolSelectScreenState();
}

class _SchoolSelectScreenState extends State<SchoolSelectScreen> {
  late final TextEditingController _code = TextEditingController(
    text: widget.state.typed,
  );

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  void _submit() => widget.controller.submitSchool(_code.text);

  @override
  Widget build(BuildContext context) {
    final busy = widget.controller.busy;
    return _LoginFrame(
      title: 'ورود به مدرسه',
      children: [
        const Text(
          'کد مدرسه را از مدیر مدرسه بگیرید و اینجا بنویسید.',
          key: Key('school-help'),
        ),
        const SizedBox(height: PayeshTokens.space4),
        TextField(
          key: const Key('school-code'),
          controller: _code,
          enabled: !busy,
          autofocus: true,
          textDirection: TextDirection.ltr,
          keyboardType: TextInputType.url,
          autocorrect: false,
          textInputAction: TextInputAction.go,
          onSubmitted: (_) => _submit(),
          decoration: const InputDecoration(
            labelText: 'کد مدرسه',
            hintText: 'alborz-12',
            border: OutlineInputBorder(),
          ),
        ),
        _ErrorText(widget.state.error),
        const SizedBox(height: PayeshTokens.space4),
        FilledButton(
          key: const Key('school-next'),
          onPressed: busy ? null : _submit,
          child: busy
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(
                    key: Key('login-busy'),
                    strokeWidth: 2,
                  ),
                )
              : const Text('ادامه'),
        ),
        if (widget.controller.lanAvailable) ...[
          const SizedBox(height: PayeshTokens.space3),
          OutlinedButton.icon(
            key: const Key('use-lan'),
            onPressed: busy ? null : widget.controller.useLan,
            icon: const Icon(Icons.lan_outlined),
            label: const Text('سرور مدرسه در همین شبکه'),
          ),
        ],
        const SizedBox(height: PayeshTokens.space3),
        TextButton(
          key: const Key('use-legacy'),
          onPressed: busy ? null : widget.controller.useLegacy,
          child: const Text('استفاده از نسخهٔ قبلی (وب)'),
        ),
      ],
    );
  }
}

class ActivationScreen extends StatefulWidget {
  const ActivationScreen({
    super.key,
    required this.controller,
    required this.state,
  });

  final SessionController controller;
  final NeedCode state;

  @override
  State<ActivationScreen> createState() => _ActivationScreenState();
}

class _ActivationScreenState extends State<ActivationScreen> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  void _submit() => widget.controller.submitCode(_code.text);

  @override
  Widget build(BuildContext context) {
    final busy = widget.controller.busy;
    final notice = widget.controller.migrationNotice;
    return _LoginFrame(
      title: 'فعال‌سازی این دستگاه',
      children: [
        Row(
          children: [
            const Text('مدرسه: '),
            Text(
              widget.state.route.schoolCode,
              key: const Key('activation-school'),
              textDirection: TextDirection.ltr,
            ),
          ],
        ),
        if (notice != null) ...[
          const SizedBox(height: PayeshTokens.space3),
          _Notice(notice, key: const Key('school-notice')),
        ],
        const SizedBox(height: PayeshTokens.space4),
        const Text(
          'کد فعال‌سازی یک‌بارمصرف را که مدیر مدرسه داده است بنویسید.',
        ),
        const SizedBox(height: PayeshTokens.space3),
        TextField(
          key: const Key('activation-code'),
          controller: _code,
          enabled: !busy,
          autofocus: true,
          textDirection: TextDirection.ltr,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [LengthLimitingTextInputFormatter(48)],
          textInputAction: TextInputAction.go,
          onSubmitted: (_) => _submit(),
          decoration: const InputDecoration(
            labelText: 'کد فعال‌سازی',
            border: OutlineInputBorder(),
          ),
        ),
        _ErrorText(widget.state.error),
        const SizedBox(height: PayeshTokens.space4),
        FilledButton(
          key: const Key('activation-submit'),
          onPressed: busy ? null : _submit,
          child: busy
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(
                    key: Key('login-busy'),
                    strokeWidth: 2,
                  ),
                )
              : const Text('فعال‌سازی'),
        ),
        const SizedBox(height: PayeshTokens.space3),
        TextButton(
          key: const Key('change-school'),
          onPressed: busy ? null : widget.controller.changeSchool,
          child: const Text('تغییر مدرسه'),
        ),
      ],
    );
  }
}

/// Signed-in shell: school + role, the visible sync badge, sign-out (two steps) and the switch
/// to the old client. The page body is the existing home content.
class SignedInScreen extends StatelessWidget {
  const SignedInScreen({
    super.key,
    required this.controller,
    required this.state,
    this.home,
    this.pages,
  });

  final SessionController controller;
  final SignedIn state;
  final Widget? home;
  final Widget Function(BuildContext context, SignedIn state)? pages;

  Future<void> _confirmSignOut(BuildContext context) async {
    final waiting = controller.sync.value.waiting;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('خروج از این دستگاه'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              state.onLan
                  ? 'برای ورود دوباره شماره و رمز عبور خود را لازم دارید. خارج می‌شوید؟'
                  : 'برای ورود دوباره به کد فعال‌سازی تازه از مدیر مدرسه نیاز دارید. خارج می‌شوید؟',
            ),
            if (waiting > 0) ...[
              const SizedBox(height: PayeshTokens.space3),
              Text(
                '${faDigits(waiting)} ثبت هنوز به سرور نرسیده است. تا همین کاربر دوباره وارد نشود، ارسال نمی‌شود.',
                key: const Key('sign-out-unsent'),
                style: TextStyle(color: Theme.of(ctx).colorScheme.error),
              ),
            ],
          ],
        ),
        actions: [
          TextButton(
            key: const Key('sign-out-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: const Key('sign-out-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('خروج'),
          ),
        ],
      ),
    );
    if (ok == true) await controller.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final role = state.roleFa;
    return Scaffold(
      appBar: AppBar(
        title: const Text('پایش'),
        actions: [
          Padding(
            padding: const EdgeInsetsDirectional.only(end: PayeshTokens.space2),
            child: Center(
              child: SyncBadge(
                status: controller.sync,
                onRetry: controller.refresh,
              ),
            ),
          ),
          PopupMenuButton<String>(
            key: const Key('session-menu'),
            tooltip: 'گزینه‌ها',
            onSelected: (v) => switch (v) {
              'legacy' => controller.useLegacy(),
              'lock' => controller.lock(),
              _ => _confirmSignOut(context),
            },
            itemBuilder: (_) => [
              // row 128 / W7: web `lock` (LAN: unlocking asks the school server)
              if (controller.canLock &&
                  controller.flags.usesSchool(SchoolWave.accounts))
                const PopupMenuItem(
                  key: Key('lock'),
                  value: 'lock',
                  child: Text('قفل برنامه'),
                ),
              const PopupMenuItem(
                key: Key('use-legacy'),
                value: 'legacy',
                child: Text('استفاده از نسخهٔ قبلی (وب)'),
              ),
              const PopupMenuItem(
                key: Key('sign-out'),
                value: 'sign-out',
                child: Text('خروج از این دستگاه'),
              ),
            ],
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          PayeshSection(
            title: 'مدرسه',
            child: Wrap(
              spacing: PayeshTokens.space3,
              runSpacing: PayeshTokens.space2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  state.schoolName ?? state.school,
                  key: const Key('session-school'),
                  textDirection: state.schoolName == null
                      ? TextDirection.ltr
                      : null,
                ),
                if (role != null)
                  StatusBadge(role, key: const Key('session-role')),
                if (state.lanServer != null)
                  Text(
                    'سرور مدرسه: ${state.lanServer!.host}:${state.lanServer!.port}',
                    key: const Key('session-lan-server'),
                  ),
                if (state.lanServer != null &&
                    LanServerRules.isLoopbackHost(state.lanServer!.host) &&
                    controller.lanShareUrls.isNotEmpty)
                  SelectableText(
                    'نشانی برای دستگاه‌های دیگر مدرسه: ${controller.lanShareUrls.join('  ·  ')}',
                    key: const Key('session-lan-share'),
                  ),
              ],
            ),
          ),
          if (controller.paywalled) ...[
            const SizedBox(height: PayeshTokens.space4),
            PaywallView(controller: controller),
          ] else ...[
            if (controller.sub case final sub?
                when sub.managed && sub.status != 'free')
              Padding(
                padding: const EdgeInsets.only(top: PayeshTokens.space3),
                child: SubBanner(controller: controller, sub: sub),
              ),
            if (pages != null) ...[
              const SizedBox(height: PayeshTokens.space4),
              pages!(context, state),
            ],
            const SizedBox(height: PayeshTokens.space4),
            home ?? const HomeBody(),
          ],
        ],
      ),
    );
  }
}

/// Row 127 — login against the school's own server on the local network (Sync v1 server,
/// usually the headless data service of the school Windows installer). Step 1: the address;
/// step 2: phone + password, or the first setup when the server is fresh.
class LanServerScreen extends StatefulWidget {
  const LanServerScreen({
    super.key,
    required this.controller,
    required this.state,
  });

  final SessionController controller;
  final NeedLan state;

  @override
  State<LanServerScreen> createState() => _LanServerScreenState();
}

class _LanServerScreenState extends State<LanServerScreen> {
  late final TextEditingController _server = TextEditingController(
    text: widget.state.typed,
  );
  late final _phone = TextEditingController(text: widget.state.login);
  final _password = TextEditingController();
  final _schoolName = TextEditingController();
  final _manager = TextEditingController();

  /// Row 145: on a fresh server, the manager of a school the owner created (or approved) signs
  /// in with the user name instead of setting the server up.
  bool _loginInstead = false;

  @override
  void dispose() {
    for (final c in [_server, _phone, _password, _schoolName, _manager]) {
      c.dispose();
    }
    super.dispose();
  }

  Widget _busyOr(bool busy, String label) => busy
      ? const SizedBox.square(
          dimension: 20,
          child: CircularProgressIndicator(
            key: Key('login-busy'),
            strokeWidth: 2,
          ),
        )
      : Text(label);

  Widget _field(
    String key,
    TextEditingController c,
    String label, {
    bool busy = false,
    bool ltr = false,
    bool secret = false,
    bool autofocus = false,
    TextInputType? keyboard,
    String? hint,
    VoidCallback? onGo,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
    child: TextField(
      key: Key(key),
      controller: c,
      enabled: !busy,
      autofocus: autofocus,
      obscureText: secret,
      autocorrect: false,
      enableSuggestions: !secret,
      textDirection: ltr ? TextDirection.ltr : null,
      keyboardType: keyboard,
      textInputAction: onGo == null ? TextInputAction.next : TextInputAction.go,
      onSubmitted: onGo == null ? null : (_) => onGo(),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        border: const OutlineInputBorder(),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final s = widget.state;
    final busy = c.busy;
    final info = s.info;
    if (info == null) {
      void go() => c.submitLanServer(_server.text);
      return _LoginFrame(
        title: 'سرور مدرسه در همین شبکه',
        children: [
          const Text(
            'نشانی سرور مدرسه را از مدیر بگیرید (مثلاً ۱۹۲.۱۶۸.۱.۱۰:۸۰۸۰). این دستگاه باید به همان شبکهٔ مدرسه وصل باشد.',
            key: Key('lan-help'),
          ),
          const SizedBox(height: PayeshTokens.space4),
          _field(
            'lan-server',
            _server,
            'نشانی سرور مدرسه',
            busy: busy,
            ltr: true,
            autofocus: true,
            keyboard: TextInputType.url,
            hint: '192.168.1.10:8080',
            onGo: go,
          ),
          _ErrorText(s.error),
          const SizedBox(height: PayeshTokens.space4),
          FilledButton(
            key: const Key('lan-next'),
            onPressed: busy ? null : go,
            child: _busyOr(busy, 'ادامه'),
          ),
          const SizedBox(height: PayeshTokens.space3),
          TextButton(
            key: const Key('lan-back'),
            onPressed: busy ? null : c.leaveLan,
            child: const Text('ورود با کد مدرسه'),
          ),
        ],
      );
    }
    final header = Wrap(
      spacing: PayeshTokens.space2,
      children: [
        Text(
          info.schoolName ?? 'سرور پایش',
          key: const Key('lan-school'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        Text(
          '${info.server.host}:${info.server.port}',
          key: const Key('lan-address'),
          textDirection: TextDirection.ltr,
        ),
        if (LanServerRules.isLoopbackHost(info.server.host) &&
            info.lanUrls.isNotEmpty)
          SelectableText(
            'نشانی برای دستگاه‌های دیگر مدرسه: ${info.lanUrls.join('  ·  ')}',
            key: const Key('lan-share'),
          ),
      ],
    );
    final change = TextButton(
      key: const Key('lan-change-server'),
      onPressed: busy ? null : c.changeLanServer,
      child: const Text('تغییر نشانی سرور'),
    );
    // Row 145 — next to the user name / password login (p2 port; the marketing site later
    // sends the same request to the same endpoint).
    final signup = c.signupAvailable
        ? Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space3),
            child: OutlinedButton.icon(
              key: const Key('lan-signup'),
              onPressed: busy ? null : c.openSignup,
              icon: const Icon(Icons.add_business_outlined),
              label: const Text('درخواست ثبت نام مدرسه جدید'),
            ),
          )
        : const SizedBox.shrink();
    if (s.needsSetup && !_loginInstead) {
      void go() => c.submitLanSetup(
        schoolName: _schoolName.text,
        managerName: _manager.text,
        phone: _phone.text,
        password: _password.text,
      );
      return _LoginFrame(
        title: 'راه‌اندازی اولیهٔ سرور مدرسه',
        children: [
          header,
          const SizedBox(height: PayeshTokens.space3),
          const Text(
            'این سرور هنوز راه‌اندازی نشده است. نام مدرسه و مشخصات مدیر را وارد کنید؛ مدیر با همین شماره و رمز وارد می‌شود.',
            key: Key('lan-setup-help'),
          ),
          const SizedBox(height: PayeshTokens.space4),
          _field('lan-setup-school', _schoolName, 'نام مدرسه', busy: busy),
          _field(
            'lan-setup-manager',
            _manager,
            'نام و نام خانوادگی مدیر',
            busy: busy,
          ),
          _field(
            'lan-phone',
            _phone,
            'شمارهٔ همراه مدیر',
            busy: busy,
            ltr: true,
            keyboard: TextInputType.phone,
          ),
          _field(
            'lan-password',
            _password,
            'رمز عبور (دست‌کم ۴ نویسه)',
            busy: busy,
            ltr: true,
            secret: true,
            onGo: go,
          ),
          _ErrorText(s.error),
          const SizedBox(height: PayeshTokens.space4),
          FilledButton(
            key: const Key('lan-setup-submit'),
            onPressed: busy ? null : go,
            child: _busyOr(busy, 'راه‌اندازی و ورود'),
          ),
          const SizedBox(height: PayeshTokens.space3),
          TextButton(
            key: const Key('lan-login-instead'),
            onPressed: busy ? null : () => setState(() => _loginInstead = true),
            child: const Text(
              'مدرسهٔ شما در پایش ثبت شده است؟ با نام کاربری و رمز مدیر وارد شوید',
            ),
          ),
          signup,
          const SizedBox(height: PayeshTokens.space3),
          change,
        ],
      );
    }
    void go() => c.submitLanLogin(_phone.text, _password.text);
    return _LoginFrame(
      title: 'ورود به سرور مدرسه',
      children: [
        header,
        const SizedBox(height: PayeshTokens.space4),
        _field(
          'lan-phone',
          _phone,
          'شمارهٔ همراه، کد ملی یا نام کاربری',
          busy: busy,
          ltr: true,
          autofocus: true,
          keyboard: TextInputType.visiblePassword,
        ),
        _field(
          'lan-password',
          _password,
          'رمز عبور',
          busy: busy,
          ltr: true,
          secret: true,
          onGo: go,
        ),
        _ErrorText(s.error),
        const SizedBox(height: PayeshTokens.space4),
        FilledButton(
          key: const Key('lan-login'),
          onPressed: busy ? null : go,
          child: _busyOr(busy, 'ورود'),
        ),
        // row 128 / W7 — web form `claim`: only on the server computer itself
        if (LanServerRules.isLoopbackHost(info.server.host) &&
            c.flags.usesSchool(SchoolWave.accounts))
          TextButton(
            key: const Key('lan-claim'),
            onPressed: busy ? null : c.openClaim,
            child: const Text('رمز مدیر را فراموش کرده‌اید؟'),
          ),
        signup,
        if (_loginInstead)
          TextButton(
            key: const Key('lan-setup-instead'),
            onPressed: busy
                ? null
                : () => setState(() => _loginInstead = false),
            child: const Text('راه‌اندازی اولیهٔ این سرور'),
          ),
        const SizedBox(height: PayeshTokens.space3),
        change,
      ],
    );
  }
}

/// The old client is the web client in the browser; the native app shows where to find it.
class LegacyClientScreen extends StatelessWidget {
  const LegacyClientScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    final url = controller.flags.webUrl;
    return _LoginFrame(
      title: 'نسخهٔ قبلی پایش',
      children: [
        const Text(
          'روی این دستگاه نسخهٔ قبلی (وب) انتخاب شده است. پایش را در مرورگر باز کنید:',
          key: Key('legacy-client'),
        ),
        const SizedBox(height: PayeshTokens.space4),
        if (url.isEmpty)
          const Text(
            'نشانی نسخهٔ وب را از مدیر مدرسه بپرسید.',
            key: Key('legacy-url-missing'),
          )
        else
          Row(
            children: [
              Expanded(
                child: SelectableText(
                  url,
                  key: const Key('legacy-url'),
                  textDirection: TextDirection.ltr,
                ),
              ),
              IconButton(
                key: const Key('legacy-copy'),
                tooltip: 'رونوشت نشانی',
                icon: const Icon(Icons.copy),
                onPressed: () => Clipboard.setData(ClipboardData(text: url)),
              ),
            ],
          ),
        if (controller.flags.ships(NativeWave.login)) ...[
          const SizedBox(height: PayeshTokens.space5),
          FilledButton.tonal(
            key: const Key('use-native'),
            onPressed: controller.useNative,
            child: const Text('استفاده از نسخهٔ جدید'),
          ),
        ],
      ],
    );
  }
}

/// Row 128 / W7 — the app is locked on this device (web `lockApp` + form `unlock`).
class LockScreen extends StatefulWidget {
  const LockScreen({super.key, required this.controller, required this.state});
  final SessionController controller;
  final Locked state;

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  final _password = TextEditingController();

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  void _go() {
    widget.controller.submitUnlock(_password.text);
    _password.clear();
  }

  @override
  Widget build(BuildContext context) {
    final busy = widget.controller.busy;
    return _LoginFrame(
      title: 'برنامه قفل است',
      children: [
        Text(
          widget.state.schoolName ?? widget.state.school,
          key: const Key('lock-school'),
        ),
        const SizedBox(height: PayeshTokens.space2),
        const Text('برای باز کردن، رمز عبور خود را بنویسید.'),
        const SizedBox(height: PayeshTokens.space4),
        TextField(
          key: const Key('unlock-password'),
          controller: _password,
          obscureText: true,
          enabled: !busy,
          autofocus: true,
          textDirection: TextDirection.ltr,
          onSubmitted: (_) => _go(),
          decoration: const InputDecoration(labelText: 'رمز عبور'),
        ),
        _ErrorText(widget.state.error),
        const SizedBox(height: PayeshTokens.space4),
        FilledButton(
          key: const Key('unlock-submit'),
          onPressed: busy ? null : _go,
          child: const Text('باز کردن'),
        ),
        const SizedBox(height: PayeshTokens.space3),
        TextButton(
          key: const Key('unlock-sign-out'),
          onPressed: busy ? null : widget.controller.signOut,
          child: const Text('خروج از این دستگاه'),
        ),
      ],
    );
  }
}

/// Row 128 / W7 — manager rescue on the server computer (web form `claim`).
class ClaimScreen extends StatefulWidget {
  const ClaimScreen({super.key, required this.controller, required this.state});
  final SessionController controller;
  final NeedClaim state;

  @override
  State<ClaimScreen> createState() => _ClaimScreenState();
}

class _ClaimScreenState extends State<ClaimScreen> {
  final _phone = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final busy = c.busy;
    void go() => c.submitClaim(_phone.text, _password.text);
    return _LoginFrame(
      title: 'رمز تازه برای مدیر',
      children: [
        const Text(
          'روی خود رایانهٔ سرور مدرسه می‌توانید برای حساب مدیر شمارهٔ همراه و رمز تازه بگذارید.',
          key: Key('claim-help'),
        ),
        const SizedBox(height: PayeshTokens.space4),
        TextField(
          key: const Key('claim-phone'),
          controller: _phone,
          enabled: !busy,
          keyboardType: TextInputType.phone,
          textDirection: TextDirection.ltr,
          decoration: const InputDecoration(labelText: 'شمارهٔ همراه مدیر'),
        ),
        const SizedBox(height: PayeshTokens.space3),
        TextField(
          key: const Key('claim-password'),
          controller: _password,
          enabled: !busy,
          obscureText: true,
          textDirection: TextDirection.ltr,
          onSubmitted: (_) => go(),
          decoration: const InputDecoration(
            labelText: 'رمز تازه (حداقل ۴ نویسه)',
          ),
        ),
        _ErrorText(widget.state.error),
        const SizedBox(height: PayeshTokens.space4),
        FilledButton(
          key: const Key('claim-submit'),
          onPressed: busy ? null : go,
          child: const Text('ثبت رمز و ورود'),
        ),
        TextButton(
          key: const Key('claim-back'),
          onPressed: busy ? null : c.closeClaim,
          child: const Text('بازگشت'),
        ),
      ],
    );
  }
}
