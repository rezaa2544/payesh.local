// Row 180 — the owner overview of design 2 «مینیمال حرفه‌ای», exactly as drawn
// (docs: ~/design/payesh-ui-proposals.html #d2): four KPI cards (مدارس فعال · کاربران مدارس ·
// درآمد ماه · سلامت سرورها), the «مدارس» card with the segmented tabs همه / آزمایشی /
// نیازمند توجه and «مشاهدهٔ همه», and beside it the compact «پردازش کمکی» card.
//
// Everything is computed from the registry the schools page already reads (names, place,
// the host's report: last seen, version, user count, subscription states) — counts and
// status metadata only; no school content.

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../schools/school_registry.dart';

/// One row of the «مدارس» card.
typedef OverviewSchool = ({
  String id,
  String name,
  String place,
  int? users,
  String state,
  String label,
  String? version,
  bool attention,
  bool trial,
});

/// States, in priority order.
abstract final class SchoolState {
  static const String inactive = 'inactive';
  static const String none = 'none';
  static const String offline = 'offline';
  static const String outdated = 'outdated';
  static const String trial = 'trial';
  static const String online = 'online';
}

/// «۲۰ دقیقه» / «۵ ساعت» / «۳ روز».
String agoFa(Duration d) {
  if (d.inMinutes < 60) return '${faNumber(d.inMinutes.clamp(1, 59))} دقیقه';
  if (d.inHours < 48) return '${faNumber(d.inHours)} ساعت';
  return '${faNumber(d.inDays)} روز';
}

int _cmpVersion(String a, String b) {
  List<int> p(String v) => [
    for (final x in v.split(RegExp(r'[.+\-]')).take(3)) int.tryParse(x) ?? 0,
  ];
  final x = p(a), y = p(b);
  for (var i = 0; i < 3; i++) {
    final l = i < x.length ? x[i] : 0, r = i < y.length ? y[i] : 0;
    if (l != r) return l.compareTo(r);
  }
  return 0;
}

/// «۴۸٫۶» — rials to million tomans with one decimal.
String millionTomanFa(int rial) {
  final m = rial / 10 / 1000000;
  final s = m >= 100 ? m.round().toString() : m.toStringAsFixed(1);
  return faDigits(s.endsWith('.0') ? s.substring(0, s.length - 2) : s)
      .replaceAll('.', '٫');
}

/// Everything the overview draws, computed once per registry read.
final class OwnerOverview {
  OwnerOverview._({
    required this.schools,
    required this.activeSchools,
    required this.totalSchools,
    required this.newThisMonth,
    required this.users,
    required this.reporting,
    required this.hostsOnline,
    required this.revenueMonth,
    required this.revenuePrev,
    required this.monthName,
  });

  /// Online = a host report in the last [fresh].
  static const Duration fresh = Duration(minutes: 5);

  final List<OverviewSchool> schools;
  final int activeSchools, totalSchools, newThisMonth, users, reporting;
  final int hostsOnline, revenueMonth, revenuePrev;
  final String monthName;

