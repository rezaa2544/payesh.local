// Row 128 / W7 — accounts: the manager's "نام کاربری و رمز" page of one user (web
// `actUserCreds`: user-creds form, user-auto-pw, user-pick-pw, user-password, creds-delete) and
// every user's own password change (web form `own-password`).
//
// Username (= mobile) goes through the offline queue like every users edit; passwords go to the
// school server directly and never sit on the device (F‑01, packages/payesh_sync accounts.dart).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';

/// The manager's credential page of one user.
class CredsController extends SchoolController {
  CredsController({
    required super.source,
    required super.role,
    required super.uid,
    required this.userId,
  });

  final int userId;
  Map<String, Object?>? user;

  /// What the server says (null until loaded / when offline).
  AccountCredential? credential;

  /// The password shown after a change ("رمز تازه: …"); never written to disk.
  String? shownPassword;

  /// The server could not be reached for the credential part.
  String? serverError;
  bool get onServer => source.accounts != null;

  @override
  Future<void> read(SchoolRecords db) async {
    final row = await db.get('users', userId);
    user = row?.data;
    if (row == null) error = 'این کاربر دیگر وجود ندارد';
  }

  @override
  Future<void> load() async {
    await super.load();
    await loadCredential();
  }

  Future<void> loadCredential() async {
    final api = source.accounts;
    if (api == null) {
      serverError = 'رمزها روی سرور مدرسه نگه داشته می‌شوند — این دستگاه به سرور مدرسه وصل نیست';
      emit();
      return;
    }
    try {
      final all = await api.credentials();
      credential = all.where((c) => c.id == userId).firstOrNull;
      serverError = null;
    } on AccountFailure catch (e) {
      serverError = e.messageFa;
    }
    emit();
  }

  String get username =>
      credential?.username ??
      (user == null ? '' : AccountRules.usernameOf(user!));

  /// Web form `user-creds`: the username through the queue, the password (if typed) online.
  /// An unchanged username + an empty password changes nothing.
  Future<bool> save({required String phone, required String password}) async {
    final typed = SchoolRecords.digitsOnly(phone);
    final changedName =
        typed.isNotEmpty && SchoolRecords.mobile11(phone) != username;
    if (password.isNotEmpty && password.length < AccountRules.minPassword) {
      formError = const AccountFailure(AccountError.shortPassword).messageFa;
      emit();
      return false;
    }
    if (password.isNotEmpty && source.accounts == null) {
      formError = const AccountFailure(AccountError.offline).messageFa;
      emit();
      return false;
    }
    if (changedName) {
      final r = await run(
        (db) => UserDirectory(db).setUsername(userId, phone),
        form: true,
      );
      if (r == null) return false;
    }
    if (password.isNotEmpty) {
      final ok = await _online(
        (api) => api.setCredentials(userId, password: password),
        done: 'رمز تازه ثبت شد',
      );
      if (!ok) return false;
    }
    if (!changedName && password.isEmpty) {
      notice = 'تغییری نبود';
      emit();
    }
    return true;
  }

  /// Web `user-auto-pw`: password = national id (server: 6 random digits without one).
  Future<bool> autoPassword() =>
      _online((api) => api.autoPassword(userId), done: 'رمز = کد ملی شد');

  Future<bool> _online(
    Future<String?> Function(AccountsApi api) op, {
    required String done,
  }) async {
    final api = source.accounts;
    if (busy) return false;
    if (api == null) {
      formError = const AccountFailure(AccountError.offline).messageFa;
      emit();
      return false;
    }
    busy = true;
    formError = null;
    emit();
    var ok = false;
    try {
      final pw = await op(api);
      shownPassword = pw;
      notice = pw == null ? done : '$done: $pw';
      ok = true;
    } on AccountFailure catch (e) {
      formError = e.messageFa;
    }
    busy = false;
    emit();
    if (ok) await loadCredential();
    return ok;
  }

  Future<List<String>> orphanParents() async =>
      db == null ? const [] : UserDirectory(db!).orphanParentsOf(userId);

  /// Web `creds-delete`: the account (and a student's childless parents) — through the queue.
  Future<RecordWrite?> delete() =>
      run((db) => UserDirectory(db).delete(userId));
}

