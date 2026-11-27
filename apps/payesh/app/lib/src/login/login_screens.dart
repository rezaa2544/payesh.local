import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_sync/payesh_sync.dart'
    show
        LanServerInfo,
        LanServerRules,
        ServerAdminApi,
        setupDefaultYear,
        setupSchoolTypes;
import 'package:payesh_ui/payesh_ui.dart';

import '../app.dart';
import '../sync_badge.dart';
import '../pulse/pulse.dart';
import '../pulse/web.dart';
import '../flags.dart';
import 'paywall.dart';
import 'subscription_page.dart';
import '../support/support_screen.dart';
import 'login_brand.dart';
import 'session_controller.dart';
import 'signup_screen.dart';

/// Root of the native client when the login wave is on: picks the screen for the session state.
class SessionGate extends StatelessWidget {
  const SessionGate({
    super.key,
    required this.controller,
    this.home,
    this.pages,
    this.nav,
    this.accountName,
    this.admin,
  });

  final SessionController controller;

  /// Body under the signed-in header (the existing home content).
  final Widget? home;

  /// Native pages of later waves for the signed-in user (row 74, wave 2+).
  final Widget Function(BuildContext context, SignedIn state)? pages;

  /// Row 170: the «نبض» sidebar / drawer pages of the signed-in user.
  final List<PulseNavItem> Function(BuildContext context, SignedIn state)? nav;

  /// Row 172: the signed-in user's name for the sidebar's «name · role» line.
  final Future<String?> Function(SignedIn state)? accountName;

