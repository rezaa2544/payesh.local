// ردیف ۱۷۹: «چه چیزهایی تازه است؟» — پس از هر به‌روزرسانی یک‌بار، در پنل مالک و اپ مدرسه
// (اندروید، ویندوز، ویندوز ۳۲بیتی). متن‌ها از RELEASE_NOTES.json با
// tools/gen-whats-new-179.mjs در whats_new_data.dart ساخته می‌شوند (همان متن پنل وب).
//
// نسخهٔ «دیده‌شده» روی همین دستگاه نگه داشته می‌شود؛ اگر کاربر چند نسخه را جا انداخته باشد،
// تغییرات همهٔ آن‌ها (حداکثر ۵ نسخه) با هم نشان داده می‌شود. «همهٔ تغییرات نسخه‌ها» تاریخچه است.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'whats_new_data.dart';

/// برای کدام پنل.
enum NoteAudience { owner, school, web }

const _allAudiences = {
  NoteAudience.owner,
  NoteAudience.school,
  NoteAudience.web,
};

final class NoteItem {
  const NoteItem(this.text, [this.audience = _allAudiences]);
  final String text;
  final Set<NoteAudience> audience;
}

final class ReleaseNote {
  const ReleaseNote(this.version, this.items);

  /// نسخهٔ انتشار (همان نسخهٔ بستهٔ سرور، مثل 0.9.35).
  final String version;
  final List<NoteItem> items;

  /// فقط خط‌های همین پنل؛ نسخهٔ بدون خط ⇒ null.
  ReleaseNote? only(NoteAudience a) {
    final it = items.where((n) => n.audience.contains(a)).toList();
    return it.isEmpty ? null : ReleaseNote(version, it);
  }
}

int compareVersions(String a, String b) {
  List<int> p(String s) =>
      s.split('.').map((x) => int.tryParse(x) ?? 0).toList()
        ..addAll(const [0, 0, 0]);
  final pa = p(a), pb = p(b);
  for (var i = 0; i < 3; i++) {
    final d = pa[i] - pb[i];
    if (d != 0) return d;
  }
  return 0;
}

/// یادداشت‌های [audience]، تازه‌ترین اول.
List<ReleaseNote> releaseNotesFor(
  NoteAudience audience, {
  List<ReleaseNote> all = kReleaseNotes,
}) => [for (final r in all) ?r.only(audience)];

/// نسخهٔ انتشاری که این برنامه با آن ساخته شده (تازه‌ترین یادداشت).
String? get bundledRelease =>
    kReleaseNotes.isEmpty ? null : kReleaseNotes.first.version;

/// آنچه باید نشان داده شود: نسخه‌های بعد از [seen] (حداکثر ۵). نخستین اجرا با این قابلیت
/// (هیچ «دیده‌شده»‌ای) ⇒ فقط تازه‌ترین نسخه.
List<ReleaseNote> pendingReleaseNotes(
  NoteAudience audience,
  String? seen, {
  List<ReleaseNote> all = kReleaseNotes,
}) {
  final list = releaseNotesFor(audience, all: all);
  if (list.isEmpty) return const [];
  if (seen == null || seen.isEmpty) return [list.first];
  return list
      .where((r) => compareVersions(r.version, seen) > 0)
      .take(5)
      .toList();
}

/// جای نگه‌داری نسخهٔ دیده‌شده (مثلاً SecureStore). کلید: `whatsnew.seen`.
final class WhatsNewStore {
  const WhatsNewStore({required this.read, required this.write});
  final Future<String?> Function(String key) read;
  final Future<void> Function(String key, String value) write;
  static const key = 'whatsnew.seen';
}

/// پس از نخستین فریم، اگر یادداشت دیده‌نشده‌ای هست، پنجره را یک‌بار نشان می‌دهد.
class WhatsNewGate extends StatefulWidget {
  const WhatsNewGate({
    super.key,
    required this.store,
    required this.audience,
    required this.child,
    this.appVersion,
    this.notes = kReleaseNotes,
    this.delay = const Duration(milliseconds: 600),
  });

  final WhatsNewStore? store;
  final NoteAudience audience;
  final Widget child;

