import 'dart:convert' show HtmlEscape, HtmlEscapeMode;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../accounts/accounts_screen.dart';
import '../followup/followup_screen.dart';
import '../pulse/pulse.dart';
import '../pulse/web.dart';
import '../reports/reports_screen.dart' show ReportsController;
import '../school/school_source.dart';
import 'users_controller.dart';

/// Native `#/users` (row 128, W6): the manager's user list — search (name, mobile, national
/// id), role filter, multi-select with bulk delete, and per user: full profile, edit, delete.
/// Works offline; queued rows carry «در صف ارسال».
class UsersScreen extends StatefulWidget {
  const UsersScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
    this.accounts = false,
  });

  final UsersController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  /// W7 ships: each row offers «نام کاربری و رمز».
  final bool accounts;

  @override
  State<UsersScreen> createState() => _UsersScreenState();
}

class _UsersScreenState extends State<UsersScreen> {
  UsersController get c => widget.controller;
  final search = TextEditingController();

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<void> _open(Widget page) async {
    // Row 177: the user forms are a half-width dialog on wide windows; row 182: every other
    // user page (نام کاربری و رمز، کارت پیوند) opens as a small panel too.
    if (page is UserProfilePage ||
        page is UserFormPage ||
        page is UserEditPage) {
      await openSchoolForm<void>(context, page);
    } else {
      await openPanel<void>(context, (_) => page);
    }
    c.clearForm();
    // a sub-page with its own controller (credentials) may have changed the list
    if (mounted) await c.load();
  }

  Future<void> _delete(SchoolUser u) async {
    final parents = u.role == 'student'
        ? await c.orphanParents(u.id)
        : const <String>[];
    if (!mounted) return;
    final ok = await confirmAction(
      context,
      prefix: 'usr',
      title: 'حذف کاربر',
      message: u.role == 'student'
          ? 'دانش‌آموز «${u.name}» حذف شود؟'
                '${parents.isEmpty ? '' : '\nولیِ او هم (${parents.join('، ')}) حذف می‌شود.'}'
                '\nاین کار قابل بازگشت نیست.'
          : 'کاربر «${u.name}» حذف شود؟ این کار قابل بازگشت نیست.',
    );
    if (ok) await c.delete(u.id);
  }

  Future<void> _bulkDelete() async {
    final ok = await confirmAction(
      context,
      prefix: 'usr',
      title: 'حذف گروهی',
      message:
          '${faDigits(c.picked.length)} کاربر حذف شوند؟ این کار قابل بازگشت نیست.',
    );
    if (ok) await c.deletePicked();
  }

  Future<void> _creds(SchoolUser u) => _open(
    SchoolOwned(
      create: () => CredsController(
        source: c.source,
        role: c.role,
        uid: c.uid,
        userId: u.id,
      ),
      page: (cc) => CredsPage(
        controller: cc as CredsController,
        sync: widget.sync,
        onRetry: widget.onRetry,
      ),
    ),
  );

  Future<void> _import() async {
    await openPanel<void>(
      context,
      (_) => SchoolOwned(
        create: () =>
            ImportController(source: c.source, role: c.role, uid: c.uid),
        page: (ic) => ImportScreen(
          controller: ic as ImportController,
          sync: widget.sync,
          onRetry: widget.onRetry,
        ),
      ),
      width: kPanelWideWidth,
    );
    if (mounted) await c.load();
  }

