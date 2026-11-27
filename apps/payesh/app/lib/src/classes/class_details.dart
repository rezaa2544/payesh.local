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
    this.below,
  });

  /// Row 204: what follows the figures instead of the names (the student list).
  final Widget? below;

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
        ?below,
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
    this.field = true,
  });

  /// Row 204: a field school has no «کلاس» to mention.
  final bool field;
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
          'ادغام: اگر این $label همان $label دیگری است، همهٔ دانش‌آموزانش '
          '${widget.field ? '' : 'و کلاس‌هایش '}به آن منتقل و این $label حذف می‌شود.',
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
/// Row 204: a field school (رشته‌محور) has no «کلاس»: a branch shows how many پایه it has, a
/// grade how many رشته; the students are a sorted list with their details and filters, not a
/// cloud of names. [onOpen] opens a student (to correct it right there).
Widget lookupDetailCard(
  BuildContext context,
  LookupRow row,
  LookupDetail d, {
  required Future<void> Function(int into, String name) onMerge,
  bool field = true,
  Future<void> Function(int studentId)? onOpen,
}) {
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
    stats: lookupStats(row, d, field: field),
    below: LookupStudents(
      key: const Key('def-students'),
      kind: row.kind,
      detail: d,
      field: field,
      onOpen: onOpen,
      empty: 'دانش‌آموزی با این ${lookupFa[row.kind]} نیست.',
    ),
  );
}

/// Row 204: the figures of a grade/branch. Field school: «پایه» (of a branch) / «رشته» (of a
/// grade) — never «کلاس»; a class school keeps its real classes.
List<(String, String)> lookupStats(
  LookupRow row,
  LookupDetail d, {
  required bool field,
}) => [
  ('دانش‌آموز', Web.fa(d.students.length)),
  if (field)
    (row.kind == 'branch' ? 'پایه' : 'رشته', Web.fa(row.others))
  else
    ('کلاس', Web.fa(d.classes.length)),
  if (row.order > 0) ('ترتیب', Web.fa(row.order)),
  if (d.inactive > 0) ('غیرفعال (در شمار نیست)', Web.fa(d.inactive)),
];

/// Row 204 — the students of a grade/branch (or of «بدون پایه»): filter pills by the other
/// half (a branch → پایه, a grade → رشته; a class school's grade → کلاس) over a table sorted
/// by name with پایه، رشته، کد ملی and شمارهٔ همراه, like the users list.
class LookupStudents extends StatefulWidget {
  const LookupStudents({
    super.key,
    required this.kind,
    required this.detail,
    required this.field,
    this.onOpen,
    this.empty = '',
    this.filters = true,
  });

  /// Row 204: false = no filter pills (a class/room has one grade).
  final bool filters;

  /// The kind of the list's own definition: 'grade' or 'branch'.
  final String kind;
  final LookupDetail detail;
  final bool field;
  final Future<void> Function(int studentId)? onOpen;
  final String empty;

  /// The table shows this many; the filters narrow a longer list.
  static const maxRows = 400;

  @override
  State<LookupStudents> createState() => _LookupStudentsState();
}

class _LookupStudentsState extends State<LookupStudents> {
  String pick = 'all';

  /// What the pills split by: a grade of a field school by رشته, a class school's grade by
  /// its classes, a branch (and «بدون رشته») by پایه.
  String _of(LookupStudent s) => widget.kind == 'grade'
      ? (widget.field ? s.branch : s.className)
      : s.grade;

  String _key(String v) => widget.kind == 'grade' ? groupKey(v) : gradeKey(v);

