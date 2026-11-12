// Row 128 / W7 — accounts: username + password of every user (web: `actUserCreds`,
// `user-auto-pw`, `user-pick-pw`, `user-password`, form `user-creds`, form `own-password`).
//
// Passwords are the one write of row 128 that is ONLINE BY DESIGN (documented in the parity
// matrix): the server keeps only a PBKDF2 verifier plus a sealed copy for the manager
// (server/auth.js `setPassword`, F‑01) and never accepts a password, hash or sealed copy from a
// device through sync (server/sync.js deletes `password_enc`/`password_plain`). Queuing a plain
// password on the device would put it on disk in the outbox — exactly what F‑01 forbids. So:
//   * the manager's credential actions call the school server directly and fail with a clear
//     "needs the school server" message when it is unreachable — nothing is half-written;
//   * the username part (= mobile number) is an ordinary users field: it goes through the
//     offline queue like every other edit (UserDirectory.edit, W6);
//   * the random-password generator is local.
import 'dart:math';

import 'lan_access.dart';
import 'records.dart';

/// Username/password of one user as the manager sees it (`GET /api/admin/users/credentials`).
final class AccountCredential {
  const AccountCredential({
    required this.id,
    required this.name,
    required this.role,
    required this.username,
    this.password,
  });
  final int id;
  final String name;
  final String role;

  /// Mobile number (or national id when there is no mobile).
  final String username;

  /// Current password when the server can show it (set by the manager, or still the national
  /// id); null = the user changed it — only a new one can be set.
  final String? password;
}

enum AccountError {
  /// The school server did not answer (or this device is not on the school's own server).
  offline,
  notManager,
  notFound,
  shortPassword,
  badPhone,
  duplicatePhone,

  /// Neither a mobile number nor a national id: no username possible.
  noLogin,

  /// Own password: the current password is wrong.
  wrongCurrent,
  unknown,
}

final class AccountFailure implements Exception {
  const AccountFailure(this.kind, [this.detail]);
  final AccountError kind;
  final String? detail;

  String get messageFa => switch (kind) {
    AccountError.offline => 'رمز فقط با اتصال به سرور مدرسه عوض می‌شود — اتصال را بررسی کنید و دوباره بزنید',
    AccountError.notManager => 'این کار فقط برای مدیر است',
    AccountError.notFound => 'این کاربر روی سرور پیدا نشد',
    AccountError.shortPassword => 'رمز باید حداقل ۴ نویسه باشد',
    AccountError.badPhone => 'شمارهٔ همراه باید ۱۱ رقم و با ۰۹ باشد',
    AccountError.duplicatePhone =>
      'این شماره قبلاً برای ${detail ?? 'کاربر دیگری'} ثبت شده',
    AccountError.noLogin =>
      'این کاربر نه شمارهٔ همراه دارد نه کد ملی — اول یکی را ثبت کنید',
    AccountError.wrongCurrent => 'رمز فعلی درست نیست',
    AccountError.unknown => 'انجام نشد — دوباره امتحان کنید',
  };

  @override
  String toString() =>
      'AccountFailure(${kind.name}${detail == null ? '' : ' $detail'})';
}

/// Local rules shared by the pages and the server calls (server/auth.js).
abstract final class AccountRules {
  static const int minPassword = 4;
  static const String _chars = 'abcdefghjkmnpqrstuvwxyz23456789';

  /// The web client's "رمز تصادفی": 8 characters without look-alikes (no i/l/o/0/1).
  static String randomPassword([Random? r]) {
    final rnd = r ?? Random.secure();
    return String.fromCharCodes(
      List.generate(8, (_) => _chars.codeUnitAt(rnd.nextInt(_chars.length))),
    );
  }

  /// username = mobile (≥ 10 digits), else a 10-digit national id (server/auth.js
  /// `credentialsFor`); '' = no way to sign in yet.
  static String usernameOf(Map<String, Object?> user) {
    final phone = SchoolRecords.digitsOnly('${user['phone'] ?? ''}');
    if (phone.length >= 10) return phone;
    final nid = SchoolRecords.digitsOnly('${user['national_id'] ?? ''}');
    return nid.length == 10 ? nid : '';
  }

