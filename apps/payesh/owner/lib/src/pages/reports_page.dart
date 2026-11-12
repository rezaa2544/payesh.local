import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../widgets.dart';
import 'base.dart';

class ReportsPage extends StatefulWidget {
  const ReportsPage({super.key});
  @override
  State<ReportsPage> createState() => _ReportsPageState();
}

class _ReportsPageState extends OwnerPageState<ReportsPage> {
  ApiResult? _r;

  @override
  Future<void> load() async => _r = await api.subscriptions();

  @override
  Widget build(BuildContext context) {
    final content = listBox(
      _r,
      'subscriptions',
      loadingText: 'در حال ساخت گزارش…',
      emptyText: 'داده‌ای برای گزارش نیست.',
      build: (subs) {
        final rep = subscriptionReport(subs);
        final st = rep.byStatus.keys.toList()..sort();
        final pl = rep.byPlan.keys.toList()..sort();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'اشتراک‌ها بر اساس وضعیت',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            OwnerTable(
              columns: const ['وضعیت', 'تعداد'],
              rows: [
                for (final k in st) [Status(k), faNum(rep.byStatus[k])],
              ],
            ),
            const SizedBox(height: 12),
            Text(
              'اشتراک‌ها بر اساس پلن',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            OwnerTable(
              columns: const ['پلن', 'تعداد'],
              rows: [
                for (final k in pl) [Code(k), faNum(rep.byPlan[k])],
              ],
            ),
            const Notice(
              'خروجی انبوه محتوای مدارس وجود ندارد و ساخته نمی‌شود.',
            ),
          ],
        );
      },
    );
    return PageList(
      onRefresh: reload,
      children: [
        PayeshSection(title: 'گزارش فراداده (فقط‌خواندنی)', child: content),
      ],
    );
  }
}