  factory OwnerOverview.of(SchoolsView v, DateTime now) {
    final today = JalaliDate.fromDateTime(now);
    bool sameMonth(DateTime t, JalaliDate m) {
      final j = JalaliDate.fromDateTime(t.toLocal());
      return j.year == m.year && j.month == m.month;
    }

    final prevMonth = today.month == 1
        ? JalaliDate(today.year - 1, 12, 1)
        : JalaliDate(today.year, today.month - 1, 1);
    // the newest version any host reports = «up to date»
    String? newest;
    for (final a in v.acks.values) {
      final ver = '${a['version'] ?? ''}'.trim();
      if (ver.isEmpty) continue;
      if (newest == null || _cmpVersion(ver, newest) > 0) newest = ver;
    }
    var active = 0, fresh = 0, reporting = 0, users = 0, created = 0;
    final rows = <OverviewSchool>[];
    for (final s in v.schools) {
      final id = '${s['id']}';
      final on = s['active'] != false;
      if (on) active++;
      final c = DateTime.tryParse('${s['created_at'] ?? ''}');
      if (c != null && sameMonth(c, today)) created++;
      final a = v.acks[id];
      final at = a == null ? null : DateTime.tryParse('${a['at'] ?? ''}');
      final silent = at == null ? null : now.difference(at);
      final n = a == null || a['users'] is! Map
          ? null
          : num.tryParse('${(a['users']! as Map)['total'] ?? ''}')?.toInt();
      if (a != null) {
        reporting++;
        users += n ?? 0;
        if (silent != null && silent < OwnerOverview.fresh) fresh++;
      }
      final ver = a == null ? null : '${a['version'] ?? ''}'.trim();
      // trial = trial subscriptions and no paid one; days left = the soonest end
      var trial = false, paid = false;
      int? days;
      final subs = a?['subs'];
      if (subs is List) {
        for (final x in subs) {
          if (x is! Map) continue;
          final st = x['status'];
          if (st == 'trial') {
            trial = true;
            final end = DateTime.tryParse('${x['end'] ?? ''}');
            if (end != null) {
              final d = end.difference(now).inHours / 24;
              final left = d.ceil().clamp(0, 365);
              if (days == null || left < days) days = left;
            }
          } else if (st == 'active') {
            paid = true;
          }
        }
      }
      final isTrial = trial && !paid;
      final String state, label;
      if (!on) {
        (state, label) = (SchoolState.inactive, 'غیرفعال');
      } else if (a == null || at == null) {
        (state, label) = (SchoolState.none, 'هنوز وصل نشده');
      } else if (silent! >= OwnerOverview.fresh) {
        (state, label) = (SchoolState.offline, 'آفلاین · ${agoFa(silent)}');
      } else if (newest != null &&
          ver != null &&
          ver.isNotEmpty &&
          _cmpVersion(ver, newest) < 0) {
        (state, label) = (SchoolState.outdated, 'به‌روزرسانی معوق');
      } else if (isTrial) {
        (state, label) = (
          SchoolState.trial,
          days == null ? 'آزمایشی' : 'آزمایشی · ${faNumber(days)} روز',
        );
      } else {
        (state, label) = (SchoolState.online, 'آنلاین');
      }
      String place() {
        for (final k in const ['county', 'province', 'district']) {
          final t = '${s[k] ?? ''}'.trim();
          if (t.isNotEmpty) return t;
        }
        return '';
      }

      rows.add((
        id: id,
        name: '${s['name'] ?? ''}',
        place: place(),
        users: n,
        state: state,
        label: label,
        version: ver == null || ver.isEmpty ? null : ver,
        attention: const {
          SchoolState.inactive,
          SchoolState.none,
          SchoolState.offline,
          SchoolState.outdated,
        }.contains(state),
        trial: isTrial,
      ));
    }
    var month = 0, prev = 0;
    for (final p in v.payments) {
      if (p['status'] != 'paid' || p['amount'] is! num) continue;
      final t = DateTime.tryParse('${p['paid_at'] ?? p['at'] ?? ''}');
      if (t == null) continue;
      final amt = (p['amount']! as num).round();
      if (sameMonth(t, today)) month += amt;
      if (sameMonth(t, prevMonth)) prev += amt;
    }
    return OwnerOverview._(
      schools: rows,
      activeSchools: active,
      totalSchools: v.schools.length,
      newThisMonth: created,
      users: users,
      reporting: reporting,
      hostsOnline: fresh,
      revenueMonth: month,
      revenuePrev: prev,
      monthName: jalaliMonths[today.month - 1],
    );
  }

  /// The four KPI cards as drawn.
  List<Widget> kpis() {
    final delta = revenuePrev > 0
        ? ((revenueMonth - revenuePrev) * 100 / revenuePrev).round()
        : null;
    final health = reporting == 0 ? null : hostsOnline * 1000 ~/ reporting;
    String pct(int permille) {
      final s = permille % 10 == 0
          ? faNumber(permille ~/ 10)
          : '${faNumber(permille ~/ 10)}٫${faNumber(permille % 10)}';
      return '$s٪';
    }

    return [
      StatTile(
        key: const Key('metric-schools'),
        label: 'مدارس فعال',
        value: activeSchools,
        icon: Icons.school_outlined,
        sub: newThisMonth > 0
            ? '+${faNumber(newThisMonth)} این ماه'
            : 'از ${faNumber(totalSchools)} مدرسه',
        subTone: newThisMonth > 0 ? PayeshTone.success : PayeshTone.neutral,
      ),
      StatTile(
        key: const Key('metric-users'),
        label: 'کاربران مدارس',
        value: users,
        icon: Icons.people_outline,
        sub: reporting == 0
            ? 'هنوز گزارشی نرسیده'
            : 'در ${faNumber(reporting)} مدرسهٔ گزارش‌داده',
      ),
      StatTile(
        key: const Key('metric-revenue'),
        label: 'درآمد $monthName',
        value: revenueMonth,
        display: millionTomanFa(revenueMonth),
        icon: Icons.credit_card_outlined,
        sub:
            'میلیون تومان'
            '${delta == null ? '' : ' · ${delta >= 0 ? '+' : '−'}${faNumber(delta.abs())}٪'}',
        subTone: delta != null && delta > 0
            ? PayeshTone.success
            : PayeshTone.neutral,
      ),
      StatTile(
        key: const Key('metric-health'),
        label: 'سلامت سرورها',
        value: hostsOnline,
        display: health == null ? '—' : pct(health),
        icon: Icons.dns_outlined,
        sub: reporting == 0
            ? 'سروری گزارش نداده'
            : '${faNumber(hostsOnline)} از ${faNumber(reporting)} سرور وصل',
        subTone: PayeshTone.neutral,
      ),
    ];
  }
}

/// The «مدارس» card: segmented tabs, a four-column table, «مشاهدهٔ همه».
class SchoolsOverviewCard extends StatefulWidget {
  const SchoolsOverviewCard({
    super.key = const Key('dash-schools'),
    required this.overview,
    this.onOpenAll,
    this.max = 5,
  });
  final OwnerOverview overview;
  final VoidCallback? onOpenAll;
  final int max;

