import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'format.dart';
import 'guard/guard_engine.dart';
import 'infra/load_route.dart';
import 'monitor/live_monitor.dart';
import 'schools/school_registry.dart';

/// Session-wide services for the pages.
class OwnerScope extends InheritedWidget {
  const OwnerScope({
    super.key,
    required this.api,
    required this.flash,
    required this.now,
    required super.child,
    this.monitor,
    this.schools,
    this.router,
    this.guard,
  });

  /// موتور هوشمند (ردیف ۱۵۴)؛ null ⇒ صفحهٔ «نگهبان هوشمند» نیست.
  final GuardEngine? guard;

  /// مسیر بار و بار لحظه‌ای (ردیف ۱۵۳)؛ null ⇒ کارت «بار لحظه‌ای» نشان داده نمی‌شود.
  final LoadRouter? router;

  final OwnerApi api;

  /// فهرست مدارس و اشتراک در صندوقچه (ردیف ۱۴۵)؛ null ⇒ این بخش‌ها نشان داده نمی‌شوند.
  final SchoolRegistry? schools;

  /// پایش زندهٔ زیرساخت (داشبورد)؛ null ⇒ بدون پایش زنده.
  final LiveMonitor? monitor;

  /// Shows a result message (ok = true → success tone).
  final void Function(bool ok, String text) flash;
  final DateTime Function() now;

  OwnerSession get session => api.session!;
  OwnerCaps get caps => api.session?.caps ?? OwnerCaps.none;

  static OwnerScope of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<OwnerScope>()!;

  @override
  bool updateShouldNotify(OwnerScope old) =>
      api != old.api ||
      monitor != old.monitor ||
      schools != old.schools ||
      router != old.router ||
      guard != old.guard;
}

/// Loading / error / empty placeholder (the web `.state`), announced to screen readers.
class StateBox extends StatelessWidget {
  const StateBox.loading(this.text, {super.key}) : kind = 'loading';
  const StateBox.error(this.text, {super.key}) : kind = 'error';
  const StateBox.empty(this.text, {super.key}) : kind = 'empty';

  final String kind;
  final String text;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final color = kind == 'error' ? tk.danger : tk.muted;
    return Semantics(
      liveRegion: true,
      child: Padding(
        key: Key('state-$kind'),
        padding: const EdgeInsets.symmetric(vertical: PayeshTokens.space3),
        child: Row(
          children: [
            if (kind == 'loading')
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              Icon(
                kind == 'error' ? Icons.error_outline : Icons.inbox_outlined,
                color: color,
                size: 20,
              ),
            const SizedBox(width: PayeshTokens.space2),
            Expanded(
              child: Text(text, style: TextStyle(color: color)),
            ),
          ],
        ),
      ),
    );
  }
}

/// Status pill with the web panel's labels.
class Status extends StatelessWidget {
  const Status(this.status, {super.key});
  final Object? status;
  @override
  Widget build(BuildContext context) {
    final (l, t) = statusBadge(status);
    return StatusBadge(l, tone: t);
  }
}

class Pill extends StatelessWidget {
  const Pill(this.label, {super.key, this.tone = PayeshTone.neutral});
  final String label;
  final PayeshTone tone;
  @override
  Widget build(BuildContext context) => StatusBadge(label, tone: tone);
}

/// Monospace, left-to-right short id with the full value as tooltip.
class Code extends StatelessWidget {
  const Code(this.text, {super.key, this.full});
  final String text;
  final String? full;
  @override
  Widget build(BuildContext context) {
    final w = Directionality(
      textDirection: TextDirection.ltr,
      child: SelectableText(
        text,
        style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
      ),
    );
    return full == null || full == text ? w : Tooltip(message: full!, child: w);
  }
}

Widget cellOf(Object? c) => switch (c) {
  final Widget w => w,
  null => const Text('—'),
  _ => Text('$c'),
};

