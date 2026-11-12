import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'base.dart';

class LimitsPage extends StatefulWidget {
  const LimitsPage({super.key});
  @override
  State<LimitsPage> createState() => _LimitsPageState();
}

class _LimitsPageState extends OwnerPageState<LimitsPage> {
  ApiResult? _tenants;
  String? _tid;
  ApiResult? _lim;
  ApiResult? _use;
  bool _detailLoading = false;

  @override
  Future<void> load() async {
    _tenants = await api.tenants();
    final rows = _tenants!.list('tenants');
    if (_tenants!.ok && rows.isNotEmpty) {
      _tid ??= '${rows.first['tenant_id']}';
      await _loadOne(_tid!);
    }
  }

  Future<void> _loadOne(String tid) async {
    if (mounted) setState(() => _detailLoading = true);
    final rs = await Future.wait([api.limits(tid), api.usage(tid)]);
    _lim = rs[0];
    _use = rs[1];
    if (mounted) setState(() => _detailLoading = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = _tenants;
    Widget head;
    Widget? detail;
    if (loading || t == null) {
      head = const StateBox.loading('در حال دریافت مدارس…');
    } else if (!t.ok) {
      head = StateBox.error(t.message);
    } else if (t.list('tenants').isEmpty) {
      head = const StateBox.empty('هنوز مدرسه‌ای ثبت نشده است.');
    } else {
      final rows = t.list('tenants');
      head = DropdownButtonFormField<String>(
        key: const Key('limits-tenant'),
        initialValue: _tid,
        decoration: const InputDecoration(labelText: 'مدرسه'),
        items: [
          for (final r in rows)
            DropdownMenuItem(
              value: '${r['tenant_id']}',
              child: Text(
                '${shortId(r['tenant_id'])} · ${r['plan_code'] ?? ''}',
              ),
            ),
        ],
        onChanged: (v) {
          if (v == null) return;
          setState(() => _tid = v);
          _loadOne(v);
        },
      );
      final l = _lim, u = _use;
      if (_detailLoading || l == null || u == null) {
        detail = const StateBox.loading('در حال دریافت سقف و مصرف…');
      } else if (!l.ok) {
        detail = StateBox.error(l.message);
      } else if (!u.ok) {
        detail = StateBox.error(u.message);
      } else if (l.object('limits') == null && u.object('usage') == null) {
        detail = const StateBox.empty(
          'برای این مدرسه هنوز سقف یا مصرفی ثبت نشده است.',
        );
      } else {
        final lim = l.object('limits') ?? const {};
        final use = u.object('usage') ?? const {};
        final cap = num.tryParse('${lim['storage_bytes'] ?? ''}') ?? 0;
        final used = num.tryParse('${use['storage_bytes'] ?? 0}') ?? 0;
        final pct = cap > 0 ? (100 * used / cap).round() : null;
        detail = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            OwnerTable(
              key: const Key('limits-table'),
              columns: const ['شاخص', 'مصرف', 'سقف'],
              rows: [
                ['کاربران', faNum(use['users_count']), faNum(lim['max_users'])],
                [
                  'هنرجویان',
                  faNum(use['students_count']),
                  faNum(lim['max_students']),
                ],
                [
                  'فضای ذخیره‌سازی',
                  '${faBytes(use['storage_bytes'])}${pct == null ? '' : ' (${faNum(pct)}٪)'}',
                  faBytes(lim['storage_bytes']),
                ],
              ],
            ),
            if (pct != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: LinearProgressIndicator(
                  value: (pct / 100).clamp(0, 1).toDouble(),
                ),
              ),
            Notice(
              'آخرین محاسبهٔ مصرف: ${faDate(use['last_recalc_at'])} — تغییر سقف در این نسخه از برنامه ممکن نیست.',
            ),
          ],
        );
      }
    }
    return PageList(
      onRefresh: reload,
      children: [
        PayeshSection(
          title: 'سقف و مصرف هر مدرسه',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              head,
              if (detail != null) ...[const SizedBox(height: 12), detail],
            ],
          ),
        ),
      ],
    );
  }
}
