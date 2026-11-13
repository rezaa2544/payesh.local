// «پشتیبانی» — پیام‌ها و گزارش مشکل کاربران همهٔ مدارس (ردیف ۱۵۲ · درخواست مالک ۲۰۲۶‑۱۱‑۱۳).
// مالک می‌بیند، پیگیری و بررسی می‌کند: پالایش بر اساس وضعیت/دسته، جست‌وجو، گفت‌وگوی کامل،
// پاسخ، «پاسخ داده شد» / «بسته» / بازگشایی. پاسخ رمزشده در دیتابیس نوشته می‌شود و کاربر آن را
// در پنل خودش (از راه سرور مدرسه) می‌بیند.
import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../schools/school_registry.dart';
import '../widgets.dart';

const Map<String, String> supportFilters = {
  'open': 'منتظر پاسخ',
  'answered': 'پاسخ داده شد',
  'closed': 'بسته',
  'all': 'همه',
};

PayeshTone _tone(String s) => switch (s) {
  'open' => PayeshTone.warning,
  'answered' => PayeshTone.success,
  _ => PayeshTone.neutral,
};

class SupportPage extends StatelessWidget {
  const SupportPage({super.key});

  @override
  Widget build(BuildContext context) {
    final scope = OwnerScope.of(context);
    final reg = scope.schools;
    if (reg == null) {
      return const Center(
        key: Key('support-none'),
        child: Text('صندوق پشتیبانی هنوز در دسترس نیست.'),
      );
    }
    return SupportInboxView(registry: reg, flash: scope.flash);
  }
}

class SupportInboxView extends StatefulWidget {
  const SupportInboxView({
    super.key,
    required this.registry,
    required this.flash,
  });
  final SchoolRegistry registry;
  final void Function(bool ok, String text) flash;

  @override
  State<SupportInboxView> createState() => _SupportInboxViewState();
}