  /// Row 172: web `PAGES.users` exactly — pageHead «کاربران» + «N کاربر» with «📥 ورود دسته‌ای
  /// (اکسل/CSV)» and «+ کاربر جدید»; the amber follow-up card; search + role pills; the red
  /// «N کاربر انتخاب شده» bar; the table (☐ · نام · نقش · پایه · رشته · عملیات).
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'usr',
      title: 'کاربران',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: c.canManage ? '${Web.fa(c.total)} کاربر' : null,
      subKey: const Key('usr-count'),
      headActions: [
        if (c.canManage) ...[
          WebBtn(
            '📥 ورود دسته‌ای (اکسل/CSV)',
            key: const Key('usr-import'),
            onPressed: _import,
          ),
          WebBtn(
            '+ کاربر جدید',
            key: const Key('usr-add'),
            kind: WebBtnKind.primary,
            onPressed: () => _open(UserFormPage(controller: c)),
          ),
        ],
      ],
      children: c.canManage
          ? _body(context)
          : const [WebEmpty('دسترسی ندارید.')],
    ),
  );

  List<Widget> _body(BuildContext context) {
    final parentCol = c.roleFilter == 'parent';
    return [
      if (c.followups > 0) _followupCard(context),
      WebCard.tight(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: const Key('usr-search'),
              controller: search,
              style: TextStyle(fontSize: 15, color: Web.ink),
              decoration: webInput(hint: 'جستجوی نام، شمارهٔ همراه یا کد ملی…'),
              onChanged: (v) => c.filter(search: v),
              onSubmitted: (v) => c.filter(search: v),
            ),
            const SizedBox(height: 8),
            WebPills(
              keyPrefix: 'usr-role',
              tabs: [
                for (final (v, label) in roleFilters)
                  (v.isEmpty ? 'all' : v, label),
              ],
              selected: c.roleFilter.isEmpty ? 'all' : c.roleFilter,
              onSelected: (v) => c.filter(role: v == 'all' ? '' : v),
            ),
          ],
        ),
      ),
      if (c.picked.isNotEmpty)
        _tinted(
          key: const Key('usr-picked-bar'),
          border: Web.deleteInk,
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '${Web.fa(c.picked.length)} کاربر انتخاب شده',
                  style: Web.b,
                ),
              ),
              WebBtn(
                'لغو انتخاب',
                key: const Key('usr-pick-clear'),
                kind: WebBtnKind.ghost,
                onPressed: c.clearPicks,
              ),
              const SizedBox(width: 8),
              WebBtn(
                'حذف انتخاب‌شده‌ها',
                key: const Key('usr-bulk-delete'),
                color: Colors.white,
                background: Web.deleteInk,
                onPressed: c.busy ? null : _bulkDelete,
              ),
            ],
          ),
        ),
      WebCard(
        key: const Key('usr-table'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.only(bottom: 6),
              child: Text.rich(
                TextSpan(
                  style: Web.small,
                  children: [
                    TextSpan(text: 'کاربری و رمز هر نفر داخل دکمهٔ '),
                    TextSpan(text: '«کاربری»', style: Web.b),
                    TextSpan(
                      text:
                          ' است — همان‌جا می‌بینید، عوض می‌کنید یا حساب را حذف می‌کنید. '
                          'نام کاربری همان ',
                    ),
                    TextSpan(text: 'شمارهٔ همراه', style: Web.b),
                    TextSpan(text: ' است (اگر شماره نبود، '),
                    TextSpan(text: 'کد ملی', style: Web.b),
                    TextSpan(text: ') و رمز اولیه '),
                    TextSpan(text: 'کد ملی', style: Web.b),
                    TextSpan(text: '. این جدول را فقط مدیر می‌بیند.'),
                  ],
                ),
              ),
            ),
            WebTable(
              minWidth: 760,
              head: [
                '',
                'نام و نام خانوادگی',
                'نقش',
                'پایه',
                'رشته',
                if (parentCol) 'ولیِ چه دانش‌آموزی',
                'عملیات',
              ],
              widths: const {0: 34},
              headCells: {
                0: _check(
                  const Key('usr-pick-all'),
                  c.users.isNotEmpty && c.picked.length == c.users.length,
                  (v) => c.pickAll(v),
                ),
              },
              rowColor: (i) =>
                  c.picked.contains(c.users[i].id) ? Web.redBg : null,
              rows: [for (final u in c.users) _row(u, parentCol)],
            ),
            if (c.users.isEmpty && c.error == null)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: WebEmpty(
                  'کاربری با این مشخصات پیدا نشد.',
                  key: Key('usr-empty'),
                ),
              ),
          ],
        ),
      ),
    ];
  }

  Widget _check(Key key, bool value, ValueChanged<bool> onChanged) => SizedBox(
    width: 20,
    height: 20,
    child: Checkbox(
      key: key,
      value: value,
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      side: BorderSide(color: Web.muted),
      activeColor: Web.primary,
      checkColor: Web.onPrimary,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.5)),
      onChanged: (v) => onChanged(v ?? false),
    ),
  );

  static Widget get _muted => Text('—', style: TextStyle(color: Web.muted));

  List<Widget> _row(SchoolUser u, bool parentCol) {
    final small = Web.small.copyWith(color: Web.ink);
    return [
      _check(
        Key('usr-pick-${u.id}'),
        c.picked.contains(u.id),
        (_) => c.togglePick(u.id),
      ),
      Row(
        key: Key('usr-row-${u.id}'),
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(child: Text(u.name)),
          if (u.queued) ...[
            const SizedBox(width: 6),
            const WebBadge('در صف ارسال', tone: WebTone.amber),
          ],
          if (!u.active) ...[
            const SizedBox(width: 6),
            WebBadge('غیرفعال', tone: WebTone.red),
          ],
        ],
      ),
      if (u.role == 'student')
        _muted
      else
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: WebBadge(
            u.roleLabel,
            tone: u.role == 'manager' ? WebTone.purple : WebTone.none,
          ),
        ),
      if (u.grade.isEmpty) _muted else Text(u.grade, style: small),
      if (u.branch.isEmpty) _muted else Text(u.branch, style: small),
      if (parentCol)
        if (u.kids.isEmpty) _muted else Text(u.kids.join('، '), style: small),
      Wrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          WebBtn(
            'مشخصات کامل',
            key: Key('usr-full-${u.id}'),
            kind: WebBtnKind.primary,
            onPressed: () => _open(UserProfilePage(controller: c, user: u)),
          ),
          if (widget.accounts)
            WebBtn(
              'کاربری',
              key: Key('usr-creds-${u.id}'),
              onPressed: () => _creds(u),
            ),
          if (c.source.accounts != null)
            WebBtn(
              'کارت پیوند',
              key: Key('usr-pair-${u.id}'),
              onPressed: () =>
                  _open(PairCardPage(accounts: c.source.accounts!, user: u)),
            ),
          WebBtn(
            'ویرایش',
            key: Key('usr-edit-${u.id}'),
            kind: WebBtnKind.ghost,
            onPressed: () => _open(UserEditPage(controller: c, user: u)),
          ),
          WebBtn.delete(
            'حذف',
            key: Key('usr-delete-${u.id}'),
            onPressed: c.busy ? null : () => _delete(u),
          ),
        ],
      ),
    ];
  }

  Widget _tinted({
    Key? key,
    required Color border,
    Color? background,
    required Widget child,
  }) => Padding(
    key: key,
    padding: const EdgeInsets.only(bottom: 12),
    child: Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: background ?? Web.card,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(Web.radius),
        boxShadow: Web.shadow,
      ),
      child: child,
    ),
  );

  Widget _followupCard(BuildContext context) => _tinted(
    key: const Key('usr-followup'),
    border: Web.amber.withValues(alpha: 0.45),
    background: Web.amberBg,
    child: Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 8,
      runSpacing: 8,
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '🕒 ${Web.fa(c.followups)} مورد نیاز به پیگیری دارد',
              style: Web.b,
            ),
            const SizedBox(height: 4),
            Text(
              '${Web.fa(c.followupIssues)} ردیف از ورود دسته‌ای + '
              '${Web.fa(c.followups - c.followupIssues)} دانش‌آموز که کلاسش درست نیست '
              '(رشته یا پایه‌اش حذف شده یا پایه نداشت).',
              style: Web.small,
            ),
          ],
        ),
        Wrap(
          spacing: 8,
          children: [
            WebBtn(
              'صفحهٔ پیگیری',
              key: const Key('usr-followup-go'),
              kind: WebBtnKind.ghost,
              onPressed: () => PulseInline.go(context, 'followup'),
            ),
            WebBtn(
              'مشاهده و اصلاح',
              key: const Key('usr-followup-open'),
              onPressed: () => PulseInline.go(context, 'followup'),
            ),
          ],
        ),
      ],
    ),
  );
}