/// Horizontally scrollable table (phone and desktop).
class OwnerTable extends StatelessWidget {
  const OwnerTable({super.key, required this.columns, required this.rows});
  final List<String> columns;
  final List<List<Object?>> rows;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: DataTable(
      headingRowHeight: 40,
      dataRowMinHeight: 44,
      dataRowMaxHeight: double.infinity,
      columns: [for (final c in columns) DataColumn(label: Text(c))],
      rows: [
        for (final r in rows)
          DataRow(
            cells: [
              for (final c in r)
                DataCell(
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: cellOf(c),
                  ),
                ),
            ],
          ),
      ],
    ),
  );
}

class Notice extends StatelessWidget {
  const Notice(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: PayeshTokens.space2),
    child: Text(
      text,
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: context.tokens.muted),
    ),
  );
}

class ActionRow extends StatelessWidget {
  const ActionRow(this.children, {super.key});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) =>
      Wrap(spacing: 8, runSpacing: 8, children: children);
}

Widget actionButton(
  String key,
  String label,
  VoidCallback onPressed, {
  bool primary = false,
  bool danger = false,
}) {
  if (primary || danger) {
    return FilledButton(
      key: Key(key),
      style: danger
          ? FilledButton.styleFrom(backgroundColor: Colors.red.shade700)
          : null,
      onPressed: onPressed,
      child: Text(label),
    );
  }
  return OutlinedButton(
    key: Key(key),
    onPressed: onPressed,
    child: Text(label),
  );
}

/// Page body: a scrollable list of sections with pull-to-refresh.
class PageList extends StatelessWidget {
  const PageList({super.key, required this.children, required this.onRefresh});
  final List<Widget> children;
  final Future<void> Function() onRefresh;
  @override
  Widget build(BuildContext context) => RefreshIndicator(
    onRefresh: onRefresh,
    child: ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        for (final c in children) ...[
          c,
          const SizedBox(height: PayeshTokens.space3),
        ],
      ],
    ),
  );
}

// ── confirm dialog with mandatory reason (the web `confirmDialog`) ─────────────────────

sealed class DialogField {
  const DialogField(this.name, this.label);
  final String name;
  final String label;
}

final class TextDialogField extends DialogField {
  const TextDialogField(
    super.name,
    super.label, {
    this.initial = '',
    this.ltr = false,
    this.numeric = false,
    this.hint,
  });
  final String initial;
  final bool ltr;
  final bool numeric;
  final String? hint;
}

final class SelectDialogField extends DialogField {
  const SelectDialogField(
    super.name,
    super.label,
    this.options, {
    required this.initial,
    this.onChanged,
  });
  final Map<String, String> options;
  final String initial;

  /// Lets one select update another field (e.g. metric → default unit).
  final void Function(String value, void Function(String name, String v) set)?
  onChanged;
}

final class DateTimeDialogField extends DialogField {
  const DateTimeDialogField(super.name, super.label, {required this.initial});
  final DateTime initial;
}

final class DialogResult {
  const DialogResult(this.reason, this.values);
  final String reason;
  final Map<String, Object?> values;
  String text(String n) => (values[n] as String?) ?? '';
  DateTime? time(String n) => values[n] as DateTime?;
}

Future<DialogResult?> showReasonDialog(
  BuildContext context, {
  required String title,
  List<String> lines = const [],
  List<DialogField> fields = const [],
  String submit = 'تأیید',
  bool danger = false,
  String? retype,
  String? Function(DialogResult draft)? validate,
}) => showDialog<DialogResult>(
  context: context,
  builder: (_) => _ReasonDialog(
    title: title,
    lines: lines,
    fields: fields,
    submit: submit,
    danger: danger,
    retype: retype,
    validate: validate,
  ),
);

class _ReasonDialog extends StatefulWidget {
  const _ReasonDialog({
    required this.title,
    required this.lines,
    required this.fields,
    required this.submit,
    required this.danger,
    required this.retype,
    required this.validate,
  });
  final String title;
  final List<String> lines;
  final List<DialogField> fields;
  final String submit;
  final bool danger;
  final String? retype;
  final String? Function(DialogResult draft)? validate;

  @override
  State<_ReasonDialog> createState() => _ReasonDialogState();
}