class _SupportInboxViewState extends State<SupportInboxView> {
  List<SupportThread> _all = const [];
  bool _loading = true;
  String? _error;
  String _filter = 'open';
  String _category = 'all';
  String _query = '';
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _all = await widget.registry.loadSupport();
    } on SchoolsFailure catch (e) {
      _error = e.messageFa;
    } on Object {
      _error = 'خواندن پیام‌ها ممکن نشد.';
    }
    if (mounted) setState(() => _loading = false);
  }

  List<SupportThread> get _shown {
    final q = _query.trim();
    return [
      for (final t in _all)
        if ((_filter == 'all' || t.status == _filter) &&
            (_category == 'all' || t.category == _category) &&
            (q.isEmpty ||
                t.subject.contains(q) ||
                t.school.contains(q) ||
                t.name.contains(q) ||
                t.id.contains(q.toUpperCase()) ||
                t.messages.any((m) => m.text.contains(q))))
          t,
    ];
  }

  Future<void> _open(SupportThread t) async {
    final changed = await showDialog<SupportThread>(
      context: context,
      builder: (_) => _ThreadDialog(thread: t, registry: widget.registry),
    );
    if (changed == null || !mounted) return;
    setState(() {
      _all = [for (final x in _all) x.id == changed.id ? changed : x];
    });
    widget.flash(
      true,
      changed.status == 'closed'
          ? 'گفت‌وگو بسته شد.'
          : 'پاسخ ثبت شد؛ کاربر آن را در پنل خودش می‌بیند.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = supportCounts(_all);
    final shown = _shown;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        key: const Key('support-page'),
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          PayeshSection(
            title: 'پشتیبانی کاربران',
            trailing: IconButton(
              key: const Key('support-refresh'),
              tooltip: 'به‌روزرسانی',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'پیام‌ها و گزارش مشکل کاربران همهٔ مدارس (مدیر، معاون، دبیر، دانش‌آموز، ولی) از راه سرور مدرسه.',
                ),
                const SizedBox(height: PayeshTokens.space3),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    StatTile(
                      key: const Key('support-count-open'),
                      label: 'منتظر پاسخ',
                      value: c.open,
                      tone: c.open > 0
                          ? PayeshTone.warning
                          : PayeshTone.neutral,
                      icon: Icons.mark_chat_unread_outlined,
                    ),
                    StatTile(
                      key: const Key('support-count-answered'),
                      label: 'پاسخ داده شد',
                      value: c.answered,
                      icon: Icons.mark_chat_read_outlined,
                    ),
                    StatTile(
                      key: const Key('support-count-closed'),
                      label: 'بسته',
                      value: c.closed,
                      icon: Icons.task_alt_outlined,
                    ),
                  ],
                ),
                const SizedBox(height: PayeshTokens.space3),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final f in supportFilters.entries)
                      ChoiceChip(
                        key: Key('support-filter-${f.key}'),
                        label: Text(f.value),
                        selected: _filter == f.key,
                        onSelected: (_) => setState(() => _filter = f.key),
                      ),
                  ],
                ),
                const SizedBox(height: PayeshTokens.space2),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        key: const Key('support-search'),
                        controller: _search,
                        decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.search),
                          hintText: 'جست‌وجو: موضوع، مدرسه، نام، کد یا متن',
                        ),
                        onChanged: (v) => setState(() => _query = v),
                      ),
                    ),
                    const SizedBox(width: 8),
                    DropdownButton<String>(
                      key: const Key('support-category'),
                      value: _category,
                      onChanged: (v) => setState(() => _category = v ?? 'all'),
                      items: [
                        const DropdownMenuItem(
                          value: 'all',
                          child: Text('همهٔ دسته‌ها'),
                        ),
                        for (final e in supportCategoryTitles.entries)
                          DropdownMenuItem(value: e.key, child: Text(e.value)),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          if (_loading) const LinearProgressIndicator(key: Key('support-busy')),
          if (_error case final e?)
            Text(
              e,
              key: const Key('support-error'),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          if (!_loading && _error == null && shown.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Text(
                'پیامی با این پالایه نیست.',
                key: Key('support-empty'),
                textAlign: TextAlign.center,
              ),
            ),
          for (final t in shown)
            Card(
              key: Key('support-row-${t.id}'),
              child: ListTile(
                onTap: () => _open(t),
                leading: Icon(
                  t.needsAnswer
                      ? Icons.mark_chat_unread_outlined
                      : Icons.chat_outlined,
                ),
                title: Text(t.subject),
                subtitle: Text(
                  '${t.school.isEmpty ? t.schoolId : t.school} · ${t.name} (${supportRoleTitles[t.role] ?? t.role})\n'
                  '${supportCategoryTitles[t.category]} · ${jalaliText(t.updatedAt)} · ${faNumber(t.messages.length)} پیام',
                ),
                isThreeLine: true,
                trailing: StatusBadge(
                  supportStatusTitles[t.status] ?? t.status,
                  key: Key('support-state-${t.id}'),
                  tone: _tone(t.status),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ThreadDialog extends StatefulWidget {
  const _ThreadDialog({required this.thread, required this.registry});
  final SupportThread thread;
  final SchoolRegistry registry;

  @override
  State<_ThreadDialog> createState() => _ThreadDialogState();
}

class _ThreadDialogState extends State<_ThreadDialog> {
  final _reply = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _save(String status) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final t = await widget.registry.answerSupport(
        widget.thread.id,
        text: _reply.text,
        status: status,
      );
      if (mounted) Navigator.of(context).pop(t);
    } on SchoolsFailure catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.messageFa;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.thread;
    final tk = context.tokens;
    return AlertDialog(
      key: const Key('support-thread'),
      title: Text(t.subject),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '${t.school.isEmpty ? t.schoolId : t.school} · ${t.name} (${supportRoleTitles[t.role] ?? t.role}) · ${supportCategoryTitles[t.category]} · کد ${t.id}',
                key: const Key('support-thread-meta'),
              ),
              const SizedBox(height: 12),
              for (final (i, m) in t.messages.indexed)
                Container(
                  key: Key('support-msg-$i'),
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: m.fromOwner ? tk.soft : tk.card,
                    border: Border.all(color: tk.line),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${m.fromOwner ? 'پاسخ شما' : t.name} · ${jalaliText(m.at)}',
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          color: m.fromOwner ? tk.primary : tk.muted,
                        ),
                      ),
                      const SizedBox(height: 4),
                      SelectableText(m.text),
                    ],
                  ),
                ),
              TextField(
                key: const Key('support-answer'),
                controller: _reply,
                enabled: !_busy,
                minLines: 2,
                maxLines: 6,
                maxLength: 2000,
                decoration: const InputDecoration(labelText: 'پاسخ به کاربر'),
              ),
              if (_error case final e?)
                Text(
                  e,
                  key: const Key('support-answer-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: const Text('بازگشت'),
        ),
        if (t.status == 'closed')
          TextButton(
            key: const Key('support-reopen'),
            onPressed: _busy ? null : () => _save('open'),
            child: const Text('بازگشایی'),
          )
        else
          TextButton(
            key: const Key('support-close'),
            onPressed: _busy ? null : () => _save('closed'),
            child: const Text('بستن'),
          ),
        FilledButton(
          key: const Key('support-send'),
          onPressed: _busy ? null : () => _save('answered'),
          child: const Text('ارسال پاسخ'),
        ),
      ],
    );
  }
}