/// Web «کارت پیوند» (`pairCardHtml`): name, role, the code, the QR that signs the phone in
/// (or installs the app first), «🔄 کد تازه». The code comes from the school server.
class PairCardPage extends StatefulWidget {
  const PairCardPage({super.key, required this.accounts, required this.user});
  final AccountsApi accounts;
  final SchoolUser user;

  @override
  State<PairCardPage> createState() => _PairCardPageState();
}

class _PairCardPageState extends State<PairCardPage> {
  PairCard? card;
  String? error;
  bool busy = false;

  static const _apk =
      'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/payesh-native.apk';

  @override
  void initState() {
    super.initState();
    _load(false);
  }

  Future<void> _load(bool refresh) async {
    setState(() => busy = true);
    try {
      final r = await widget.accounts.pairCode(
        widget.user.id,
        refresh: refresh,
      );
      if (!mounted) return;
      setState(() {
        card = r;
        error = null;
      });
      if (refresh) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text('کد تازه ساخته شد — کد قبلی باطل شد')),
        );
      }
    } on Object catch (e) {
      if (mounted) {
        setState(
          () => error =
              'ساخت کد ناموفق: ${e is AccountFailure ? e.messageFa : e}',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget _qr(String text, double size, double pad, double radius, int scale) {
    final url = widget.accounts.qrImage(text, scale: scale);
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(pad),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: url == null
          ? const SizedBox.shrink()
          : Image.network(
              url.toString(),
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
            ),
    );
  }

  /// Web `print` (`window.print()` on the card): the native app writes the same card as one
  /// printable HTML file (like «چاپ» on «گزارش‌ها») and says where it is.
  Future<void> _print(PairCard r, String link) async {
    const esc = HtmlEscape(HtmlEscapeMode.attribute);
    String qr(String text, int scale) =>
        esc.convert('${widget.accounts.qrImage(text, scale: scale) ?? ''}');
    final name = esc.convert(r.name.isEmpty ? widget.user.name : r.name);
    final role = esc.convert(roleFa[r.role] ?? widget.user.roleLabel);
    final html =
        '''<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>کارت پیوند — $name</title>
<style>body{font-family:Vazirmatn,Tahoma,sans-serif;color:#0f2b27;margin:24px}
.paircard{max-width:360px;margin:auto;border:2px solid #d7ebe6;border-radius:18px;padding:18px;text-align:center}
.who{font-weight:700;font-size:18px}.small{font-size:12.5px;line-height:1.9}.muted{color:#5d7d76}
.code{font-size:30px;font-weight:900;letter-spacing:3px;direction:ltr;color:#0f766e}
.ltr{direction:ltr}</style></head><body onload="window.print()">
<div class="paircard">
<div class="who">$name</div><div class="small muted">$role</div>
<div class="code">${esc.convert(r.display)}</div>
<div class="small muted">این کد تا وقتی خودتان «کد تازه» نسازید کار می‌کند.</div>
<div style="margin-top:12px"><img alt="QR" src="${qr(link, 6)}" style="width:210px;height:210px">
<div class="small" style="margin-top:6px">📷 <b>با دوربین گوشی اسکن کنید</b><br>برنامه نصب است؟ بی‌درنگ وارد حساب خودتان می‌شوید.<br>نصب نیست؟ همین اسکن، برنامه را نصب می‌کند و بعد از نصب هم خودکار وارد می‌شوید.</div></div>
<div class="small muted ltr" style="margin-top:8px;font-size:10px;word-break:break-all">${esc.convert(link)}</div>
<div style="margin-top:10px"><img alt="QR" src="${qr(_apk, 4)}" style="width:84px;height:84px">
<div class="small muted">نصب برنامهٔ بومی<br><span class="ltr">native-continuous</span></div></div>
</div></body></html>''';
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      final id = widget.user.id;
      final path = await ReportsController.save(
        'payesh-pair-card-$id.html',
        html,
      );
      messenger?.showSnackBar(
        SnackBar(
          content: Text(
            'نسخهٔ چاپی کارت ذخیره شد: $path — آن را باز کنید و چاپ بگیرید',
          ),
        ),
      );
    } on Exception catch (e) {
      messenger?.showSnackBar(
        SnackBar(content: Text('فایل چاپی ذخیره نشد: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = card;
    final link = r == null ? '' : widget.accounts.pairLink(r.code);
    return Scaffold(
      backgroundColor: Web.bg,
      appBar: AppBar(title: const Text('کارت پیوند')),
      body: WebText(
        // row 183: not a lazy ListView — in the panel the lower rows must stay built
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (error != null)
                WebBanner(
                  key: const Key('pair-error'),
                  kind: WebBannerKind.err,
                  text: error!,
                ),
              if (r == null && error == null)
                const Center(child: CircularProgressIndicator()),
              if (r != null) ...[
                Container(
                  key: const Key('pair-card'),
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: Web.card,
                    border: Border.all(color: Web.line, width: 2),
                    borderRadius: BorderRadius.circular(Web.radius),
                  ),
                  child: Column(
                    children: [
                      Text(
                        r.name.isEmpty ? widget.user.name : r.name,
                        style: Web.b.copyWith(fontSize: 18),
                      ),
                      Text(
                        roleFa[r.role] ?? widget.user.roleLabel,
                        style: Web.small,
                      ),
                      const SizedBox(height: 8),
                      Directionality(
                        textDirection: TextDirection.ltr,
                        child: Text(
                          r.display,
                          key: const Key('pair-code'),
                          style: TextStyle(
                            fontSize: 30,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 3,
                            color: Web.primary2,
                          ),
                        ),
                      ),
                      Text(
                        'این کد تا وقتی خودتان «کد تازه» نسازید کار می‌کند.',
                        style: Web.small,
                      ),
                      const SizedBox(height: 12),
                      _qr(link, 210, 8, 14, 6),
                      const SizedBox(height: 6),
                      Text.rich(
                        TextSpan(
                          style: TextStyle(fontSize: 13, height: 1.9),
                          children: [
                            TextSpan(text: '📷 '),
                            TextSpan(
                              text: 'با دوربین گوشی اسکن کنید',
                              style: Web.b,
                            ),
                            TextSpan(
                              text:
                                  '\nبرنامه نصب است؟ بی‌درنگ وارد حساب خودتان می‌شوید.'
                                  '\nنصب نیست؟ همین اسکن، برنامه را نصب می‌کند و بعد از نصب هم خودکار وارد می‌شوید.',
                            ),
                          ],
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 8),
                      Directionality(
                        textDirection: TextDirection.ltr,
                        child: Text(
                          link,
                          style: Web.small.copyWith(fontSize: 10),
                          textAlign: TextAlign.center,
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          _qr(_apk, 84, 4, 10, 4),
                          const SizedBox(width: 10),
                          Text(
                            'نصب برنامهٔ بومی\nnative-continuous',
                            style: Web.small,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'کاربر یا کد را در صفحهٔ ورود می‌زند، یا QR را اسکن می‌کند. این کد چندبار و برای چند دستگاه کار می‌کند — تا وقتی خودتان کد تازه نسازید.',
                  key: Key('pair-how'),
                  style: Web.small,
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: WebBtn(
                        '🖨️ چاپ کارت',
                        key: const Key('pair-print'),
                        size: WebBtnSize.normal,
                        block: true,
                        onPressed: busy ? null : () => _print(r, link),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: WebBtn(
                        '🔄 کد تازه',
                        key: const Key('pair-refresh'),
                        size: WebBtnSize.normal,
                        block: true,
                        onPressed: busy ? null : () => _load(true),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  '«کد تازه» همین کارت را باطل می‌کند و کد تازه می‌سازد — بعد از آن، کد و QR قبلی دیگر کار نمی‌کنند.',
                  style: Web.small,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The `user` form (web «کاربر جدید»).
class UserFormPage extends StatefulWidget {
  const UserFormPage({
    super.key,
    required this.controller,
    this.initial = const {},
    this.onSaved,
  });
  final UsersController controller;

  /// W10 `issue-fix`: the form opens with the values of the import row.
  final Map<String, String> initial;

  /// Runs after a successful save, before the form closes.
  final Future<void> Function(RecordWrite w)? onSaved;

  @override
  State<UserFormPage> createState() => _UserFormPageState();
}

class _UserFormPageState extends State<UserFormPage> {
  final f = {
    for (final k in [
      'name',
      'national_id',
      'phone',
      'birth_date',
      'gender',
      'parent_name',
      'parent_phone',
    ])
      k: TextEditingController(),
    for (final (k, _, _) in userExtraFields) k: TextEditingController(),
  };
  late String role = roleFa.containsKey(widget.initial['role'])
      ? widget.initial['role']!
      : 'student';
  int? classId;

  @override
  void initState() {
    super.initState();
    for (final e in widget.initial.entries) {
      f[e.key]?.text = e.value;
    }
  }

  @override
  void dispose() {
    for (final c in f.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.add(
      UserDraft(
        name: f['name']!.text,
        role: role,
        classId: role == 'student' ? classId : null,
        nationalId: f['national_id']!.text,
        phone: f['phone']!.text,
        birthDate: f['birth_date']!.text,
        gender: f['gender']!.text,
        parentName: f['parent_name']!.text,
        parentPhone: f['parent_phone']!.text,
        extra: {for (final (k, _, _) in userExtraFields) k: f[k]!.text},
      ),
    );
    if (r != null) await widget.onSaved?.call(r);
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'usr',
        title: 'کاربر جدید',
        controller: c,
        submitLabel: c.samePerson != null ? 'شخص دیگری است — ذخیره' : 'ذخیره',
        onSubmit: _save,
        fields: [
          SchoolField('usr-f-name', 'نام و نام خانوادگی', f['name']!),
          DropdownButtonFormField<String>(
            key: const Key('usr-f-role'),
            initialValue: role,
            decoration: const InputDecoration(
              labelText: 'نقش',
              border: OutlineInputBorder(),
            ),
            items: [
              for (final MapEntry(:key, :value) in roleFa.entries)
                DropdownMenuItem(value: key, child: Text(value)),
            ],
            onChanged: (v) => setState(() => role = v ?? 'student'),
          ),
          if (role == 'student')
            DropdownButtonFormField<int?>(
              key: const Key('usr-f-class'),
              initialValue: classId,
              decoration: const InputDecoration(
                labelText: 'کلاس',
                border: OutlineInputBorder(),
              ),
              items: [
                const DropdownMenuItem<int?>(value: null, child: Text('—')),
                for (final (id, name) in c.classes)
                  DropdownMenuItem<int?>(value: id, child: Text(name)),
              ],
              onChanged: (v) => setState(() => classId = v),
            ),
          SchoolField('usr-f-nid', 'کد ملی', f['national_id']!, numeric: true),
          SchoolField(
            'usr-f-phone',
            'شمارهٔ همراه (نام کاربری)',
            f['phone']!,
            numeric: true,
          ),
          SchoolField('usr-f-birth', 'تاریخ تولد', f['birth_date']!),
          SchoolField('usr-f-gender', 'جنسیت', f['gender']!),
          if (role == 'student') ...[
            SchoolField('usr-f-parent-name', 'نام ولی', f['parent_name']!),
            SchoolField(
              'usr-f-parent-phone',
              'همراه ولی',
              f['parent_phone']!,
              numeric: true,
            ),
          ],
          for (final (k, label, numeric) in userExtraFields)
            SchoolField('usr-f-$k', label, f[k]!, numeric: numeric),
        ],
      ),
    );
  }
}

/// `user-edit` (web «ویرایش کاربر»): name, mobile, active, extra fields.
class UserEditPage extends StatefulWidget {
  const UserEditPage({
    super.key,
    required this.controller,
    required this.user,
    this.onSaved,
  });
  final UsersController controller;
  final SchoolUser user;

  /// Runs after a successful save, before the form closes (W10 `issue-fix`).
  final Future<void> Function(RecordWrite w)? onSaved;

  @override
  State<UserEditPage> createState() => _UserEditPageState();
}

class _UserEditPageState extends State<UserEditPage> {
  late final name = TextEditingController(
    text: SchoolRecords.str(widget.user.data['name']),
  );
  late final phone = TextEditingController(text: widget.user.phone);
  late bool active = widget.user.active;
  late final extra = {
    for (final (k, _, _) in userExtraFields)
      k: TextEditingController(text: widget.user.field(k)),
  };

  @override
  void dispose() {
    name.dispose();
    phone.dispose();
    for (final c in extra.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.edit(
      widget.user.id,
      name: name.text,
      phone: phone.text,
      active: active,
      extra: {for (final e in extra.entries) e.key: e.value.text},
    );
    if (r != null) await widget.onSaved?.call(r);
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'usr',
    title: 'ویرایش ${widget.user.name}',
    controller: widget.controller,
    submitLabel: 'ذخیره',
    onSubmit: _save,
    fields: [
      SchoolField('usr-e-name', 'نام', name),
      SchoolField('usr-e-phone', 'شمارهٔ همراه', phone, numeric: true),
      StatefulBuilder(
        builder: (context, set) => SwitchListTile(
          key: const Key('usr-e-active'),
          title: const Text('فعال'),
          value: active,
          onChanged: (v) => set(() => active = v),
        ),
      ),
      for (final (k, label, numeric) in userExtraFields)
        SchoolField('usr-e-$k', label, extra[k]!, numeric: numeric),
    ],
  );
}

/// `user-full` (web «مشخصات کامل»).
class UserProfilePage extends StatefulWidget {
  const UserProfilePage({
    super.key,
    required this.controller,
    required this.user,
  });
  final UsersController controller;
  final SchoolUser user;

  static const List<(String, String, bool)> base = [
    ('name', 'نام', false),
    ('last_name', 'نام خانوادگی', false),
    ('national_id', 'کد ملی', true),
    ('phone', 'شمارهٔ همراه', true),
    ('birth_date', 'تاریخ تولد', false),
    ('gender', 'جنسیت', false),
  ];

  @override
  State<UserProfilePage> createState() => _UserProfilePageState();
}

class _UserProfilePageState extends State<UserProfilePage> {
  late final f = {
    for (final (k, _, _) in [...UserProfilePage.base, ...userExtraFields])
      k: TextEditingController(text: widget.user.field(k)),
  };

  @override
  void dispose() {
    for (final c in f.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final r = await widget.controller.saveFull(widget.user.id, {
      for (final e in f.entries)
        if (e.value.text.trim() != widget.user.field(e.key))
          e.key: e.value.text,
    });
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'usr',
    title: 'مشخصات کامل — ${widget.user.name}',
    controller: widget.controller,
    submitLabel: 'ذخیرهٔ مشخصات',
    onSubmit: _save,
    fields: [
      for (final (k, label, numeric) in [
        ...UserProfilePage.base,
        ...userExtraFields,
      ])
        SchoolField('usr-p-$k', label, f[k]!, numeric: numeric),
    ],
  );
}

/// Native `#/students` (W6).
class StudentsScreen extends StatefulWidget {
  const StudentsScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final StudentsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<StudentsScreen> createState() => _StudentsScreenState();
}

class _StudentsScreenState extends State<StudentsScreen> {
  StudentsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  /// Row 172: web `PAGES.students` exactly — pageHead «دانش‌آموزان من» (or «… مدرسه») with
  /// «N نفر»; a tight card holding the search box; a card with a `.list` of `.item`s: name,
  /// class, and the plain badge «معدل X» (or `empty('دانش‌آموزی یافت نشد.')`).
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'std',
      title: UserDirectory.wholeSchool.contains(c.role)
          ? 'دانش‌آموزان مدرسه'
          : 'دانش‌آموزان من',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: '${Web.fa(c.total)} نفر',
      subKey: const Key('std-count'),
      children: [
        WebCard.tight(
          child: TextField(
            key: const Key('std-search'),
            style: TextStyle(fontSize: 15, color: Web.ink),
            decoration: webInput(hint: 'جستجو…'),
            onChanged: c.search,
            onSubmitted: c.search,
          ),
        ),
        if (c.students.isEmpty)
          const WebEmpty('دانش‌آموزی یافت نشد.', key: Key('std-empty'))
        else
          WebCard(
            child: WebList(
              children: [
                for (final s in c.students)
                  WebItem(
                    key: Key('std-row-${s.user.id}'),
                    title: s.user.name,
                    sub: s.className,
                    actions: [
                      WebBadge(
                        'معدل ${faDigits(s.average.toStringAsFixed(1))}',
                        key: Key('std-avg-${s.user.id}'),
                      ),
                    ],
                  ),
              ],
            ),
          ),
      ],
    ),
  );
}

/// Native `#/record` (W6): the student's own record.
class RecordScreen extends StatefulWidget {
  const RecordScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final RecordController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<RecordScreen> {
  RecordController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  /// Row 172: web `PAGES.record` exactly (see [recordBlocks]).
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final r = c.record;
      final blocks = r == null ? const <Widget>[] : recordBlocks(r);
      return SchoolPage(
        prefix: 'rec',
        title: 'پروندهٔ من',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        // the blocks carry their own pageHead (web `studentHome` appends the same page)
        bare: r != null,
        children: blocks,
      );
    },
  );
}

/// Web `PAGES.record`: pageHead «پروندهٔ من» / class; the stat cards حضور (green from 90٪,
/// else amber) and نمره; «مشخصات» (the `userDetailRows` table, when there is any); the grades
/// table درس / نمره / وضعیت («—» when none).
///
/// [first]: this is the page's first title row — pulse.js puts the date chip on the first
/// `.topbar` only (on the student home the record follows the «امروز» row: no chip).
List<Widget> recordBlocks(StudentRecord r, {bool first = true}) => [
  WebPageHead(
    title: 'پروندهٔ من',
    sub: r.className,
    subKey: const Key('rec-class'),
    chip: first,
  ),
  WebGrid(
    children: [
      WebStat(
        icon: 'check',
        num: '${Web.fa(r.presentPercent)}٪',
        label: 'حضور',
        numKey: const Key('rec-present'),
        numColor: r.presentPercent >= 90 ? Web.green : Web.amber,
      ),
      WebStat(
        icon: 'pen',
        num: Web.fa(r.grades.length),
        label: 'نمره',
        numKey: const Key('rec-grade-count'),
      ),
    ],
  ),
  if (r.details.isNotEmpty)
    WebCard(
      key: const Key('rec-details'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('مشخصات', style: Web.b),
          ),
          WebTable(
            head: const ['', ''],
            headless: true,
            fixed: const [0.4, 0.6],
            rows: [
              for (final (label, value) in r.details)
                [
                  Text(
                    label,
                    style: TextStyle(fontSize: 12.5, color: Web.muted),
                  ),
                  Text(Web.fa(value), style: const TextStyle(fontSize: 12.5)),
                ],
            ],
          ),
        ],
      ),
    ),
  WebCard(
    key: const Key('rec-grades'),
    child: WebTable(
      head: const ['درس', 'نمره', 'وضعیت'],
      empty: r.grades.isEmpty
          ? Text('—', style: TextStyle(color: Web.muted))
          : null,
      rows: [
        for (final (i, (subject, score, approved)) in r.grades.indexed)
          [
            Text(subject, key: Key('rec-grade-$i')),
            Text(
              score == null ? '' : Web.fa(score),
              key: Key('rec-score-$i'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: WebBadge(
                approved ? 'تأییدشده' : 'در انتظار',
                key: Key('rec-state-$i'),
                tone: approved ? WebTone.green : WebTone.amber,
              ),
            ),
          ],
      ],
    ),
  ),
];