  static void checkPassword(String pw) {
    if (pw.length < minPassword) {
      throw const AccountFailure(AccountError.shortPassword);
    }
  }
}

/// The manager's credential actions and the user's own password change.
abstract interface class AccountsApi {
  Future<List<AccountCredential>> credentials();

  /// Sets the username (mobile) and/or a new password; returns the password to show, if any.
  Future<String?> setCredentials(int id, {String? phone, String? password});

  /// "رمز = کد ملی" (server: national id, or 6 random digits without one); returns it.
  Future<String> autoPassword(int id);

  Future<void> changeOwnPassword({
    required String current,
    required String next,
  });
}

/// [AccountsApi] on the school's own server (row 127 LAN mode).
final class LanAccounts implements AccountsApi {
  LanAccounts({
    required this.client,
    required this.server,
    required this.token,
  });

  final LanAccessClient client;
  final Uri server;

  /// A valid access token (refreshing when needed); null = signed out / offline.
  final Future<String?> Function() token;

  Future<Map<String, Object?>> _call(
    String method,
    String path, [
    Object? body,
  ]) async {
    String? t;
    try {
      t = await token();
    } on Object {
      t = null;
    }
    if (t == null) throw const AccountFailure(AccountError.offline);
    try {
      return await client.request(method, server.resolve(path), body, token: t);
    } on LanAccessFailure catch (e) {
      throw switch (e.wire) {
        'forbidden' => const AccountFailure(AccountError.notManager),
        'user_not_found' => const AccountFailure(AccountError.notFound),
        'bad_password' => const AccountFailure(AccountError.shortPassword),
        'bad_phone' => const AccountFailure(AccountError.badPhone),
        'duplicate_phone' => const AccountFailure(AccountError.duplicatePhone),
        'no_phone' ||
        'no_national_id' => const AccountFailure(AccountError.noLogin),
        'bad_credentials' => const AccountFailure(AccountError.wrongCurrent),
        _ when e.kind == LanAccessError.unreachable => const AccountFailure(
          AccountError.offline,
        ),
        _ => AccountFailure(AccountError.unknown, e.wire),
      };
    }
  }

  @override
  Future<List<AccountCredential>> credentials() async {
    final j = await _call('GET', '/api/admin/users/credentials');
    final rows = j['users'];
    if (rows is! List) return const [];
    return [
      for (final r in rows)
        if (r is Map && r['id'] is num)
          AccountCredential(
            id: (r['id'] as num).toInt(),
            name: '${r['name'] ?? ''}',
            role: '${r['role'] ?? ''}',
            username: '${r['phone'] ?? ''}',
            password: r['password'] is String ? r['password'] as String : null,
          ),
    ];
  }

  @override
  Future<String?> setCredentials(
    int id, {
    String? phone,
    String? password,
  }) async {
    final body = <String, Object?>{};
    if (phone != null) {
      final p = SchoolRecords.digitsOnly(phone).isEmpty
          ? ''
          : SchoolRecords.mobile11(phone);
      if (p.isNotEmpty && !RegExp(r'^09\d{9}$').hasMatch(p)) {
        throw const AccountFailure(AccountError.badPhone);
      }
      body['phone'] = p;
    }
    if (password != null && password.isNotEmpty) {
      AccountRules.checkPassword(password);
      body['password'] = password;
    }
    if (body.isEmpty) return null;
    final j = await _call('PATCH', '/api/admin/users/$id', body);
    if (j['error'] == 'bad_password') {
      throw const AccountFailure(AccountError.shortPassword);
    }
    return j['password'] as String?;
  }

  @override
  Future<String> autoPassword(int id) async {
    final j = await _call('PATCH', '/api/admin/users/$id', {
      'auto_password': true,
    });
    final pw = j['password'];
    if (pw is! String || pw.isEmpty) {
      throw const AccountFailure(AccountError.noLogin);
    }
    return pw;
  }

  @override
  Future<void> changeOwnPassword({
    required String current,
    required String next,
  }) async {
    AccountRules.checkPassword(next);
    await _call('POST', '/api/auth/password', {
      'current': current,
      'next': next,
    });
  }
}