  @override
  State<SchoolsOverviewCard> createState() => _SchoolsOverviewCardState();
}

class _SchoolsOverviewCardState extends State<SchoolsOverviewCard> {
  String _tab = 'all';

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final all = widget.overview.schools;
    final shown = [
      for (final s in all)
        if (_tab == 'all' ||
            (_tab == 'trial' && s.trial) ||
            (_tab == 'attention' && s.attention))
          s,
    ];
    Widget tab(String id, String label) {
      final on = _tab == id;
      return Semantics(
        selected: on,
        button: true,
        child: InkWell(
          key: Key('dash-schools-tab-$id'),
          borderRadius: BorderRadius.circular(6),
          onTap: () => setState(() => _tab = id),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: on ? tk.card : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: on ? tk.line : Colors.transparent),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: on ? FontWeight.w600 : FontWeight.w400,
                color: on ? tk.ink : tk.muted,
              ),
            ),
          ),
        ),
      );
    }

    final head = TextStyle(fontSize: 12, color: tk.muted);
    Widget pill(OverviewSchool s) {
      final dot = switch (s.state) {
        SchoolState.online => tk.success,
        SchoolState.trial => tk.link,
        SchoolState.outdated => tk.warning,
        SchoolState.offline || SchoolState.inactive => tk.danger,
        _ => tk.muted,
      };
      return Container(
        key: Key('dash-school-state-${s.id}'),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: tk.line),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                s.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: tk.ink,
                ),
              ),
            ),
          ],
        ),
      );
    }

    Widget row(OverviewSchool s, bool last) => Container(
      key: Key('dash-school-${s.id}'),
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: last ? null : Border(bottom: BorderSide(color: tk.line)),
      ),
      child: Row(
        children: [
          Expanded(
            flex: 9,
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: tk.soft,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    s.name.trim().isEmpty
                        ? '؟'
                        : s.name.trim().characters.first,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: tk.ink2,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: tk.ink,
                        ),
                      ),
                      if (s.place.isNotEmpty)
                        Text(
                          s.place,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, color: tk.muted),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            flex: 3,
            child: Text(
              s.users == null ? '—' : faNumber(s.users!),
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: tk.ink,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          Expanded(
            flex: 6,
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: pill(s),
            ),
          ),
          Expanded(
            flex: 3,
            child: Text(
              s.version == null ? '—' : faDigits(s.version!),
              textDirection: TextDirection.ltr,
              textAlign: TextAlign.right,
              style: TextStyle(fontSize: 12, color: tk.muted),
            ),
          ),
          SizedBox(
            width: 28,
            child: IconButton(
              tooltip: 'مدارس',
              padding: EdgeInsets.zero,
              iconSize: 16,
              color: tk.muted,
              onPressed: widget.onOpenAll,
              icon: const Icon(Icons.more_vert),
            ),
          ),
        ],
      ),
    );

    final list = shown.take(widget.max).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(
                  'مدارس',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: tk.ink,
                  ),
                ),
                const SizedBox(width: 12),
                Container(
                  padding: const EdgeInsets.all(3),
                  decoration: BoxDecoration(
                    color: tk.soft,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: tk.line),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      tab('all', 'همه'),
                      tab('trial', 'آزمایشی'),
                      tab('attention', 'نیازمند توجه'),
                    ],
                  ),
                ),
                const Spacer(),
                if (widget.onOpenAll != null)
                  TextButton(
                    key: const Key('dash-schools-all'),
                    onPressed: widget.onOpenAll,
                    style: TextButton.styleFrom(
                      foregroundColor: tk.link,
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                    ),
                    // the theme's Vazirmatn stays: style the text, not the button textStyle
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'مشاهدهٔ همه',
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        SizedBox(width: 4),
                        Icon(Icons.chevron_left_rounded, size: 16),
                      ],
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.only(bottom: 8),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: tk.line)),
              ),
              child: Row(
                children: [
                  Expanded(flex: 9, child: Text('مدرسه', style: head)),
                  Expanded(flex: 3, child: Text('کاربر', style: head)),
                  Expanded(flex: 6, child: Text('وضعیت', style: head)),
                  Expanded(flex: 3, child: Text('نسخه', style: head)),
                  const SizedBox(width: 28),
                ],
              ),
            ),
            if (list.isEmpty)
              Padding(
                key: const Key('dash-schools-empty'),
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Text(
                  all.isEmpty
                      ? 'هنوز مدرسه‌ای تعریف نشده است.'
                      : _tab == 'trial'
                      ? 'مدرسه‌ای در دورهٔ آزمایشی نیست.'
                      : 'همهٔ مدارس روبه‌راه‌اند.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12.5, color: tk.muted),
                ),
              )
            else
              for (final (i, s) in list.indexed) row(s, i == list.length - 1),
          ],
        ),
      ),
    );
  }
}