class _ReasonDialogState extends State<_ReasonDialog> {
  final _reason = TextEditingController();
  final _retype = TextEditingController();
  final _text = <String, TextEditingController>{};
  final _select = <String, String>{};
  final _time = <String, DateTime>{};
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      switch (f) {
        case TextDialogField():
          _text[f.name] = TextEditingController(text: f.initial);
        case SelectDialogField():
          _select[f.name] = f.initial;
        case DateTimeDialogField():
          _time[f.name] = f.initial;
      }
    }
  }

  @override
  void dispose() {
    _reason.dispose();
    _retype.dispose();
    for (final c in _text.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _set(String name, String v) => setState(() {
    if (_text.containsKey(name)) {
      _text[name]!.text = v;
    } else {
      _select[name] = v;
    }
  });

  void _submit() {
    final r = _reason.text.trim();
    if (r.length < 10) {
      setState(() => _error = ownerErrors['reason_too_short']);
      return;
    }
    if (widget.retype != null && _retype.text.trim() != widget.retype) {
      setState(() => _error = 'مقدار تأیید با مقدار خواسته‌شده یکسان نیست.');
      return;
    }
    final values = <String, Object?>{
      for (final e in _text.entries) e.key: e.value.text.trim(),
      ..._select,
      ..._time,
    };
    final draft = DialogResult(r, values);
    final m = widget.validate?.call(draft);
    if (m != null) {
      setState(() => _error = m);
      return;
    }
    Navigator.of(context).pop(draft);
  }

  Future<void> _pick(String name) async {
    final cur = _time[name]!;
    final d = await showDatePicker(
      context: context,
      initialDate: cur,
      firstDate: DateTime(cur.year - 1),
      lastDate: DateTime(cur.year + 2),
    );
    if (d == null || !mounted) return;
    final t = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(cur),
    );
    if (t == null) return;
    setState(
      () => _time[name] = DateTime(d.year, d.month, d.day, t.hour, t.minute),
    );
  }

  Widget _field(DialogField f) => switch (f) {
    TextDialogField() => TextField(
      key: Key('dlg-${f.name}'),
      controller: _text[f.name],
      textDirection: f.ltr ? TextDirection.ltr : null,
      keyboardType: f.numeric ? TextInputType.number : null,
      decoration: InputDecoration(labelText: f.label, hintText: f.hint),
    ),
    SelectDialogField() => DropdownButtonFormField<String>(
      key: Key('dlg-${f.name}'),
      initialValue: _select[f.name],
      decoration: InputDecoration(labelText: f.label),
      items: [
        for (final e in f.options.entries)
          DropdownMenuItem(value: e.key, child: Text(e.value)),
      ],
      onChanged: (v) {
        if (v == null) return;
        setState(() => _select[f.name] = v);
        f.onChanged?.call(v, _set);
      },
    ),
    DateTimeDialogField() => InputDecorator(
      decoration: InputDecoration(labelText: f.label),
      child: InkWell(
        key: Key('dlg-${f.name}'),
        onTap: () => _pick(f.name),
        child: Text(faDate(_time[f.name]!.toIso8601String())),
      ),
    ),
  };

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final l in widget.lines)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(l),
              ),
            for (final f in widget.fields)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _field(f),
              ),
            TextField(
              key: const Key('dlg-reason'),
              controller: _reason,
              minLines: 2,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'دلیل (اجباری، دست‌کم ۱۰ نویسه)',
              ),
            ),
            if (widget.retype != null) ...[
              const SizedBox(height: 8),
              TextField(
                key: const Key('dlg-retype'),
                controller: _retype,
                textDirection: TextDirection.ltr,
                decoration: InputDecoration(
                  labelText:
                      'برای تأیید دوباره، این مقدار را تایپ کنید: ${widget.retype}',
                ),
              ),
            ],
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  key: const Key('dlg-error'),
                  style: TextStyle(color: context.tokens.danger),
                ),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        key: const Key('dlg-cancel'),
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('انصراف'),
      ),
      FilledButton(
        key: const Key('dlg-submit'),
        style: widget.danger
            ? FilledButton.styleFrom(backgroundColor: Colors.red.shade700)
            : null,
        onPressed: _submit,
        child: Text(widget.submit),
      ),
    ],
  );
}
