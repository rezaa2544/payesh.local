import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../monitor/live_panel.dart';
import '../widgets.dart';
import 'base.dart';

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});
  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends OwnerPageState<DashboardPage> {
  ApiResult? _r;

  static const _items = [
    ('subscriptions', 'اشتراک‌ها', Icons.credit_card_outlined),
    ('plans', 'پلن‌ها', Icons.layers_outlined),
    ('active_users', 'کاربران فعال پلتفرم', Icons.people_outline),
    ('open_grants', 'مجوزهای باز پشتیبانی', Icons.key_outlined),
  ];

  @override
  Future<void> load() async => _r = await api.dashboard();

  @override
  Widget build(BuildContext context) {
    final r = _r;
    Widget content;
    if (loading || r == null) {
      content = const StateBox.loading('در حال دریافت خلاصه…');
    } else if (!r.ok) {
      content = StateBox.error(r.message);
    } else {
      final d = r.object('dashboard') ?? const {};
      int n(String k) => num.tryParse('${d[k] ?? 0}')?.toInt() ?? 0;
      if (_items.every((i) => n(i.$1) == 0)) {
        content = const StateBox.empty('هنوز داده‌ای برای خلاصه وجود ندارد.');
      } else {
        content = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final i in _items)
                  SizedBox(
                    width: 260,
                    child: StatTile(
                      key: Key('metric-${i.$1}'),
                      label: i.$2,
                      value: n(i.$1),
                      icon: i.$3,
                    ),
                  ),
              ],
            ),
            const Notice(
              'داشبورد فقط شمارش و وضعیت فراداده است؛ محتوای مدارس نمایش داده نمی‌شود.',
            ),
          ],
        );
      }
    }
    final monitor = scope.monitor;
    return PageList(
      onRefresh: () async {
        await reload();
        await monitor?.probeNow();
      },
      children: [
        if (monitor != null) LiveInfraPanel(monitor: monitor, api: api),
        content,
      ],
    );
  }
}
