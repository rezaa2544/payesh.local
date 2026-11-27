import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/pulse.dart';
import '../pulse/web.dart';
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

  /// W7: credential actions on the school's own server; null when this device is not on one
  /// (cloud Gateway) — passwords are online-only by design (F‑01, see accounts.dart).
  AccountsApi? get accounts;

  /// W12: managing the school server itself (backups, devices, audit, cloud settings);
  /// null when this device is not on the school's own server — online by design.
  ServerAdminApi? get admin;
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

  /// [quiet]: a background reload (a synced change) keeps the page as it is until the new
  /// data is read — no extra rebuild for the «loading» flag (row 200).
  Future<void> load({bool quiet = false}) async {
    loading = true;
    error = null;
    if (!quiet || db == null) emit();
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

  Future<void>? _reloading;
  bool _reloadAgain = false;

  /// Row 200: a sync pulls a big school in many batches and each one fires [SchoolSource.changed];
  /// every change started a whole new read of the page in parallel. Now one reload runs at a
  /// time and the changes that arrive meanwhile fold into one more.
  void _reload() {
    if (busy || _disposed) return;
    if (_reloading != null) {
      _reloadAgain = true;
      return;
    }
    _reloading = () async {
      try {
        do {
          _reloadAgain = false;
          await load(quiet: true);
        } while (_reloadAgain && !_disposed && !busy);
      } finally {
        _reloading = null;
      }
    }();
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
    this.children,
    this.headActions = const [],
    this.sub,
    this.subKey,
    this.headTitle,
    this.bare = false,
  });

  /// The page draws its own title row (the manager's `.dashboard-topbar`).
  final bool bare;

  /// Row 172: the web page itself — `pageHead(title, sub, headActions)` then these blocks in the
  /// web `.main` column ([body] is ignored when set).
  final List<Widget>? children;

  /// Buttons on the left of the web title row.
  final List<Widget> headActions;

  /// The small muted line under the web title.
  final String? sub;
  final Key? subKey;

  /// The web `<h2>` when it differs from [title].
  final String? headTitle;

  /// Key prefix of the page (`usr`, `cls`, …).
  final String prefix;
  final String title;
  final SchoolController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
  final Widget body;
  final Widget? fab;
  final List<Widget> actions;

  Widget _web(BuildContext context) {
    final c = controller;
    final inline = PulseInline.of(context);
    final content = c.loading && c.db == null && c.error == null
        ? Center(child: CircularProgressIndicator(key: Key('$prefix-loading')))
        : WebPageBody(
            children: [
              if (!bare)
                WebPageHead(
                  title: headTitle ?? title,
                  sub: sub,
                  subKey: subKey,
                  actions: headActions,
                ),
              if (c.error != null)
                WebBanner(
                  kind: WebBannerKind.err,
                  text: c.error!,
                  textKey: Key('$prefix-error'),
                )
              else if (c.notice != null)
                Semantics(
                  liveRegion: true,
                  child: WebBanner(
                    kind: WebBannerKind.ok,
                    text: c.notice!,
                    textKey: Key('$prefix-notice'),
                  ),
                ),
              ...children!,
            ],
          );
    return Scaffold(
      backgroundColor: inline ? Colors.transparent : Web.bg,
      appBar: inline
          ? null
          : AppBar(
              automaticallyImplyLeading: false,
              leading: IconButton(
                key: Key('$prefix-back'),
                tooltip: backOrCloseTooltip(context),
                icon: backOrCloseIcon(context),
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
      body: inline ? content : WebBackdrop(child: content),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = controller;
    if (children != null) {
      return ListenableBuilder(
        listenable: c,
        builder: (context, _) => _web(context),
      );
    }
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          // row 170: inside the «نبض» shell the sidebar is the way back
          automaticallyImplyLeading: false,
          leading: PulseInline.of(context)
              ? null
              : IconButton(
                  key: Key('$prefix-back'),
                  tooltip: backOrCloseTooltip(context),
                  icon: backOrCloseIcon(context),
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

/// Row 177: from this window width a [SchoolForm] opened with [openSchoolForm] is a centred
/// dialog about half the window wide (two columns of fields) instead of a full-screen page.
const double schoolFormDialogBreakpoint = 900;

/// Opens a [SchoolForm] page: a centred dialog on wide windows (Windows/tablet, row 177 — the
/// full-width page of ~20 fields was hard to read), the usual full-screen page on phones.
/// Closing needs the form's own «بستن» / «انصراف» (or Esc): a stray click outside never throws
/// away what was typed.
Future<T?> openSchoolForm<T>(BuildContext context, Widget form) {
  if (MediaQuery.sizeOf(context).width < schoolFormDialogBreakpoint) {
    return openPanel<T>(context, (_) => form);
  }
  return showDialog<T>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _SchoolFormDialog(child: form),
  );
}

/// Marks a [SchoolForm] shown by [openSchoolForm] as a dialog.
class _SchoolFormDialog extends InheritedWidget {
  const _SchoolFormDialog({required super.child});

  static bool of(BuildContext context) =>
      context.getInheritedWidgetOfExactType<_SchoolFormDialog>() != null;

  @override
  bool updateShouldNotify(_SchoolFormDialog oldWidget) => false;
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
    this.presetIssues = const {},
  });

  final String prefix;

  /// Row 202: boxes that open red (box key → message) — e.g. the wrong fields of an import
  /// row; each stays red until the user changes that box.
  final Map<String, String> presetIssues;
  final String title;
  final SchoolController controller;
  final List<Widget> fields;
  final String submitLabel;
  final VoidCallback onSubmit;

  Widget _error(BuildContext context, EdgeInsets padding) => Padding(
    padding: padding,
    child: Semantics(
      liveRegion: true,
      child: Text(
        controller.formError!,
        key: Key('$prefix-form-error'),
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      ),
    ),
  );

  /// Row 177: the dialog look — title + «بستن» on top, fields in two columns (a multi-line
  /// field takes the whole row), «انصراف» and the submit button at the bottom.
  Widget _dialog(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final theme = Theme.of(context);
    final width = (size.width * 0.5).clamp(560.0, 820.0);
    const gap = PayeshTokens.space4;
    return Dialog(
      key: Key('$prefix-form-dialog'),
      insetPadding: const EdgeInsets.all(PayeshTokens.space5),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: width,
          minWidth: width,
          maxHeight: size.height * 0.88,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(24, 14, 10, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      key: Key('$prefix-form-title'),
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    key: Key('$prefix-form-back'),
                    tooltip: 'بستن',
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.maybePop(context),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            if (controller.formError != null)
              _error(context, const EdgeInsets.fromLTRB(24, 12, 24, 0)),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
                child: LayoutBuilder(
                  builder: (context, box) {
                    final half = (box.maxWidth - gap) / 2;
                    return WebWrap(
                      spacing: gap,
                      runSpacing: PayeshTokens.space4,
                      children: [
                        for (final f in fields)
                          SizedBox(
                            width:
                                (f is SchoolField && f.lines > 1) ||
                                    f is SchoolFormFull
                                ? box.maxWidth
                                : half,
                            child: f,
                          ),
                      ],
                    );
                  },
                ),
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 12, 24, 14),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    key: Key('$prefix-form-cancel'),
                    onPressed: () => Navigator.maybePop(context),
                    child: const Text('انصراف'),
                  ),
                  const SizedBox(width: PayeshTokens.space3),
                  FilledButton(
                    key: Key('$prefix-save'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(180, 46),
                    ),
                    onPressed: controller.busy ? null : onSubmit,
                    child: Text(submitLabel),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => _IssueHost(
    preset: presetIssues,
    controller: controller,
    child: ListenableBuilder(
      listenable: controller,
      builder: (context, _) => _SchoolFormDialog.of(context)
          ? _dialog(context)
          : Scaffold(
              appBar: AppBar(
                leading: IconButton(
                  key: Key('$prefix-form-back'),
                  tooltip: backOrCloseTooltip(context),
                  icon: backOrCloseIcon(context),
                  onPressed: () => Navigator.maybePop(context),
                ),
                title: Text(title),
              ),
              // the refusal stays pinned above the fields: visible wherever the form was scrolled
              body: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (controller.formError != null)
                    _error(
                      context,
                      const EdgeInsets.fromLTRB(
                        PayeshTokens.space4,
                        PayeshTokens.space3,
                        PayeshTokens.space4,
                        0,
                      ),
                    ),
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.all(PayeshTokens.space4),
                      children: [
                        for (final f in fields)
                          Padding(
                            padding: const EdgeInsets.only(
                              bottom: PayeshTokens.space3,
                            ),
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
    ),
  );
}

/// Row 166: the red outline of every field a refused submit is about. The form's message
/// ([SchoolController.formError]) is matched to the [SchoolField]s registered below: empty
/// required (`*`) fields and the field whose label the message names. Typing in a field
/// clears its outline.
class _IssueHost extends StatefulWidget {
  const _IssueHost({
    required this.controller,
    required this.child,
    this.preset = const {},
  });
  final SchoolController controller;
  final Map<String, String> preset;
  final Widget child;

  @override
  State<_IssueHost> createState() => _IssueHostState();
}

class _IssueHostState extends State<_IssueHost> {
  late final FieldIssues issues = FieldIssues(widget.preset);
  String? _seen;

  /// Row 202: preset boxes the user has not changed yet (they stay red over [guessFrom]).
  late final Map<String, String> _open = {...widget.preset};
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_sync);
    issues.addListener(_cleared);
  }

  void _cleared() {
    if (_syncing) return;
    _open.removeWhere((k, _) => !issues.has(k));
  }

  void _sync() {
    final e = widget.controller.formError;
    if (e == _seen) return;
    _seen = e;
    _syncing = true;
    issues.guessFrom(e);
    for (final x in _open.entries) {
      if (!issues.has(x.key)) issues.set(x.key, x.value);
    }
    _syncing = false;
  }

  @override
  void dispose() {
    issues.removeListener(_cleared);
    widget.controller.removeListener(_sync);
    issues.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      FieldIssueScope(issues: issues, child: widget.child);
}

/// Row 194: a [SchoolForm] entry that takes the whole row in the two-column dialog (a section
/// title, a group of ticks, a picker with its own buttons).
class SchoolFormFull extends StatelessWidget {
  const SchoolFormFull({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}

/// Row 194: the title line of one part of a long form («مشخصات پدر», «سطح دسترسی», …).
class SchoolFormSection extends StatelessWidget {
  const SchoolFormSection(this.title, {super.key, this.note});
  final String title;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SchoolFormFull(
      child: Padding(
        padding: const EdgeInsets.only(top: PayeshTokens.space2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title,
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w800,
                color: theme.colorScheme.primary,
              ),
            ),
            if (note != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(note!, style: theme.textTheme.bodySmall),
              ),
            const SizedBox(height: PayeshTokens.space1),
            const Divider(height: 1),
          ],
        ),
      ),
    );
  }
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
    this.width,
  });

  final String keyName;
  final String label;
  final TextEditingController controller;
  final bool numeric;
  final int lines;

  /// Row 183: widest the box gets; by default as wide as what goes in it (digits / a name),
  /// multi-line text keeps the whole width.
  final double? width;

  @override
  Widget build(BuildContext context) {
    final issues = FieldIssueScope.maybeOf(context);
    issues?.register(keyName, () => (label: label, value: controller.text));
    final field = TextField(
      key: Key(keyName),
      controller: controller,
      keyboardType: numeric ? TextInputType.number : null,
      textDirection: numeric ? TextDirection.ltr : null,
      minLines: lines,
      maxLines: lines == 1 ? 1 : lines * 3,
      onChanged: (_) => issues?.clear(keyName),
      decoration: InputDecoration(
        labelText: label,
        errorText: issues?.of(keyName),
        errorMaxLines: 3,
        border: const OutlineInputBorder(),
      ),
    );
    final w = width ?? (lines > 1 ? null : FieldBox.standard(digits: numeric));
    return w == null ? field : FieldBox(width: w, child: field);
  }
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

/// Owns a page controller for one visit (disposed when the route closes).
class SchoolOwned extends StatefulWidget {
  const SchoolOwned({super.key, required this.create, required this.page});
  final SchoolController Function() create;
  final Widget Function(SchoolController c) page;

  @override
  State<SchoolOwned> createState() => _SchoolOwnedState();
}

class _SchoolOwnedState extends State<SchoolOwned> {
  late final SchoolController c = widget.create();

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.page(c);
}
