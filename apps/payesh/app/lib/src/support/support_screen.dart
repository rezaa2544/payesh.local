// پشتیبانی — پیام و گزارش مشکل به مالک پلتفرم (ردیف ۱۵۲ · درخواست مالک ۲۰۲۶‑۱۱‑۱۳).
//
// از پنل هر کاربر (همهٔ نقش‌ها، حتی وقتی اشتراک تمام شده): برنامه ← سرور مدرسه ← دیتابیس
// مالک ← پنل مالک. اگر سرور مدرسه به دیتابیس وصل نباشد پیام روی همان سرور در صف می‌ماند و
// خودکار فرستاده می‌شود؛ پاسخ مالک در همین صفحه دیده می‌شود.
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../login/session_controller.dart';

/// دکمهٔ «پشتیبانی و گزارش مشکل» در صفحهٔ اصلی.
class SupportEntry extends StatelessWidget {
  const SupportEntry({super.key, required this.controller});
  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    if (!controller.supportAvailable) {
      return const SizedBox.shrink(key: Key('support-entry-none'));
    }
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: OutlinedButton.icon(
        key: const Key('support-entry'),
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => SupportScreen(link: controller.supportLink),
          ),
        ),
        icon: const Icon(Icons.support_agent_outlined),
        label: const Text('پشتیبانی و گزارش مشکل'),
      ),
    );
  }
}

PayeshTone _tone(SupportTicket t) => switch (t.status) {
  'answered' => PayeshTone.success,
  'closed' => PayeshTone.neutral,
  _ => PayeshTone.info,
};

String _err(Object e) => e is LanAccessFailure
    ? supportErrorFa(e)
    : 'کار انجام نشد — دوباره امتحان کنید';