  /// Row 172: the school server's admin API (the manager's cloud banner reads its health).
  final ServerAdminApi? Function()? admin;

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
          // a new server answer rebuilds the form (address step ↔ login/setup step); row 163:
          // the single login screen keeps what was typed while the server is being found
          key: ValueKey(
            controller.lanFirst
                ? 'lan-first-${s.needsSetup}'
                : 'lan-${s.info?.server}-${s.info?.setupDone}',
          ),
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
          nav: nav,
          accountName: accountName,
          admin: admin,
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
        FieldBox(
          width: kFieldDigits,
          child: TextField(
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
        FieldBox(
          width: kFieldDigits,
          child: TextField(
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
class SignedInScreen extends StatefulWidget {
  const SignedInScreen({
    super.key,
    required this.controller,
    required this.state,
    this.home,
    this.pages,
    this.nav,
    this.accountName,
    this.admin,
  });

  final SessionController controller;
  final SignedIn state;
  final Future<String?> Function(SignedIn state)? accountName;

  /// Row 172: the school server's admin API (the manager's cloud banner reads its health).
  final ServerAdminApi? Function()? admin;
  final Widget? home;
  final Widget Function(BuildContext context, SignedIn state)? pages;

  /// Row 170: «نبض» navigation (sidebar on a wide window, drawer on a phone).
  final List<PulseNavItem> Function(BuildContext context, SignedIn state)? nav;

  @override
  State<SignedInScreen> createState() => _SignedInScreenState();
}

class _SignedInScreenState extends State<SignedInScreen> {
  SessionController get controller => widget.controller;
  SignedIn get state => widget.state;
  Widget? get home => widget.home;
  Widget Function(BuildContext context, SignedIn state)? get pages =>
      widget.pages;

  /// The id of the page shown inside the wide shell (null = the role's home, the first one).
  String? _selected;

  /// Row 172: the user's name for «name · role» (read once from the local database).
  String? _name;

  @override
  void initState() {
    super.initState();
    widget.accountName?.call(state).then((n) {
      if (mounted && n != null && n.isNotEmpty) setState(() => _name = n);
    }, onError: (Object _) {});
  }

  /// Row 177: the app's top strip (version + update light) also shows the subscription badge.
  bool _badgeInStrip(BuildContext context) =>
      PulseApp.of(context)?.updater != null;

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

  Widget _menu(BuildContext context) => PopupMenuButton<String>(
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
  );

  Widget _badge() => Padding(
    padding: const EdgeInsetsDirectional.only(end: PayeshTokens.space2),
    child: Center(
      child: SyncBadge(status: controller.sync, onRetry: controller.refresh),
    ),
  );

  Widget _dashboard(BuildContext context, double side) {
    final role = state.roleFa;
    return ListView(
      padding: EdgeInsets.fromLTRB(
        side,
        PayeshTokens.space4,
        side,
        PayeshTokens.space6,
      ),
      children: [
        // Row 165: one clean header card — school, role, how this device is connected.
        PayeshHeaderCard(
          key: const Key('session-header'),
          title: state.schoolName ?? state.school,
          titleKey: const Key('session-school'),
          chips: [
            if (role != null) StatusBadge(role, key: const Key('session-role')),
          ],
          lines: [
            if (state.lanServer case final srv?)
              Row(
                key: const Key('session-lan-server'),
                children: [
                  Icon(
                    srv.scheme == 'https' ? Icons.public : Icons.lan_outlined,
                    size: 16,
                    color: context.tokens.muted,
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      srv.scheme == 'https'
                          ? 'وصل از راه اینترنت'
                          : LanServerRules.isLoopbackHost(srv.host)
                          ? 'سرور مدرسه روی همین رایانه'
                          : 'وصل در شبکهٔ مدرسه',
                    ),
                  ),
                ],
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
        if (controller.paywalled) ...[
          const SizedBox(height: PayeshTokens.space4),
          PaywallView(controller: controller),
          // Row 192: behind the paywall too — every payment (rejected ones with the reason) and
          // every earlier subscription, so a user knows why access is closed.
          const SizedBox(height: PayeshTokens.space3),
          _PaywallHistory(controller: controller),
        ] else ...[
          // Row 197-Q03: free core (parent without a subscription) — what is free, and the
          // trial / subscription one tap away.
          if (controller.limited)
            Padding(
              padding: const EdgeInsets.only(top: PayeshTokens.space3),
              child: FreeCoreBanner(controller: controller),
            ),
          if (controller.sub case final sub?
              when !controller.limited &&
                  sub.managed &&
                  sub.status != 'free' &&
                  (!_badgeInStrip(context) || sub.renewWarning))
            Padding(
              padding: const EdgeInsets.only(top: PayeshTokens.space3),
              child: SubBanner(
                controller: controller,
                sub: sub,
                showBadge: !_badgeInStrip(context),
              ),
            ),
          if (pages != null) ...[
            const SizedBox(height: PayeshTokens.space5),
            pages!(context, state),
          ],
          const SizedBox(height: PayeshTokens.space6),
          home ?? const HomeBody(),
        ],
        // Row 152: support for every role — also on the paywall (payment problems).
        if (controller.supportAvailable) ...[
          const SizedBox(height: PayeshTokens.space4),
          SupportEntry(controller: controller),
        ],
      ],
    );
  }

  void _open(BuildContext context, PulseNavItem m) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: m.page));
  }

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final all0 = controller.paywalled
        ? const <PulseNavItem>[]
        : (widget.nav?.call(context, state) ?? const <PulseNavItem>[]);
    // Row 197-Q03: without a subscription only the free core stays in the menu.
    final pages0 = controller.limited
        ? [
            for (final m in all0)
              if (freeCorePages.contains(m.id)) m,
          ]
        : all0;
    // Row 172: every web role ends with «⚙️ سیستم»; when this build has no system page for the
    // user, a small one keeps «🔒 خروج» and this device's controls reachable (never a shell
    // without a way out).
    final nav0 = pages0.isEmpty || pages0.any((m) => m.id == 'system')
        ? pages0
        : [
            ...pages0,
            PulseNavItem(
              id: 'system',
              label: 'سیستم',
              icon: Icons.settings_outlined,
              webIcon: 'gear',
              page: (context) => const _DevicePage(),
            ),
          ];
    // Row 192: «اشتراک» is always in the menu of a school Payesh manages (status, renew, buy,
    // payment report, all subscriptions) — not only behind the paywall.
    // Row 194: it goes right above «سیستم» and nothing else moves (pulseSorted only knows the
    // native ids, so it pushed «داشبورد», «ارجاع مشاور», «اطلاعیه‌ها» and «شبکه» to the end).
    final nav = nav0.isEmpty || !showsSubscriptionPage(controller)
        ? nav0
        : withSubscription(
            nav0,
            PulseNavItem(
              id: 'subscription',
              label: 'اشتراک',
              icon: Icons.workspace_premium_outlined,
              webIcon: 'check',
              page: (context) => SubscriptionPage(controller: controller),
            ),
          );
    final wide = w >= pulseWideBreakpoint;
    final brand = const Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PayeshBrandMark(size: 30),
        SizedBox(width: 10),
        Text('پایش', style: TextStyle(fontWeight: FontWeight.w800)),
      ],
    );
    if (nav.isEmpty) {
      final side = w > 1000 ? (w - 960) / 2 : PayeshTokens.space4;
      return Scaffold(
        appBar: AppBar(
          titleSpacing: PayeshTokens.space4,
          title: brand,
          actions: [_badge(), _menu(context)],
        ),
        drawer: nav.isEmpty
            ? null
            : Drawer(
                key: const Key('pulse-drawer'),
                child: SafeArea(
                  child: ListView(
                    padding: const EdgeInsets.all(PayeshTokens.space3),
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(PayeshTokens.space2),
                        child: brand,
                      ),
                      if ((state.schoolName ?? state.school).isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: PayeshTokens.space2,
                          ),
                          child: Text(
                            state.schoolName ?? state.school,
                            style: TextStyle(color: context.tokens.muted),
                          ),
                        ),
                      const Divider(),
                      ListTile(
                        key: const Key('drawer-dashboard'),
                        leading: const Icon(Icons.home_outlined),
                        title: const Text('داشبورد'),
                        selected: true,
                        onTap: () => Navigator.of(context).pop(),
                      ),
                      for (final m in nav)
                        ListTile(
                          key: Key('drawer-${m.id}'),
                          leading: Icon(m.icon),
                          title: Text(m.label),
                          onTap: () {
                            Navigator.of(context).pop();
                            _open(context, m);
                          },
                        ),
                    ],
                  ),
                ),
              ),
        body: _dashboard(context, side),
      );
    }
    // Row 172: exactly the web shell — `.sidebar` on the right (900px and up) or `.bottomnav`
    // (below), `.main` with the cloud / version bars then the page; the first page is the
    // role's home (web `#/home`). The sync light and the session menu of the native shell are
    // gone (the web has none): «🔒 خروج» is on «سیستم», with this device's extras.
    final selected = nav.any((m) => m.id == _selected)
        ? _selected!
        : nav.first.id;
    void go(String id) {
      if (nav.any((m) => m.id == id)) setState(() => _selected = id);
    }

    final app = PulseApp.of(context);
    final page = PulseInline(
      onGo: go,
      onLock:
          controller.canLock && controller.flags.usesSchool(SchoolWave.accounts)
          ? controller.lock
          : () => _confirmSignOut(context),
      extras: _extras,
      child: WebMainTop(
        bars: PulseTopBars(
          manager: state.currentRole == 'manager',
          updater: app?.updater,
          admin: widget.admin?.call(),
          openUrl: app?.openUrl,
          onGo: go,
          sync: controller.sync,
          onRetry: controller.refresh,
        ),
        child: KeyedSubtree(
          key: ValueKey('pulse-page-$selected'),
          child: nav.firstWhere((m) => m.id == selected).page(context),
        ),
      ),
    );
    final role = state.roleFa;
    final sub = controller.sub;
    final main = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Row 197-Q03: the free core says what is free and keeps the trial one tap away, above
        // every page of the shell (not only on the bare home).
        if (controller.limited)
          Padding(
            padding: wide
                ? const EdgeInsets.fromLTRB(26, 12, 26, 0)
                : const EdgeInsets.fromLTRB(14, 10, 14, 0),
            child: FreeCoreBanner(controller: controller),
          )
        // Row 177: with an updater the badge sits in the top-left strip next to the version;
        // only the renewal warning (if any) stays above the page.
        else if (sub != null &&
            sub.managed &&
            sub.status != 'free' &&
            (!_badgeInStrip(context) || sub.renewWarning))
          Padding(
            padding: wide
                ? const EdgeInsets.fromLTRB(26, 12, 26, 0)
                : const EdgeInsets.fromLTRB(14, 10, 14, 0),
            child: SubBanner(
              controller: controller,
              sub: sub,
              showBadge: !_badgeInStrip(context),
            ),
          ),
        Expanded(child: page),
      ],
    );
    return Scaffold(
      key: const Key('pulse-shell'),
      backgroundColor: Web.bg,
      body: WebBackdrop(
        child: SafeArea(
          bottom: wide,
          child: wide
              ? Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    PulseSidebar(
                      items: nav,
                      selected: selected,
                      onSelected: go,
                      school: state.schoolName ?? state.school,
                      account: '${_name ?? ''} · ${role ?? ''}',
                    ),
                    Expanded(child: main),
                  ],
                )
              // the bar sits over the page like the fixed web bar (`.main` keeps 86px free)
              : Stack(
                  children: [
                    Positioned.fill(child: main),
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: PulseBottomNav(
                        items: nav,
                        selected: selected,
                        onSelected: go,
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }

  /// Native-only controls of this device for the system page's last card.
  Widget _extras(BuildContext context) => WebWrap(
    key: const Key('sys-extras'),
    spacing: 8,
    runSpacing: 8,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      // Row 179: روشن / تاریک / سیستم of this device
      if (PayeshThemeScope.maybeOf(context) != null)
        const PayeshThemeChoice(key: Key('sys-theme')),
      if (controller.supportAvailable) SupportEntry(controller: controller),
      WebBtn(
        'استفاده از نسخهٔ قبلی (وب)',
        key: const Key('use-legacy'),
        kind: WebBtnKind.ghost,
        onPressed: controller.useLegacy,
      ),
      if (controller.canLock &&
          controller.flags.usesSchool(SchoolWave.accounts))
        WebBtn(
          'خروج از این دستگاه',
          key: const Key('sign-out'),
          kind: WebBtnKind.ghost,
          onPressed: () => _confirmSignOut(context),
        ),
    ],
  );
}

/// Row 172: the fallback «سیستم» page — «🔒 خروج» and this device's own controls.
class _DevicePage extends StatelessWidget {
  const _DevicePage();

  @override
  Widget build(BuildContext context) {
    final lock = PulseInline.lockOf(context);
    final extras = PulseInline.extrasOf(context);
    return Material(
      type: MaterialType.transparency,
      child: WebPageBody(
        children: [
          WebPageHead(
            title: 'سیستم',
            actions: [
              if (lock != null)
                WebBtn('🔒 خروج', key: const Key('sys-lock'), onPressed: lock),
            ],
          ),
          if (extras != null) WebCard(child: extras(context)),
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
  final _password2 = TextEditingController();
  final _schoolYear = TextEditingController(text: setupDefaultYear);
  String _schoolType = setupSchoolTypes.first;

  /// Row 145: on a fresh server, the manager of a school the owner created (or approved) signs
  /// in with the user name instead of setting the server up.
  bool _loginInstead = false;

  /// Row 160 — the method the user switched to (null = the owner's primary method).
  bool? _mobileMode;

  /// Row 160 — «فراموشی رمز»: the mobile form sends a reset code instead of a login code.
  bool _reset = false;
  final _mobile = TextEditingController();
  final _code = TextEditingController();
  final _newPassword = TextEditingController();

  @override
  void dispose() {
    for (final c in [
      _server,
      _phone,
      _password,
      _mobile,
      _code,
      _newPassword,
      _schoolName,
      _manager,
      _password2,
      _schoolYear,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Row 160 — «ورود با شماره» (or «فراموشی رمز»): the mobile, then «دریافت کد». While no SMS
  /// panel is linked the form says it is coming soon and sends nothing.
  Widget _mobileForm(
    LanServerInfo info,
    NeedLan s,
    Widget header,
    bool busy,
    Widget signup,
    Widget change,
  ) {
    final c = widget.controller;
    final ready = info.smsReady;
    void send() =>
        c.requestLanOtp(_mobile.text, purpose: _reset ? 'reset' : 'login');
    return _frame(
      title: _reset ? 'فراموشی رمز' : 'ورود با شمارهٔ همراه',
      children: [
        header,
        const SizedBox(height: PayeshTokens.space4),
        _field(
          'lan-mobile',
          _mobile,
          'شمارهٔ همراه',
          busy: busy || !ready,
          ltr: true,
          autofocus: ready,
          keyboard: TextInputType.phone,
          onGo: ready ? send : null,
        ),
        if (!ready)
          Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space3),
            child: Text(
              _reset
                  ? 'بازیابی رمز با پیامک به‌زودی فعال می‌شود. فعلاً رمز تازه را از مدیر مدرسه بگیرید.'
                  : 'ورود با پیامک به‌زودی فعال می‌شود. فعلاً با نام کاربری و رمز عبوری که مدیر مدرسه داده وارد شوید.',
              key: const Key('lan-sms-soon'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        _ErrorText(s.error),
        const SizedBox(height: PayeshTokens.space4),
        LoginPrimaryButton(
          buttonKey: const Key('lan-otp-send'),
          onPressed: busy || !ready ? null : send,
          child: _busyOr(busy, 'دریافت کد پیامکی'),
        ),
        TextButton(
          key: const Key('lan-switch-method'),
          onPressed: busy
              ? null
              : () => setState(() {
                  _reset = false;
                  _mobileMode = false;
                }),
          child: const Text('ورود با نام کاربری و رمز عبور'),
        ),
        if (!_reset) signup,
        const SizedBox(height: PayeshTokens.space3),
        change,
      ],
    );
  }

  /// Row 160 — the SMS code (and, for «فراموشی رمز», the new password).
  Widget _otpCodeForm(
    LanServerInfo info,
    LanOtpStep otp,
    Widget header,
    bool busy,
    Widget change,
  ) {
    final c = widget.controller;
    final s = widget.state;
    void go() => c.verifyLanOtp(
      _code.text,
      newPassword: otp.reset ? _newPassword.text : null,
    );
    return _frame(
      title: otp.reset ? 'رمز تازه' : 'کد پیامکی',
      children: [
        header,
        const SizedBox(height: PayeshTokens.space4),
        Text(
          'اگر این شماره در مدرسه ثبت شده باشد، کد ${_fa(otp.ticket.length)} رقمی به ${_fa(otp.phone)} پیامک شد (تا ${_fa(otp.ticket.ttl.inMinutes)} دقیقه معتبر است).',
          key: const Key('lan-otp-sent'),
        ),
        const SizedBox(height: PayeshTokens.space3),
        _field(
          'lan-otp-code',
          _code,
          'کد پیامکی',
          busy: busy,
          ltr: true,
          autofocus: true,
          keyboard: TextInputType.number,
          onGo: otp.reset ? null : go,
        ),
        if (otp.reset)
          _field(
            'lan-otp-password',
            _newPassword,
            'رمز تازه (دست‌کم ۴ نویسه)',
            busy: busy,
            ltr: true,
            secret: true,
            onGo: go,
          ),
        _ErrorText(s.error),
        const SizedBox(height: PayeshTokens.space4),
        LoginPrimaryButton(
          buttonKey: const Key('lan-otp-verify'),
          onPressed: busy ? null : go,
          child: _busyOr(busy, otp.reset ? 'ثبت رمز تازه و ورود' : 'ورود'),
        ),
        TextButton(
          key: const Key('lan-otp-resend'),
          onPressed: busy
              ? null
              : () => c.requestLanOtp(otp.phone, purpose: otp.purpose),
          child: const Text('ارسال دوبارهٔ کد'),
        ),
        TextButton(
          key: const Key('lan-otp-back'),
          onPressed: busy
              ? null
              : () {
                  _code.clear();
                  c.cancelLanOtp();
                },
          child: const Text('بازگشت'),
        ),
        const SizedBox(height: PayeshTokens.space3),
        change,
      ],
    );
  }

  static String _fa(Object n) => '$n'.replaceAllMapped(
    RegExp('[0-9]'),
    (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
  );

  Widget _busyOr(bool busy, String label) => busy
      ? const SizedBox.square(
          dimension: 20,
          child: CircularProgressIndicator(
            key: Key('login-busy'),
            strokeWidth: 2,
          ),
        )
      : Text(label);

  /// Row 163 — password fields show / hide the typed password.
  bool _showSecret = false;

  // Row 166: after a refused submit every field the message is about gets a red outline (each
  // login field counts as required); typing in a field clears its outline.
  final Map<String, FieldInfo Function()> _reg = {};
  String? _errSeen;
  Map<String, String> _issues = const {};

  void _syncIssues(String? error) {
    if (error == _errSeen) return;
    _errSeen = error;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final infos = {for (final e in _reg.entries) e.key: e.value()};
      setState(
        () => _issues = error == null
            ? const {}
            : FieldIssues.guess(error, infos),
      );
    });
  }

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
    IconData? icon,
    VoidCallback? onGo,
  }) {
    final t = context.tokens;
    final radius = BorderRadius.circular(14);
    _reg[key] = () => (label: '$label *', value: c.text);
    final issue = _issues[key];
    return Padding(
      padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
      child: FieldBox(
        width: kFieldText,
        child: TextField(
          key: Key(key),
          controller: c,
          onChanged: (_) {
            if (_issues.containsKey(key)) {
              setState(() => _issues = {..._issues}..remove(key));
            }
          },
          enabled: !busy,
          autofocus: autofocus,
          obscureText: secret && !_showSecret,
          autocorrect: false,
          enableSuggestions: !secret,
          textDirection: ltr ? TextDirection.ltr : null,
          keyboardType: keyboard,
          textInputAction: onGo == null
              ? TextInputAction.next
              : TextInputAction.go,
          onSubmitted: onGo == null ? null : (_) => onGo(),
          decoration: InputDecoration(
            labelText: label,
            hintText: hint,
            errorText: issue,
            errorMaxLines: 3,
            filled: true,
            fillColor: t.bg,
            prefixIcon: icon == null ? null : Icon(icon, color: t.muted),
            suffixIcon: secret
                ? IconButton(
                    tooltip: _showSecret ? 'پنهان کردن رمز' : 'نمایش رمز',
                    onPressed: () => setState(() => _showSecret = !_showSecret),
                    icon: Icon(
                      _showSecret
                          ? Icons.visibility_off_outlined
                          : Icons.visibility_outlined,
                      color: t.muted,
                    ),
                  )
                : null,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 16,
              vertical: 16,
            ),
            border: OutlineInputBorder(
              borderRadius: radius,
              borderSide: BorderSide(color: t.line),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: radius,
              borderSide: BorderSide(color: t.line),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: radius,
              borderSide: BorderSide(color: t.primary, width: 1.6),
            ),
            errorBorder: OutlineInputBorder(
              borderRadius: radius,
              borderSide: BorderSide(
                color: Theme.of(context).colorScheme.error,
                width: 1.6,
              ),
            ),
            focusedErrorBorder: OutlineInputBorder(
              borderRadius: radius,
              borderSide: BorderSide(
                color: Theme.of(context).colorScheme.error,
                width: 2,
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Row 163 — every LAN screen sits in the brand frame; the single login screen also shows the
  /// database connection line on top of the card.
  Widget _frame({
    required String title,
    String? subtitle,
    required List<Widget> children,
  }) {
    final c = widget.controller;
    return LoginBrandFrame(
      title: title,
      subtitle: subtitle,
      status: c.lanFirst
          ? LoginConnectionPill(
              state: widget.state,
              busy: c.busy,
              onRetry: c.reconnect,
            )
          : null,
      children: children,
    );
  }

  /// Row 162/163 — THE first screen of the app: username + password, or mobile + SMS code, in the
  /// order the owner chose in the owner panel. NO server address and no school code: the app
  /// finds the school server by itself (remembered server → this computer → the address-only list
  /// in the owner's database) and the line on top of the card says whether the school database
  /// is connected. A press while the search runs waits for it, then signs in.
  Widget _firstLogin(NeedLan s, bool busy) {
    final c = widget.controller;
    final info = s.info;
    final mobile =
        _reset || (_mobileMode ?? (info?.mobileFirst ?? c.lastMobileFirst));
    final smsReady = info?.smsReady ?? true;
    final school = info?.schoolName;
    final tabs = _reset
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(bottom: PayeshTokens.space4),
            child: LoginMethodTabs(
              mobile: mobile,
              enabled: !busy,
              onChange: (m) => setState(() {
                _reset = false;
                _mobileMode = m;
              }),
            ),
          );
    final signup = info != null && c.signupAvailable
        ? Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space3),
            child: OutlinedButton.icon(
              key: const Key('lan-signup'),
              onPressed: busy ? null : c.openSignup,
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(46),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              icon: const Icon(Icons.add_business_outlined),
              label: const Text('درخواست ثبت نام مدرسه جدید'),
            ),
          )
        : const SizedBox.shrink();
    // the connection line on top already names the school once it is connected
    final schoolLine = school == null || c.lanFirst
        ? null
        : Padding(
            padding: const EdgeInsets.only(bottom: PayeshTokens.space4),
            child: Row(
              children: [
                Icon(
                  Icons.apartment_rounded,
                  size: 18,
                  color: context.tokens.muted,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    school,
                    key: const Key('lan-school'),
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      color: context.tokens.ink,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          );
    if (mobile) {
      void send() => c.connectAndRequestOtp(
        _mobile.text,
        purpose: _reset ? 'reset' : 'login',
      );
      final ready = smsReady;
      return _frame(
        title: _reset ? 'فراموشی رمز' : 'ورود با شمارهٔ همراه',
        subtitle: _reset
            ? 'شمارهٔ همراه ثبت‌شده در مدرسه را بنویسید تا کد بازیابی پیامک شود.'
            : 'کد یکبارمصرف به شمارهٔ همراه شما پیامک می‌شود.',
        children: [
          ?schoolLine,
          tabs,
          _field(
            'lan-mobile',
            _mobile,
            'شمارهٔ همراه',
            busy: busy || !ready,
            ltr: true,
            autofocus: ready,
            keyboard: TextInputType.phone,
            hint: '09xxxxxxxxx',
            icon: Icons.phone_iphone_rounded,
            onGo: ready ? send : null,
          ),
          if (!ready)
            Padding(
              padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
              child: Text(
                _reset
                    ? 'بازیابی رمز با پیامک به‌زودی فعال می‌شود. فعلاً رمز تازه را از مدیر مدرسه بگیرید.'
                    : 'ورود با پیامک به‌زودی فعال می‌شود. فعلاً با نام کاربری و رمز عبوری که مدیر مدرسه داده وارد شوید.',
                key: const Key('lan-sms-soon'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          _ErrorText(s.error),
          const SizedBox(height: PayeshTokens.space4),
          LoginPrimaryButton(
            buttonKey: const Key('lan-otp-send'),
            onPressed: busy || !ready ? null : send,
            child: _busyOr(busy, 'دریافت کد پیامکی'),
          ),
          if (_reset)
            TextButton(
              key: const Key('lan-reset-back'),
              onPressed: busy
                  ? null
                  : () => setState(() {
                      _reset = false;
                      _mobileMode = false;
                    }),
              child: const Text('بازگشت به ورود'),
            ),
          if (!_reset) signup,
        ],
      );
    }
    void go() => c.connectAndLogin(_phone.text, _password.text);
    return _frame(
      title: 'ورود به پایش',
      subtitle:
          'با نام کاربری و رمزی که مدیر مدرسه برایتان تعریف کرده وارد شوید.',
      children: [
        ?schoolLine,
        tabs,
        _field(
          'lan-phone',
          _phone,
          'نام کاربری',
          busy: busy,
          ltr: true,
          autofocus: true,
          keyboard: TextInputType.visiblePassword,
          hint: 'شمارهٔ همراه، کد ملی یا نام کاربری',
          icon: Icons.person_outline_rounded,
        ),
        _field(
          'lan-password',
          _password,
          'رمز عبور',
          busy: busy,
          ltr: true,
          secret: true,
          icon: Icons.lock_outline_rounded,
          onGo: go,
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            key: const Key('lan-forgot'),
            onPressed: busy
                ? null
                : () => setState(() {
                    _reset = true;
                    final d = LanServerRules.digitsOnly(_phone.text);
                    if (d.length == 11) _mobile.text = d;
                  }),
            child: const Text('فراموشی رمز'),
          ),
        ),
        _ErrorText(s.error),
        const SizedBox(height: PayeshTokens.space3),
        LoginPrimaryButton(
          buttonKey: const Key('lan-login'),
          onPressed: busy ? null : go,
          child: _busyOr(busy, 'ورود'),
        ),
        // row 128 / W7 — web form `claim`: only on the server computer itself
        if (info != null &&
            LanServerRules.isLoopbackHost(info.server.host) &&
            c.flags.usesSchool(SchoolWave.accounts))
          TextButton(
            key: const Key('lan-claim'),
            onPressed: busy ? null : c.openClaim,
            child: const Text('رمز مدیر را فراموش کرده‌اید؟'),
          ),
        if (_loginInstead)
          TextButton(
            key: const Key('lan-setup-instead'),
            onPressed: busy
                ? null
                : () => setState(() => _loginInstead = false),
            child: const Text('راه‌اندازی اولیهٔ این سرور'),
          ),
        signup,
      ],
    );
  }

  @override
  void didUpdateWidget(LanServerScreen old) {
    super.didUpdateWidget(old);
    // row 162: the remembered server answered after the screen was built — show its address
    final t = widget.state.typed;
    if (t.isNotEmpty && _server.text.isEmpty) _server.text = t;
    final l = widget.state.login;
    if (l.isNotEmpty && _phone.text.isEmpty) _phone.text = l;
  }

  @override
  Widget build(BuildContext context) {
    _syncIssues(widget.state.error);
    final c = widget.controller;
    final s = widget.state;
    final busy = c.busy;
    final info = s.info;
    // row 163: one login screen — no address step, ever (the server is found by itself)
    if (c.lanFirst && s.otp == null && !(s.needsSetup && !_loginInstead)) {
      return _firstLogin(s, busy);
    }
    if (info == null) {
      void go() => c.submitLanServer(_server.text);
      return _frame(
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
          LoginPrimaryButton(
            buttonKey: const Key('lan-next'),
            onPressed: busy ? null : go,
            child: _busyOr(busy, 'ادامه'),
          ),
          if (c.gatewayAvailable) ...[
            const SizedBox(height: PayeshTokens.space3),
            TextButton(
              key: const Key('lan-back'),
              onPressed: busy ? null : c.leaveLan,
              child: const Text('ورود با کد مدرسه'),
            ),
          ],
        ],
      );
    }
    final header = WebWrap(
      spacing: PayeshTokens.space2,
      children: [
        Text(
          info.schoolName ?? 'سرور پایش',
          key: const Key('lan-school'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        // row 163: the single login screen never shows (or asks for) a server address
        if (!c.lanFirst)
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
    final Widget change = c.lanFirst
        ? const SizedBox.shrink()
        : TextButton(
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
      // web `renderSetup` (client/pages.js): the same fields, order and rules
      void go() => c.submitLanSetup(
        schoolName: _schoolName.text,
        managerName: _manager.text,
        phone: _phone.text,
        password: _password.text,
        password2: _password2.text,
        schoolType: _schoolType,
        schoolYear: _schoolYear.text,
      );
      return _frame(
        title: 'راه‌اندازی اولیهٔ سرور مدرسه',
        children: [
          header,
          const SizedBox(height: PayeshTokens.space3),
          const Text(
            'این فرم فقط یک‌بار پر می‌شود؛ بعد از آن همیشه صفحهٔ ورود می‌آید.',
            key: Key('lan-setup-help'),
          ),
          const SizedBox(height: PayeshTokens.space4),
          _field('lan-setup-school', _schoolName, 'نام مدرسه', busy: busy),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
                  child: FieldBox(
                    width: kFieldText,
                    child: DropdownButtonFormField<String>(
                      key: const Key('lan-setup-type'),
                      initialValue: _schoolType,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        labelText: 'نوع مدرسه',
                        border: OutlineInputBorder(),
                      ),
                      items: [
                        for (final t in setupSchoolTypes)
                          DropdownMenuItem(value: t, child: Text(t)),
                      ],
                      onChanged: busy
                          ? null
                          : (v) =>
                                setState(() => _schoolType = v ?? _schoolType),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: PayeshTokens.space3),
              Expanded(
                child: _field(
                  'lan-setup-year',
                  _schoolYear,
                  'سال تحصیلی',
                  busy: busy,
                ),
              ),
            ],
          ),
          _field(
            'lan-setup-manager',
            _manager,
            'نام مدیر',
            busy: busy,
            hint: 'نام و نام خانوادگی',
          ),
          _field(
            'lan-phone',
            _phone,
            'شمارهٔ همراه مدیر (نام کاربری ورود)',
            busy: busy,
            ltr: true,
            keyboard: TextInputType.phone,
            hint: '09xxxxxxxxx',
          ),
          _field(
            'lan-password',
            _password,
            'رمز عبور مدیر',
            busy: busy,
            ltr: true,
            secret: true,
            hint: 'حداقل ۴ نویسه',
          ),
          _field(
            'lan-password2',
            _password2,
            'تکرار رمز عبور',
            busy: busy,
            ltr: true,
            secret: true,
            onGo: go,
          ),
          _ErrorText(s.error),
          const SizedBox(height: PayeshTokens.space4),
          LoginPrimaryButton(
            buttonKey: const Key('lan-setup-submit'),
            onPressed: busy ? null : go,
            child: _busyOr(busy, 'ایجاد مدرسه'),
          ),
          const SizedBox(height: PayeshTokens.space2),
          const Text(
            'بعد از این، با «شمارهٔ همراه + رمز عبور» وارد می‌شوید.',
            key: Key('lan-setup-after'),
            textAlign: TextAlign.center,
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
    final otp = s.otp;
    if (otp != null) return _otpCodeForm(info, otp, header, busy, change);
    if (_reset || (_mobileMode ?? info.mobileFirst)) {
      return _mobileForm(info, s, header, busy, signup, change);
    }
    void go() => c.submitLanLogin(_phone.text, _password.text);
    return _frame(
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
        LoginPrimaryButton(
          buttonKey: const Key('lan-login'),
          onPressed: busy ? null : go,
          child: _busyOr(busy, 'ورود'),
        ),
        // row 160 — the second method, written under the first (owner setting picks the order)
        TextButton(
          key: const Key('lan-switch-method'),
          onPressed: busy ? null : () => setState(() => _mobileMode = true),
          child: const Text('ورود با شماره و کد یکبارمصرف'),
        ),
        TextButton(
          key: const Key('lan-forgot'),
          onPressed: busy
              ? null
              : () => setState(() {
                  _reset = true;
                  _mobile.text =
                      LanServerRules.digitsOnly(_phone.text).length == 11
                      ? LanServerRules.digitsOnly(_phone.text)
                      : _mobile.text;
                }),
          child: const Text('فراموشی رمز'),
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
        FieldBox(
          width: kFieldText,
          child: TextField(
            key: const Key('unlock-password'),
            controller: _password,
            obscureText: true,
            enabled: !busy,
            autofocus: true,
            textDirection: TextDirection.ltr,
            onSubmitted: (_) => _go(),
            decoration: const InputDecoration(labelText: 'رمز عبور'),
          ),
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
        FieldBox(
          width: kFieldDigits,
          child: TextField(
            key: const Key('claim-phone'),
            controller: _phone,
            enabled: !busy,
            keyboardType: TextInputType.phone,
            textDirection: TextDirection.ltr,
            decoration: const InputDecoration(labelText: 'شمارهٔ همراه مدیر'),
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        FieldBox(
          width: kFieldText,
          child: TextField(
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

/// Row 192: the payment report under the paywall (loads once when shown).
class _PaywallHistory extends StatefulWidget {
  const _PaywallHistory({required this.controller});
  final SessionController controller;

  @override
  State<_PaywallHistory> createState() => _PaywallHistoryState();
}

class _PaywallHistoryState extends State<_PaywallHistory> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.controller.subHistory == null) {
        widget.controller.loadSubHistory();
      }
    });
  }

  @override
  Widget build(BuildContext context) =>
      SubHistoryView(controller: widget.controller);
}
