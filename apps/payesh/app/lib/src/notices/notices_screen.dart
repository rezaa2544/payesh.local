import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../sync_badge.dart';
import 'notices_controller.dart';

/// Tone per severity — the label text is always shown (colour is never the only signal).
PayeshTone noticeTone(NoticeSeverity s) => switch (s) {
  NoticeSeverity.important => PayeshTone.danger,
  NoticeSeverity.info => PayeshTone.info,
  NoticeSeverity.normal => PayeshTone.neutral,
};

/// Native notices page (row 74, wave 4): every role reads the school's notices, newest first;
/// a manager also publishes, edits and deletes. Works offline: a write goes to the device and
/// the badge (and «در صف ارسال» on the card) shows it until the Gateway confirms.
class NoticesScreen extends StatefulWidget {
  const NoticesScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });

  final NoticesController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<NoticesScreen> createState() => _NoticesScreenState();
}

class _NoticesScreenState extends State<NoticesScreen> {
  NoticesController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _openEditor([Notice? n]) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => NoticeEditor(controller: c, editing: n),
      ),
    );
    c.clearForm();
  }

  Future<void> _confirmDelete(Notice n) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف اطلاعیه'),
        content: Text('اطلاعیهٔ «${n.title}» حذف شود؟'),
        actions: [
          TextButton(
            key: const Key('ntc-delete-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('انصراف'),
          ),
          FilledButton(
            key: const Key('ntc-delete-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (ok == true) await c.delete(n.id);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          leading: IconButton(
            key: const Key('ntc-back'),
            tooltip: 'بازگشت',
            icon: const BackButtonIcon(),
            onPressed: () => Navigator.maybePop(context),
          ),
          title: const Text('اطلاعیه‌ها'),
          actions: [
            Padding(
              padding: const EdgeInsetsDirectional.only(
                end: PayeshTokens.space2,
              ),
              child: Center(
                child: SyncBadge(status: widget.sync, onRetry: widget.onRetry),
              ),
            ),
          ],
        ),
        floatingActionButton: c.canWrite
            ? FloatingActionButton.extended(
                key: const Key('ntc-add'),
                onPressed: c.busy ? null : _openEditor,
                icon: const Icon(Icons.add),
                label: const Text('اطلاعیه'),
              )
            : null,
        body: _list(context),
      ),
    );
  }

  Widget _list(BuildContext context) {
    if (c.loading && c.notices.isEmpty && c.error == null) {
      return const Center(
        child: CircularProgressIndicator(key: Key('ntc-loading')),
      );
    }
    // messages and the count stay pinned above the list: a confirmation is visible wherever
    // the list was scrolled (e.g. after editing a card far down)
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            PayeshTokens.space4,
            PayeshTokens.space4,
            PayeshTokens.space4,
            0,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (c.error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
                  child: Text(
                    c.error!,
                    key: const Key('ntc-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (c.notice != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(c.notice!, key: const Key('ntc-notice')),
                  ),
                ),
              if (c.error == null)
                Text(
                  '${faDigits(c.notices.length)} مورد',
                  key: const Key('ntc-count'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              PayeshTokens.space4,
              PayeshTokens.space2,
              PayeshTokens.space4,
              96, // room above the add button
            ),
            children: [
              if (c.error == null && c.notices.isEmpty)
                const Text('اطلاعیه‌ای ثبت نشده.', key: Key('ntc-empty')),
              for (final n in c.notices) _card(context, n),
            ],
          ),
        ),
      ],
    );
  }

  Widget _card(BuildContext context, Notice n) {
    final theme = Theme.of(context);
    return Card(
      key: Key('ntc-card-${n.id}'),
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(n.title, style: theme.textTheme.titleMedium),
                ),
                JalaliDateText(n.date, key: Key('ntc-date-${n.id}')),
              ],
            ),
            const SizedBox(height: PayeshTokens.space1),
            Wrap(
              spacing: PayeshTokens.space2,
              runSpacing: PayeshTokens.space1,
              children: [
                StatusBadge(
                  n.severity.labelFa,
                  key: Key('ntc-sev-${n.id}'),
                  tone: noticeTone(n.severity),
                ),
                if (n.queued)
                  StatusBadge(
                    'در صف ارسال',
                    key: Key('ntc-queued-${n.id}'),
                    tone: PayeshTone.warning,
                    icon: Icons.schedule,
                  ),
              ],
            ),
            const SizedBox(height: PayeshTokens.space2),
            Text(n.body, key: Key('ntc-body-${n.id}')),
            if (c.canWrite) ...[
              const SizedBox(height: PayeshTokens.space2),
              Wrap(
                spacing: PayeshTokens.space2,
                children: [
                  TextButton.icon(
                    key: Key('ntc-edit-${n.id}'),
                    onPressed: c.busy ? null : () => _openEditor(n),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('ویرایش'),
                  ),
                  TextButton.icon(
                    key: Key('ntc-delete-${n.id}'),
                    onPressed: c.busy ? null : () => _confirmDelete(n),
                    style: TextButton.styleFrom(
                      foregroundColor: theme.colorScheme.error,
                    ),
                    icon: const Icon(Icons.delete_outline),
                    label: const Text('حذف'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Publish / edit form (web modal «اطلاعیهٔ جدید / ویرایش اطلاعیه»). Stays open with the typed
/// text when the board refuses; leaving with unsaved text asks first.
class NoticeEditor extends StatefulWidget {
  const NoticeEditor({super.key, required this.controller, this.editing});

  final NoticesController controller;
  final Notice? editing;

  @override
  State<NoticeEditor> createState() => _NoticeEditorState();
}

class _NoticeEditorState extends State<NoticeEditor> {
  late final TextEditingController title = TextEditingController(
    text: widget.editing?.title ?? '',
  );
  late final TextEditingController body = TextEditingController(
    text: widget.editing?.body ?? '',
  );
  late NoticeSeverity severity =
      widget.editing?.severity ?? NoticeSeverity.normal;

  NoticesController get c => widget.controller;

  bool get _dirty =>
      title.text != (widget.editing?.title ?? '') ||
      body.text != (widget.editing?.body ?? '') ||
      severity != (widget.editing?.severity ?? NoticeSeverity.normal);

  @override
  void dispose() {
    title.dispose();
    body.dispose();
    super.dispose();
  }

  Future<void> _leave() async {
    if (!_dirty) {
      Navigator.pop(context);
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تغییرات ذخیره نشده'),
        content: const Text(
          'متن این اطلاعیه ذخیره نشده است. بدون ذخیره خارج می‌شوید؟',
        ),
        actions: [
          TextButton(
            key: const Key('ntc-discard-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('ماندن'),
          ),
          FilledButton(
            key: const Key('ntc-discard-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('خروج بدون ذخیره'),
          ),
        ],
      ),
    );
    if (ok == true && mounted) Navigator.pop(context);
  }

  Future<void> _submit() async {
    final res = await c.submit(
      id: widget.editing?.id,
      title: title.text,
      body: body.text,
      severity: severity,
    );
    if (res != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.editing != null;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _leave();
        },
        child: Scaffold(
          appBar: AppBar(
            leading: IconButton(
              key: const Key('ntc-editor-back'),
              tooltip: 'بازگشت',
              icon: const BackButtonIcon(),
              onPressed: _leave,
            ),
            title: Text(editing ? 'ویرایش اطلاعیه' : 'اطلاعیهٔ جدید'),
          ),
          body: ListView(
            padding: const EdgeInsets.all(PayeshTokens.space4),
            children: [
              if (c.formError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
                  child: Text(
                    c.formError!,
                    key: const Key('ntc-form-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              TextField(
                key: const Key('ntc-title'),
                controller: title,
                enabled: !c.busy,
                decoration: const InputDecoration(
                  labelText: 'عنوان',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: PayeshTokens.space3),
              TextField(
                key: const Key('ntc-body'),
                controller: body,
                enabled: !c.busy,
                minLines: 4,
                maxLines: 12,
                decoration: const InputDecoration(
                  labelText: 'متن',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: PayeshTokens.space3),
              Text('اهمیت', style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: PayeshTokens.space1),
              SegmentedButton<NoticeSeverity>(
                key: const Key('ntc-severity'),
                segments: [
                  for (final s in NoticeSeverity.values)
                    ButtonSegment(
                      value: s,
                      label: Text(s.labelFa, key: Key('ntc-sev-opt-${s.wire}')),
                    ),
                ],
                selected: {severity},
                onSelectionChanged: c.busy
                    ? null
                    : (v) => setState(() => severity = v.first),
              ),
            ],
          ),
          bottomNavigationBar: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(PayeshTokens.space3),
              child: FilledButton.icon(
                key: const Key('ntc-submit'),
                onPressed: c.busy ? null : _submit,
                icon: const Icon(Icons.send_outlined),
                label: Text(editing ? 'ذخیرهٔ تغییرات' : 'انتشار'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Entry on the signed-in home: shown when the build ships the notices wave and the device
/// knows who the user is. Otherwise a short line says where notices live (the old web client)
/// — never a dead button. Every server role reads notices.
class NoticesEntry extends StatelessWidget {
  const NoticesEntry({
    super.key,
    required this.enabled,
    required this.role,
    required this.uid,
    required this.open,
  });

  final bool enabled;
  final String? role;
  final int? uid;
  final VoidCallback open;

  @override
  Widget build(BuildContext context) {
    if (role == null || !NoticeBoard.readers.contains(role)) {
      return const SizedBox.shrink(key: Key('ntc-entry-none'));
    }
    if (!enabled) {
      return const Text(
        'اطلاعیه‌ها فعلاً در نسخهٔ وب نمایش داده می‌شود.',
        key: Key('ntc-entry-legacy'),
      );
    }
    if (uid == null) {
      return const Text(
        'برای دیدن اطلاعیه‌ها یک بار به اینترنت وصل شوید.',
        key: Key('ntc-entry-wait'),
      );
    }
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: FilledButton.tonalIcon(
        key: const Key('ntc-entry'),
        onPressed: open,
        icon: const Icon(Icons.campaign_outlined),
        label: const Text('اطلاعیه‌ها'),
      ),
    );
  }
}

/// Route that owns the page controller for one visit.
class NoticesRoute extends StatefulWidget {
  const NoticesRoute({
    super.key,
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    this.onRetry,
  });

  final NoticeSource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<NoticesRoute> createState() => _NoticesRouteState();
}

class _NoticesRouteState extends State<NoticesRoute> {
  late final NoticesController controller = NoticesController(
    source: widget.source,
    role: widget.role,
    uid: widget.uid,
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => NoticesScreen(
    controller: controller,
    sync: widget.sync,
    onRetry: widget.onRetry,
  );
}