  @override
  Widget build(BuildContext context) {
    final all = widget.detail.students;
    final by = widget.kind == 'grade'
        ? (widget.field ? 'رشته' : 'کلاس')
        : 'پایه';
    final groups = <String, (String, int)>{};
    for (final s in all) {
      final v = _of(s);
      final k = _key(v);
      final (name, n) = groups[k] ?? (v, 0);
      groups[k] = (name, n + 1);
    }
    final keys = groups.keys.toList()
      ..sort((a, b) {
        if (a.isEmpty != b.isEmpty) return a.isEmpty ? 1 : -1;
        final x = groups[a]!.$1, y = groups[b]!.$1;
        final lx = gradeLevel(x), ly = gradeLevel(y);
        return widget.kind != 'grade' && lx != ly
            ? lx.compareTo(ly)
            : x.compareTo(y);
      });
    if (pick != 'all' && !groups.containsKey(pick)) pick = 'all';
    final rows = [
      for (final s in all)
        if (pick == 'all' || _key(_of(s)) == pick) s,
    ];
    final cols = widget.field
        ? const [
            '',
            'نام و نام خانوادگی',
            'پایه',
            'رشته',
            'کد ملی',
            'شمارهٔ همراه',
          ]
        : const [
            '',
            'نام و نام خانوادگی',
            'پایه',
            'کلاس',
            'کد ملی',
            'شمارهٔ همراه',
          ];
    Widget cell(String t, {Key? key}) =>
        Text(t.isEmpty ? '—' : Web.fa(t), key: key, style: Web.small);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 10),
        const Text(
          'دانش‌آموزان',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 6),
        if (all.isEmpty)
          Text(widget.empty, style: Web.small.copyWith(color: Web.muted))
        else ...[
          if (widget.filters && (groups.length > 1 || keys.first.isEmpty))
            WebPills(
              key: const Key('def-filter'),
              keyPrefix: 'def-filter',
              bottom: 8,
              selected: pick,
              onSelected: (k) => setState(() => pick = k),
              tabs: [
                ('all', 'همه (${Web.fa(all.length)})'),
                for (final k in keys)
                  (
                    k,
                    '${groups[k]!.$1.isEmpty ? 'بدون $by' : groups[k]!.$1} '
                        '(${Web.fa(groups[k]!.$2)})',
                  ),
              ],
            ),
          WebTable(
            key: const Key('def-students-table'),
            minWidth: 640,
            bordered: true,
            head: cols,
            rows: [
              for (final (i, s) in rows.take(LookupStudents.maxRows).indexed)
                [
                  Text(
                    Web.fa(i + 1),
                    style: Web.small.copyWith(color: Web.muted),
                  ),
                  MouseRegion(
                    cursor: widget.onOpen == null
                        ? MouseCursor.defer
                        : SystemMouseCursors.click,
                    child: GestureDetector(
                      key: Key('def-stu-${s.id}'),
                      behavior: HitTestBehavior.opaque,
                      onTap: widget.onOpen == null
                          ? null
                          : () => widget.onOpen!(s.id),
                      child: Text(
                        s.name,
                        style: Web.small.copyWith(
                          fontWeight: FontWeight.w600,
                          color: widget.onOpen == null ? null : Web.primary,
                        ),
                      ),
                    ),
                  ),
                  cell(s.grade),
                  cell(widget.field ? s.branch : s.className),
                  cell(s.nationalId),
                  cell(s.phone),
                ],
            ],
          ),
          if (rows.length > LookupStudents.maxRows)
            Text(
              'و ${Web.fa(rows.length - LookupStudents.maxRows)} نفر دیگر — با دکمه‌های بالا جدا کنید.',
              style: Web.small.copyWith(color: Web.muted),
            ),
        ],
      ],
    );
  }
}

/// Asks before a merge; true = confirmed.
Future<bool> confirmMerge(
  BuildContext context,
  LookupRow row,
  String into, {
  bool field = true,
}) => confirmAction(
  context,
  prefix: 'def-merge',
  title: 'ادغام ${lookupFa[row.kind]}',
  message:
      '«${row.name}» در «$into» ادغام شود؟ همهٔ دانش‌آموزانش${field ? '' : ' و کلاس‌هایش'} '
      'به «$into» منتقل و «${row.name}» حذف می‌شود.',
  confirm: 'ادغام',
);
