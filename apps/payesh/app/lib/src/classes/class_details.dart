// Row 201 — «کلاس‌ها و تعریف‌ها»: tapping a grade, branch, class/room or subject opens its
// details (students, classes, timetable use) above its own edit fields, so it is corrected
// right there. A branch that duplicates another («تعمیر موتور موتور», «برق صنعتی») offers
// «ادغام» into it; any grade/branch can be merged into another one of its kind.
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';

/// The grey box at the top of a detail form: a line of figures and, below, the names.
class DetailCard extends StatelessWidget {
  const DetailCard({
    super.key,
    required this.stats,
    this.namesTitle = '',
    this.names = const [],
    this.empty = '',
    this.top,
  });

  final List<(String, String)> stats;
  final String namesTitle;
  final List<String> names;
  final String empty;

  /// e.g. the «احتمالاً همان … است» line of a duplicated branch.
  final Widget? top;

  static const maxNames = 120;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Web.line.withValues(alpha: .25),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: Web.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ?top,
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final (label, value) in stats)
              WebBadge('$label: $value', tone: WebTone.none),
          ],
        ),
        if (namesTitle.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(namesTitle, style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          if (names.isEmpty)
            Text(empty, style: Web.small.copyWith(color: Web.muted))
          else
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (final n in names.take(maxNames))
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surface,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: Web.line),
                    ),
                    child: Text(n, style: Web.small),
                  ),
                if (names.length > maxNames)
                  Text(
                    'و ${Web.fa(names.length - maxNames)} نفر دیگر',
                    style: Web.small.copyWith(color: Web.muted),
                  ),
              ],
            ),
        ],
      ],
    ),
  );
}

/// The details are read when the form opens; a failure shows one quiet line.
class DetailLoader<T> extends StatefulWidget {
  const DetailLoader({super.key, required this.read, required this.builder});
  final Future<T?> Function() read;
  final Widget Function(BuildContext context, T data) builder;

  @override
  State<DetailLoader<T>> createState() => _DetailLoaderState<T>();
}

class _DetailLoaderState<T> extends State<DetailLoader<T>> {
  late final Future<T?> _f = widget.read();

  @override
  Widget build(BuildContext context) => FutureBuilder<T?>(
    future: _f,
    builder: (context, s) {
      if (s.connectionState != ConnectionState.done) {
        return const Padding(
          padding: EdgeInsets.all(8),
          child: LinearProgressIndicator(),
        );
      }
      final d = s.data;
      if (s.hasError || d == null) {
        return Text(
          'جزئیات خوانده نشد.',
          style: Web.small.copyWith(color: Web.muted),
        );
      }
      return widget.builder(context, d);
    },
  );
}

/// Row 201: «ادغام در …» of a grade/branch — a menu of the others of its kind + the button.
class LookupMergeRow extends StatefulWidget {
  const LookupMergeRow({
    super.key,
    required this.row,
    required this.others,
    required this.onMerge,
  });
  final LookupRow row;
  final List<LookupRow> others;
  final Future<void> Function(LookupRow into) onMerge;

  @override
  State<LookupMergeRow> createState() => _LookupMergeRowState();
}

class _LookupMergeRowState extends State<LookupMergeRow> {
  int? into;

  @override
  Widget build(BuildContext context) {
    final label = lookupFa[widget.row.kind] ?? 'مورد';
    if (widget.others.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'ادغام: اگر این $label همان $label دیگری است، همهٔ دانش‌آموزان و کلاس‌هایش به آن '
          'منتقل و این $label حذف می‌شود.',
          style: Web.small.copyWith(color: Web.muted),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            FieldBox(
              width: kFieldText,
              child: DropdownButtonFormField<int>(
                key: const Key('def-merge-into'),
                isExpanded: true,
                initialValue: into,
                decoration: InputDecoration(
                  labelText: 'ادغام در $label…',
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
                items: [
                  for (final o in widget.others)
                    DropdownMenuItem(value: o.id, child: Text(o.name)),
                ],
                onChanged: (v) => setState(() => into = v),
              ),
            ),
            WebBtn(
              'ادغام',
              key: const Key('def-merge'),
              onPressed: into == null
                  ? null
                  : () => widget.onMerge(
                      widget.others.firstWhere((o) => o.id == into),
                    ),
            ),
          ],
        ),
      ],
    );
  }
}

/// Row 201 — the grey details of a grade/branch, with the «احتمالاً همان …» suggestion.
Widget lookupDetailCard(
  BuildContext context,
  LookupRow row,
  LookupDetail d, {
  required Future<void> Function(int into, String name) onMerge,
}) {
  final other = row.kind == 'grade' ? 'رشته' : 'پایه';
  return DetailCard(
    key: const Key('def-detail'),
    top: d.likeId == null
        ? null
        : Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Container(
              key: const Key('def-like'),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFFFF7E0),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFFF2C94C)),
              ),
              child: Wrap(
                spacing: 8,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    '❓ احتمالاً همان «${d.like}» است (${lookupLikeFa[d.why]}).',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  WebBtn(
                    'ادغام در «${d.like}»',
                    key: const Key('def-like-merge'),
                    kind: WebBtnKind.primary,
                    onPressed: () => onMerge(d.likeId!, d.like),
                  ),
                ],
              ),
            ),
          ),
    stats: [
      ('دانش‌آموز', Web.fa(d.students.length)),
      ('کلاس', Web.fa(d.classes.length)),
      if (row.order > 0) ('ترتیب', Web.fa(row.order)),
    ],
    namesTitle: 'دانش‌آموزان',
    empty: 'دانش‌آموزی با این ${lookupFa[row.kind]} نیست.',
    names: [
      for (final (_, n, o) in d.students) o.isEmpty ? n : '$n · $other $o',
    ],
  );
}

/// Asks before a merge; true = confirmed.
Future<bool> confirmMerge(
  BuildContext context,
  LookupRow row,
  String into,
) => confirmAction(
  context,
  prefix: 'def-merge',
  title: 'ادغام ${lookupFa[row.kind]}',
  message:
      '«${row.name}» در «$into» ادغام شود؟ همهٔ دانش‌آموزان و کلاس‌هایش به «$into» منتقل '
      'و «${row.name}» حذف می‌شود.',
  confirm: 'ادغام',
);