  /// نسخهٔ خود برنامه (مثل 1.1.205) برای سرخط پنجره.
  final String? appVersion;
  final List<ReleaseNote> notes;
  final Duration delay;

  @override
  State<WhatsNewGate> createState() => _WhatsNewGateState();
}

class _WhatsNewGateState extends State<WhatsNewGate> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    if (widget.store != null && widget.notes.isNotEmpty) {
      _timer = Timer(widget.delay, () => unawaited(_check()));
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _check() async {
    final store = widget.store!;
    String? seen;
    try {
      seen = await store.read(WhatsNewStore.key);
    } on Object {
      seen = null;
    }
    final latest = widget.notes.first.version;
    final pending = pendingReleaseNotes(
      widget.audience,
      seen,
      all: widget.notes,
    );
    // پیش از نمایش ذخیره می‌شود: بسته شدن ناگهانی برنامه پنجره را تکراری نمی‌کند.
    if (seen != latest) {
      try {
        await store.write(WhatsNewStore.key, latest);
      } on Object {
        // نگه‌داری ناموفق ⇒ دفعهٔ بعد دوباره نشان داده می‌شود؛ بی‌خطر.
      }
    }
    if (pending.isEmpty || !mounted) return;
    await showWhatsNewDialog(
      context,
      pending,
      audience: widget.audience,
      appVersion: widget.appVersion,
      all: widget.notes,
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// پنجرهٔ «چه چیزهایی تازه است؟» — ردیف ۱۸۰: درست مثل طرح ۲ «مینیمال حرفه‌ای»: گوشهٔ ۱۴،
/// نشان ۴۰ بنفش‌کم‌رنگ در ابتدای سطر، «به‌روزرسانی شد · نسخهٔ …»، عنوان ۱۷، هر خط با جعبهٔ
/// آیکون خط‌دار و «عنوان» پررنگ + توضیح کم‌رنگ، دکمهٔ مشکی «فهمیدم» و پیوند بنفش تاریخچه.
Future<void> showWhatsNewDialog(
  BuildContext context,
  List<ReleaseNote> notes, {
  required NoteAudience audience,
  String? appVersion,
  List<ReleaseNote> all = kReleaseNotes,
}) => showDialog<void>(
  context: context,
  builder: (ctx) {
    final tk = ctx.tokens;
    return Dialog(
      key: const Key('whats-new-dialog'),
      backgroundColor: tk.card,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: tk.line),
      ),
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 32),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440, maxHeight: 620),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Align(
                alignment: AlignmentDirectional.centerStart,
                child: _Badge(),
              ),
              const SizedBox(height: 14),
              Text(
                'به‌روزرسانی شد · نسخهٔ ${appVersion ?? notes.first.version}',
                style: TextStyle(fontSize: 12, color: tk.muted),
              ),
              const SizedBox(height: 2),
              Text(
                'چه چیزهایی تازه است؟',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: tk.ink,
                ),
              ),
              const SizedBox(height: 14),
              Flexible(
                child: SingleChildScrollView(
                  child: _NotesList(
                    notes: notes,
                    showVersion: notes.length > 1,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                height: 44,
                child: FilledButton(
                  key: const Key('whats-new-ok'),
                  onPressed: () => Navigator.of(ctx).pop(),
                  style: FilledButton.styleFrom(
                    backgroundColor: tk.isMinimal ? tk.primary : null,
                    foregroundColor: tk.isMinimal ? tk.onPrimary : null,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  child: const Text('فهمیدم'),
                ),
              ),
              TextButton(
                key: const Key('whats-new-all'),
                onPressed: () {
                  Navigator.of(ctx).pop();
                  unawaited(showReleaseHistory(context, audience, all: all));
                },
                style: TextButton.styleFrom(
                  foregroundColor: tk.isMinimal ? tk.link : null,
                ),
                child: const Text('همهٔ تغییرات نسخه‌ها'),
              ),
            ],
          ),
        ),
      ),
    );
  },
);

/// صفحهٔ «همهٔ تغییرات نسخه‌ها».
Future<void> showReleaseHistory(
  BuildContext context,
  NoteAudience audience, {
  List<ReleaseNote> all = kReleaseNotes,
}) => openPanel<void>(
  context,
  (_) => ReleaseHistoryPage(audience: audience, notes: all),
);