/// فهرست گفت‌وگوها + «پیام تازه».
class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key, required this.link});
  final Future<SupportLink?> Function() link;

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  List<SupportTicket> _tickets = const [];
  bool _online = true;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final l = await widget.link();
      if (l == null) {
        _error = 'برای پیام به پشتیبانی به سرور مدرسه وصل شوید.';
      } else {
        final r = await l.api.list(l.server, l.token);
        _tickets = r.tickets;
        _online = r.online;
      }
    } on Object catch (e) {
      _error = _err(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _new() async {
    final created = await showDialog<SupportTicket>(
      context: context,
      builder: (_) => _NewTicketDialog(link: widget.link),
    );
    if (created == null || !mounted) return;
    await _load();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        key: const Key('support-sent'),
        content: Text(
          created.pending
              ? 'پیام ثبت شد و به‌محض وصل شدن سرور مدرسه به دیتابیس برای پشتیبانی فرستاده می‌شود.'
              : 'پیام برای پشتیبانی فرستاده شد (کد ${created.id}).',
        ),
      ),
    );
  }

  Future<void> _open(SupportTicket t) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SupportThreadScreen(ticket: t, link: widget.link),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('پشتیبانی و گزارش مشکل'),
        actions: [
          IconButton(
            key: const Key('support-refresh'),
            tooltip: 'به‌روزرسانی',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('support-new'),
        onPressed: _error != null && _tickets.isEmpty && !_loading
            ? null
            : _new,
        icon: const Icon(Icons.edit_outlined),
        label: const Text('پیام تازه'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          key: const Key('support-list'),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          children: [
            const Text(
              'سؤال، مشکل یا پیشنهادتان را مستقیم برای پشتیبانی پایش بفرستید؛ پاسخ همین‌جا نمایش داده می‌شود.',
              key: Key('support-intro'),
            ),
            const SizedBox(height: 12),
            if (_loading)
              const LinearProgressIndicator(key: Key('support-busy')),
            if (_error case final e?)
              Text(
                e,
                key: const Key('support-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            if (!_loading && _error == null && !_online)
              const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: Text(
                  'سرور مدرسه فعلاً به دیتابیس پایش وصل نیست؛ پیام‌ها روی سرور مدرسه نگه داشته و خودکار فرستاده می‌شوند.',
                  key: Key('support-offline'),
                ),
              ),
            if (!_loading && _error == null && _tickets.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Text(
                  'هنوز پیامی نفرستاده‌اید.',
                  key: Key('support-empty'),
                  textAlign: TextAlign.center,
                ),
              ),
            for (final t in _tickets)
              Card(
                key: Key('support-ticket-${t.id}'),
                child: ListTile(
                  onTap: () => _open(t),
                  leading: Icon(
                    t.answered
                        ? Icons.mark_chat_read_outlined
                        : Icons.chat_bubble_outline,
                  ),
                  title: Text(t.subject),
                  subtitle: Text(
                    '${supportCategoryFa(t.category)} · ${jalaliText(t.updatedAt?.toIso8601String())}'
                    '${t.pending ? ' · در صف ارسال' : ''}',
                  ),
                  trailing: StatusBadge(
                    supportStatusFa(t.status),
                    key: Key('support-status-${t.id}'),
                    tone: _tone(t),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _NewTicketDialog extends StatefulWidget {
  const _NewTicketDialog({required this.link});
  final Future<SupportLink?> Function() link;

  @override
  State<_NewTicketDialog> createState() => _NewTicketDialogState();
}

class _NewTicketDialogState extends State<_NewTicketDialog> {
  final _subject = TextEditingController();
  final _text = TextEditingController();
  String _category = 'bug';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _subject.dispose();
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final subject = _subject.text.trim();
    final text = _text.text.trim();
    if (subject.length < 3) {
      setState(() => _error = 'موضوع را بنویسید (دست‌کم ۳ نویسه)');
      return;
    }
    if (text.length < 2) {
      setState(() => _error = 'متن پیام را بنویسید');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final l = await widget.link();
      if (l == null) throw const LanAccessFailure(LanAccessError.unreachable);
      final r = await l.api.create(
        l.server,
        l.token,
        category: _category,
        subject: subject,
        text: text,
      );
      if (mounted) Navigator.of(context).pop(r.ticket);
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = _err(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      key: const Key('support-dialog'),
      title: const Text('پیام تازه به پشتیبانی'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              key: const Key('support-category'),
              initialValue: _category,
              decoration: const InputDecoration(labelText: 'موضوع کلی'),
              items: [
                for (final (id, fa) in supportCategories)
                  DropdownMenuItem(value: id, child: Text(fa)),
              ],
              onChanged: _busy
                  ? null
                  : (v) => setState(() => _category = v ?? 'other'),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('support-subject'),
              controller: _subject,
              maxLength: 120,
              enabled: !_busy,
              decoration: const InputDecoration(labelText: 'عنوان'),
            ),
            TextField(
              key: const Key('support-text'),
              controller: _text,
              minLines: 3,
              maxLines: 8,
              maxLength: 2000,
              enabled: !_busy,
              decoration: const InputDecoration(
                labelText: 'شرح پیام یا مشکل',
                hintText: 'چه شد؟ کجا؟ چه انتظاری داشتید؟',
              ),
            ),
            if (_error case final e?)
              Text(
                e,
                key: const Key('support-dialog-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: const Text('انصراف'),
        ),
        FilledButton(
          key: const Key('support-submit'),
          onPressed: _busy ? null : _send,
          child: const Text('ارسال'),
        ),
      ],
    );
  }
}

/// یک گفت‌وگو: پیام‌های کاربر و پاسخ‌های مالک + پاسخ تازه / بستن.
class SupportThreadScreen extends StatefulWidget {
  const SupportThreadScreen({
    super.key,
    required this.ticket,
    required this.link,
  });
  final SupportTicket ticket;
  final Future<SupportLink?> Function() link;

  @override
  State<SupportThreadScreen> createState() => _SupportThreadScreenState();
}

class _SupportThreadScreenState extends State<SupportThreadScreen> {
  late SupportTicket _t = widget.ticket;
  final _reply = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _run(Future<SupportTicket> Function(SupportLink l) f) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final l = await widget.link();
      if (l == null) throw const LanAccessFailure(LanAccessError.unreachable);
      final t = await f(l);
      if (!mounted) return;
      setState(() {
        _t = t;
        _busy = false;
      });
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = _err(e);
        });
      }
    }
  }

  Future<void> _send() async {
    final text = _reply.text.trim();
    if (text.length < 2) {
      setState(() => _error = 'متن پیام را بنویسید');
      return;
    }
    await _run((l) async {
      final r = await l.api.message(l.server, l.token, _t.id, text);
      _reply.clear();
      return r.ticket;
    });
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return Scaffold(
      appBar: AppBar(
        title: Text(_t.subject),
        actions: [
          if (!_t.closed)
            TextButton(
              key: const Key('support-close'),
              onPressed: _busy
                  ? null
                  : () => _run((l) => l.api.close(l.server, l.token, _t.id)),
              child: const Text('بستن گفت‌وگو'),
            ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Row(
              children: [
                StatusBadge(
                  supportStatusFa(_t.status),
                  key: const Key('support-thread-status'),
                  tone: _tone(_t),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${supportCategoryFa(_t.category)} · کد ${_t.id}',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              key: const Key('support-thread'),
              padding: const EdgeInsets.all(16),
              children: [
                for (final (i, m) in _t.messages.indexed)
                  Align(
                    key: Key('support-msg-$i'),
                    alignment: m.fromOwner
                        ? AlignmentDirectional.centerEnd
                        : AlignmentDirectional.centerStart,
                    child: Container(
                      constraints: const BoxConstraints(maxWidth: 520),
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: m.fromOwner ? tk.soft : tk.card,
                        border: Border.all(color: tk.line),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            m.fromOwner ? 'پشتیبانی پایش' : 'شما',
                            style: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: m.fromOwner ? tk.primary : tk.muted,
                            ),
                          ),
                          const SizedBox(height: 4),
                          SelectableText(m.text),
                          const SizedBox(height: 4),
                          Text(
                            jalaliText(m.at?.toIso8601String()),
                            style: TextStyle(fontSize: 11, color: tk.muted),
                          ),
                        ],
                      ),
                    ),
                  ),
                if (_t.pending)
                  const Text(
                    'در صف ارسال: سرور مدرسه خودکار برای پشتیبانی می‌فرستد.',
                    key: Key('support-thread-pending'),
                  ),
              ],
            ),
          ),
          if (_error case final e?)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                e,
                key: const Key('support-thread-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('support-reply-text'),
                      controller: _reply,
                      enabled: !_busy,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 2000,
                      decoration: InputDecoration(
                        hintText: _t.closed
                            ? 'پیام تازه گفت‌وگو را دوباره باز می‌کند'
                            : 'پیام شما',
                        counterText: '',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    key: const Key('support-send'),
                    tooltip: 'ارسال',
                    onPressed: _busy ? null : _send,
                    icon: const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
