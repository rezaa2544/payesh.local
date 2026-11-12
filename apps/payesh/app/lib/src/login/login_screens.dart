import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../app.dart';
import '../sync_badge.dart';
import '../flags.dart';
import 'session_controller.dart';

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
            const Text(
              'برای ورود دوباره به کد فعال‌سازی تازه از مدیر مدرسه نیاز دارید. خارج می‌شوید؟',
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
              _ => _confirmSignOut(context),
            },
            itemBuilder: (_) => const [
              PopupMenuItem(
                key: Key('use-legacy'),
                value: 'legacy',
                child: Text('استفاده از نسخهٔ قبلی (وب)'),
              ),
              PopupMenuItem(
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
                  state.school,
                  key: const Key('session-school'),
                  textDirection: TextDirection.ltr,
                ),
                if (role != null)
                  StatusBadge(role, key: const Key('session-role')),
              ],
            ),
          ),
          if (pages != null) ...[
            const SizedBox(height: PayeshTokens.space4),
            pages!(context, state),
          ],
          const SizedBox(height: PayeshTokens.space4),
          home ?? const HomeBody(),
        ],
      ),
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