class ReleaseHistoryPage extends StatelessWidget {
  const ReleaseHistoryPage({
    super.key,
    required this.audience,
    this.notes = kReleaseNotes,
  });
  final NoteAudience audience;
  final List<ReleaseNote> notes;

  @override
  Widget build(BuildContext context) {
    final list = releaseNotesFor(audience, all: notes);
    return Scaffold(
      key: const Key('release-history'),
      appBar: AppBar(title: const Text('همهٔ تغییرات نسخه‌ها')),
      body: list.isEmpty
          ? const Center(child: Text('یادداشتی ثبت نشده است.'))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                Align(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 720),
                    child: _NotesList(notes: list, showVersion: true),
                  ),
                ),
              ],
            ),
    );
  }
}

/// دکمهٔ کوچک «تازه‌های نسخه‌ها» برای کارت/صفحهٔ به‌روزرسانی.
class ReleaseHistoryButton extends StatelessWidget {
  const ReleaseHistoryButton({super.key, required this.audience});
  final NoteAudience audience;

  @override
  Widget build(BuildContext context) => TextButton.icon(
    key: const Key('release-history-button'),
    onPressed: () => unawaited(showReleaseHistory(context, audience)),
    icon: const Icon(Icons.auto_awesome_outlined, size: 18),
    label: const Text('همهٔ تغییرات نسخه‌ها'),
  );
}

/// web `wnParts`: «عنوان — توضیح» / «عنوان: توضیح» / «عنوان؛ توضیح».
(String, String) noteParts(String text) {
  for (final sep in const [' — ', ': ', '؛ ']) {
    final i = text.indexOf(sep);
    if (i > 0 && i < 60) {
      return (
        text.substring(0, i).trim(),
        text.substring(i + sep.length).trim(),
      );
    }
  }
  return (text, '');
}

/// web `wnKind`: the icon of a line.
IconData noteIcon(String t) {
  bool has(List<String> w) => w.any(t.contains);
  if (has(['رفع', 'خطا', 'درست شد'])) return Icons.check_rounded;
  if (has(['پردازش', 'پردازنده', 'سرور'])) return Icons.memory_rounded;
  if (has(['فوری', 'اعلان', 'لحظه', 'همگام'])) return Icons.bolt_rounded;
  if (has(['طرح', 'ظاهر', 'تاریک', 'روشن', 'رنگ'])) {
    return Icons.dark_mode_outlined;
  }
  if (has(['امنیت', 'رمز', 'ورود'])) return Icons.shield_outlined;
  return Icons.auto_awesome_outlined;
}

class _Badge extends StatelessWidget {
  const _Badge();

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final cs = Theme.of(context).colorScheme;
    // design 2: 40px, radius 10, violet tint (#F1EFFE light) with the violet spark
    final bg = tk.isMinimal
        ? (Theme.of(context).brightness == Brightness.dark
              ? const Color(0xFF221F3A)
              : const Color(0xFFF1EFFE))
        : cs.primaryContainer;
    final fg = tk.isMinimal ? tk.link : cs.onPrimaryContainer;
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Icon(Icons.auto_awesome_outlined, color: fg, size: 20),
    );
  }
}

class _NotesList extends StatelessWidget {
  const _NotesList({required this.notes, required this.showVersion});
  final List<ReleaseNote> notes;
  final bool showVersion;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final r in notes) ...[
          if (showVersion)
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 8),
              child: Text(
                'نسخهٔ ${r.version}',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: tk.muted,
                ),
              ),
            ),
          for (final n in r.items)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      border: Border.all(color: tk.line),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(noteIcon(n.text), size: 15, color: tk.link),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Builder(
                      builder: (context) {
                        final (title, desc) = noteParts(n.text);
                        return Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w700,
                                height: 1.5,
                                color: tk.ink,
                              ),
                            ),
                            if (desc.isNotEmpty)
                              Text(
                                desc,
                                style: TextStyle(
                                  fontSize: 12.5,
                                  height: 1.6,
                                  color: tk.muted,
                                ),
                              ),
                          ],
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
        ],
      ],
    );
  }
}