class CredsPage extends StatefulWidget {
  const CredsPage({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final CredsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<CredsPage> createState() => _CredsPageState();
}

class _CredsPageState extends State<CredsPage> {
  final phone = TextEditingController();
  final password = TextEditingController();
  bool _filled = false;

  CredsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    phone.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    final u = c.user;
    if (u == null) return;
    final kids = await c.orphanParents();
    if (!mounted) return;
    final isStudent = u['role'] == 'student';
    final name = fullName(u);
    final ok = await confirmAction(
      context,
      prefix: 'crd',
      title: 'حذف حساب',
      message: isStudent
          ? 'دانش‌آموز «$name» و حساب کاربری‌اش حذف شود؟'
                '${kids.isEmpty ? '' : '\nولیِ او هم (${kids.join('، ')}) که فرزند دیگری ندارد حذف می‌شود.'}'
                '\nاین کار قابل بازگشت نیست.'
          : 'حساب «$name» حذف شود؟ این کار قابل بازگشت نیست.',
    );
    if (!ok) return;
    final r = await c.delete();
    if (r != null && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      if (!_filled && c.user != null && !c.loading) {
        _filled = true;
        phone.text = c.username;
        password.text = c.credential?.password ?? '';
      }
      final u = c.user;
      return SchoolPage(
        prefix: 'crd',
        title: u == null ? 'نام کاربری و رمز' : 'کاربری — ${fullName(u)}',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: u == null
            ? const SizedBox.shrink()
            : ListView(
                padding: const EdgeInsets.all(PayeshTokens.space4),
                children: [
                  Text(
                    [
                      'نقش: ${roleFa[u['role']] ?? u['role']}',
                      if ('${u['national_id'] ?? ''}'.isNotEmpty)
                        'کد ملی: ${u['national_id']}',
                    ].join(' · '),
                    key: const Key('crd-role'),
                  ),
                  const SizedBox(height: PayeshTokens.space2),
                  const Text(
                    'با همین نام کاربری و رمز روی هر گوشی و رایانه‌ای وارد برنامه می‌شود.',
                  ),
                  if (c.serverError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: PayeshTokens.space2),
                      child: Text(
                        c.serverError!,
                        key: const Key('crd-server'),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  if (c.formError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: PayeshTokens.space2),
                      child: Semantics(
                        liveRegion: true,
                        child: Text(
                          c.formError!,
                          key: const Key('crd-form-error'),
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ),
                    ),
                  const SizedBox(height: PayeshTokens.space3),
                  SchoolField(
                    'crd-phone',
                    'نام کاربری (شمارهٔ همراه)',
                    phone,
                    numeric: true,
                  ),
                  const SizedBox(height: PayeshTokens.space3),
                  TextField(
                    key: const Key('crd-password'),
                    controller: password,
                    textDirection: TextDirection.ltr,
                    autocorrect: false,
                    enableSuggestions: false,
                    decoration: const InputDecoration(
                      labelText: 'رمز عبور',
                      helperText: 'خالی = همان رمز فعلی می‌ماند',
                    ),
                  ),
                  const SizedBox(height: PayeshTokens.space2),
                  Wrap(
                    spacing: PayeshTokens.space2,
                    children: [
                      OutlinedButton(
                        key: const Key('crd-auto'),
                        onPressed: c.busy
                            ? null
                            : () async {
                                if (await c.autoPassword()) {
                                  password.text = c.shownPassword ?? '';
                                }
                              },
                        child: const Text('رمز = کد ملی'),
                      ),
                      OutlinedButton(
                        key: const Key('crd-random'),
                        onPressed: () {
                          password.text = AccountRules.randomPassword();
                          password.selection = TextSelection(
                            baseOffset: 0,
                            extentOffset: password.text.length,
                          );
                        },
                        child: const Text('رمز تصادفی'),
                      ),
                      if (password.text.isNotEmpty)
                        IconButton(
                          key: const Key('crd-copy'),
                          tooltip: 'رونوشت رمز',
                          onPressed: () => Clipboard.setData(
                            ClipboardData(text: password.text),
                          ),
                          icon: const Icon(Icons.copy),
                        ),
                    ],
                  ),
                  const SizedBox(height: PayeshTokens.space3),
                  FilledButton(
                    key: const Key('crd-save'),
                    onPressed: c.busy
                        ? null
                        : () => c.save(
                            phone: phone.text,
                            password:
                                password.text == (c.credential?.password ?? '')
                                ? ''
                                : password.text,
                          ),
                    child: const Text('ذخیرهٔ نام کاربری و رمز'),
                  ),
                  const SizedBox(height: PayeshTokens.space4),
                  Align(
                    alignment: AlignmentDirectional.centerEnd,
                    child: FilledButton(
                      key: const Key('crd-delete'),
                      style: FilledButton.styleFrom(
                        backgroundColor: Theme.of(context).colorScheme.error,
                        foregroundColor: Theme.of(context).colorScheme.onError,
                      ),
                      onPressed: c.busy ? null : _delete,
                      child: const Text('حذف این حساب'),
                    ),
                  ),
                  const SizedBox(height: PayeshTokens.space2),
                  const Text(
                    'تغییر نام کاربری بدون اینترنت هم در صف می‌ماند و بعد فرستاده می‌شود؛ رمز فقط با اتصال به سرور مدرسه عوض می‌شود و روی این دستگاه نگه داشته نمی‌شود.',
                  ),
                ],
              ),
      );
    },
  );
}

/// Every user's own password (web form `own-password`).
class OwnPasswordController extends SchoolController {
  OwnPasswordController({
    required super.source,
    required super.role,
    required super.uid,
  });

  bool done = false;

  @override
  Future<void> read(SchoolRecords db) async {}

  @override
  Future<void> load() async {
    loading = false;
    emit();
  }

  Future<bool> change({
    required String current,
    required String next,
    required String again,
  }) async {
    if (busy) return false;
    String? bad;
    if (next.length < AccountRules.minPassword) {
      bad = 'رمز تازه باید حداقل ۴ نویسه باشد';
    } else if (next != again) {
      bad = 'رمز تازه و تکرارش یکی نیست';
    } else if (source.accounts == null) {
      bad = const AccountFailure(AccountError.offline).messageFa;
    }
    if (bad != null) {
      formError = bad;
      emit();
      return false;
    }
    busy = true;
    formError = null;
    emit();
    try {
      await source.accounts!.changeOwnPassword(current: current, next: next);
      done = true;
      notice = 'رمز عبور عوض شد';
    } on AccountFailure catch (e) {
      formError = e.messageFa;
    }
    busy = false;
    emit();
    return done;
  }
}

class OwnPasswordPage extends StatefulWidget {
  const OwnPasswordPage({super.key, required this.controller});
  final OwnPasswordController controller;

  @override
  State<OwnPasswordPage> createState() => _OwnPasswordPageState();
}

class _OwnPasswordPageState extends State<OwnPasswordPage> {
  final current = TextEditingController();
  final next = TextEditingController();
  final again = TextEditingController();

  @override
  void dispose() {
    current.dispose();
    next.dispose();
    again.dispose();
    super.dispose();
  }

  Widget _secret(String key, String label, TextEditingController t) =>
      TextField(
        key: Key(key),
        controller: t,
        obscureText: true,
        textDirection: TextDirection.ltr,
        autocorrect: false,
        enableSuggestions: false,
        decoration: InputDecoration(labelText: label),
      );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      return SchoolForm(
        prefix: 'pw',
        title: 'تغییر رمز من',
        controller: c,
        submitLabel: 'تغییر رمز',
        onSubmit: () async {
          final ok = await c.change(
            current: current.text,
            next: next.text,
            again: again.text,
          );
          if (ok) {
            current.clear();
            next.clear();
            again.clear();
          }
        },
        fields: [
          if (c.notice != null) Text(c.notice!, key: const Key('pw-notice')),
          _secret('pw-current', 'رمز فعلی', current),
          _secret('pw-next', 'رمز تازه (حداقل ۴ نویسه)', next),
          _secret('pw-again', 'تکرار رمز تازه', again),
        ],
      );
    },
  );
}
