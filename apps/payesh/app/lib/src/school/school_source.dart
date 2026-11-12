import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../sync_badge.dart';

/// Where the school-management pages of row 128 (waves W6..W12) read and write. Production: the
/// same encrypted local database + outbox + AutoSync as attendance/grades/notices
/// (attendance_wiring.dart); tests pass an in-memory one.
abstract interface class SchoolSource {
  /// The local school database for this user, or null when the device has none yet.
  Future<SchoolRecords?> recordsFor({required String role, required int uid});

  /// New ops were queued: send them soon (AutoSync.notifyEnqueued).
  void queued();

  /// Fires after local data changed (e.g. a pull finished); open pages re-read.
  Listenable get changed;
}

/// Shared state of a row-128 page: loading, busy, page error, confirmation, form error. Every
/// write runs through [run], which maps device refusals (RecordFailure) and a full queue
/// (SyncFailure) to Persian messages and nudges AutoSync when something was queued.
abstract class SchoolController extends ChangeNotifier {
  SchoolController({
    required this.source,
    required this.role,
    required this.uid,
  }) {
    source.changed.addListener(_reload);
  }

  final SchoolSource source;
  final String role;
  final int uid;

  SchoolRecords? db;
  bool _disposed = false;
  bool loading = true;
  bool busy = false;
  String? error;
  String? notice;
  String? formError;

  /// Reads the page data from [db] (called by [load] and after every write).
  Future<void> read(SchoolRecords db);

  void emit() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    loading = true;
    error = null;
    emit();
    try {
      final d = db ??= await source.recordsFor(role: role, uid: uid);
      if (d == null) {
        error = 'پایگاه محلی هنوز آماده نیست';
      } else {
        await read(d);
      }
    } on RecordFailure catch (e) {
      error = e.messageFa;
    } on Object {
      error = 'خواندن دادهٔ محلی ناموفق بود';
    }
    loading = false;
    emit();
  }

  void _reload() {
    if (!busy && !_disposed) load();
  }

  static String syncMessage(SyncFailure e) => e.code?.wire == 'queue_full'
      ? 'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید'
      : 'ذخیره ناموفق بود';

  /// Runs one write. Returns null when refused (message in [formError] or [error]).
  Future<RecordWrite?> run(
    Future<RecordWrite> Function(SchoolRecords db) op, {
    bool form = false,
  }) async {
    final d = db;
    if (d == null || busy) return null;
    busy = true;
    error = null;
    formError = null;
    notice = null;
    emit();
    RecordWrite? res;
    String? fail;
    try {
      res = await op(d);
      notice = res.messageFa;
      if (res.queued) source.queued();
      await read(d);
    } on RecordFailure catch (e) {
      fail = e.messageFa;
    } on SyncFailure catch (e) {
      fail = syncMessage(e);
    }
    if (fail != null) {
      if (form) {
        formError = fail;
      } else {
        error = fail;
      }
    }
    busy = false;
    emit();
    return res;
  }

  void clearForm() {
    formError = null;
    emit();
  }

  @override
  void dispose() {
    _disposed = true;
    source.changed.removeListener(_reload);
    super.dispose();
  }
}

/// Scaffold of a row-128 page: back button, title, sync badge, the page's error / confirmation
/// pinned above the content (visible wherever the list was scrolled).
class SchoolPage extends StatelessWidget {
  const SchoolPage({
    super.key,
    required this.prefix,
    required this.title,
    required this.controller,
    required this.sync,
    required this.body,
    this.onRetry,
    this.fab,
    this.actions = const [],
  });

  /// Key prefix of the page (`usr`, `cls`, …).
  final String prefix;
  final String title;
  final SchoolController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
  final Widget body;
  final Widget? fab;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          leading: IconButton(
            key: Key('$prefix-back'),
            tooltip: 'بازگشت',
            icon: const BackButtonIcon(),
            onPressed: () => Navigator.maybePop(context),
          ),
          title: Text(title),
          actions: [
            ...actions,
            Padding(
              padding: const EdgeInsetsDirectional.only(
                end: PayeshTokens.space2,
              ),
              child: Center(
                child: SyncBadge(status: sync, onRetry: onRetry),
              ),
            ),
          ],
        ),
        floatingActionButton: fab,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (c.error != null || c.notice != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  PayeshTokens.space4,
                  PayeshTokens.space3,
                  PayeshTokens.space4,
                  0,
                ),
                child: c.error != null
                    ? Text(
                        c.error!,
                        key: Key('$prefix-error'),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      )
                    : Semantics(
                        liveRegion: true,
                        child: Text(c.notice!, key: Key('$prefix-notice')),
                      ),
              ),
            Expanded(
              child: c.loading && c.db == null && c.error == null
                  ? Center(
                      child: CircularProgressIndicator(
                        key: Key('$prefix-loading'),
                      ),
                    )
                  : body,
            ),
          ],
        ),
      ),
    );
  }
}

/// A form page of row 128 (the web modal): error on top, fields, a submit button at the bottom.
/// The form stays open with what the user typed when the device refuses.
class SchoolForm extends StatelessWidget {
  const SchoolForm({
    super.key,
    required this.prefix,
    required this.title,
    required this.controller,
    required this.fields,
    required this.submitLabel,
    required this.onSubmit,
  });

  final String prefix;
  final String title;
  final SchoolController controller;
  final List<Widget> fields;
  final String submitLabel;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        leading: IconButton(
          key: Key('$prefix-form-back'),
          tooltip: 'بازگشت',
          icon: const BackButtonIcon(),
          onPressed: () => Navigator.maybePop(context),
        ),
        title: Text(title),
      ),
      // the refusal stays pinned above the fields: visible wherever the form was scrolled
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (controller.formError != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                PayeshTokens.space4,
                PayeshTokens.space3,
                PayeshTokens.space4,
                0,
              ),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  controller.formError!,
                  key: Key('$prefix-form-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(PayeshTokens.space4),
              children: [
                for (final f in fields)
                  Padding(
                    padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
                    child: f,
                  ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(PayeshTokens.space3),
          child: FilledButton(
            key: Key('$prefix-save'),
            onPressed: controller.busy ? null : onSubmit,
            child: Text(submitLabel),
          ),
        ),
      ),
    ),
  );
}

/// Labelled text field of a [SchoolForm].
class SchoolField extends StatelessWidget {
  const SchoolField(
    this.keyName,
    this.label,
    this.controller, {
    super.key,
    this.numeric = false,
    this.lines = 1,
  });

  final String keyName;
  final String label;
  final TextEditingController controller;
  final bool numeric;
  final int lines;

  @override
  Widget build(BuildContext context) => TextField(
    key: Key(keyName),
    controller: controller,
    keyboardType: numeric ? TextInputType.number : null,
    textDirection: numeric ? TextDirection.ltr : null,
    minLines: lines,
    maxLines: lines == 1 ? 1 : lines * 3,
    decoration: InputDecoration(
      labelText: label,
      border: const OutlineInputBorder(),
    ),
  );
}

/// Two-step confirmation (web `confirm()`); true only when the user confirmed.
Future<bool> confirmAction(
  BuildContext context, {
  required String prefix,
  required String title,
  required String message,
  String confirm = 'حذف',
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            key: Key('$prefix-confirm-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: Key('$prefix-confirm-ok'),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(confirm),
          ),
        ],
      ),
    ) ==
    true;
