import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// A representative screen built only from design-system parts (used by widget + golden tests).
class Showcase extends StatefulWidget {
  const Showcase({super.key});

  @override
  State<Showcase> createState() => _ShowcaseState();
}

class _ShowcaseState extends State<Showcase> {
  int tab = 0;

  @override
  Widget build(BuildContext context) => AdaptiveScaffold(
    title: 'پایش — دبیرستان نمونه',
    selected: tab,
    onSelected: (i) => setState(() => tab = i),
    destinations: const [
      PayeshDestination(
        label: 'خانه',
        icon: Icons.home_outlined,
        selectedIcon: Icons.home,
      ),
      PayeshDestination(label: 'حضور و غیاب', icon: Icons.fact_check_outlined),
      PayeshDestination(label: 'نمره‌ها', icon: Icons.grade_outlined),
      PayeshDestination(label: 'تنظیمات', icon: Icons.settings_outlined),
    ],
    body: ListView(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        Wrap(
          spacing: PayeshTokens.space3,
          runSpacing: PayeshTokens.space3,
          children: const [
            SizedBox(
              width: 300,
              child: StatTile(
                label: 'دانش‌آموزان',
                value: 1234,
                icon: Icons.groups,
                tone: PayeshTone.info,
              ),
            ),
            SizedBox(
              width: 300,
              child: StatTile(
                label: 'حاضر امروز',
                value: 1180,
                icon: Icons.check_circle,
                tone: PayeshTone.success,
              ),
            ),
          ],
        ),
        const SizedBox(height: PayeshTokens.space4),
        PayeshSection(
          title: 'اطلاعیه‌ها',
          trailing: const StatusBadge(
            'همگام',
            tone: PayeshTone.success,
            icon: Icons.cloud_done,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('جلسهٔ اولیا و مربیان پایهٔ دهم، ساعت ۱۰:۳۰'),
              const SizedBox(height: PayeshTokens.space2),
              const Wrap(
                spacing: PayeshTokens.space3,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('تاریخ:'),
                  JalaliDateText('2026-11-10', key: Key('date-long')),
                  JalaliDateText(
                    '2025-03-21',
                    short: true,
                    key: Key('date-short'),
                  ),
                ],
              ),
              const SizedBox(height: PayeshTokens.space3),
              const Wrap(
                spacing: PayeshTokens.space2,
                runSpacing: PayeshTokens.space2,
                children: [
                  StatusBadge('غایب', tone: PayeshTone.danger),
                  StatusBadge('تأخیر', tone: PayeshTone.warning),
                  StatusBadge('عادی'),
                ],
              ),
              const SizedBox(height: PayeshTokens.space3),
              Wrap(
                spacing: PayeshTokens.space2,
                runSpacing: PayeshTokens.space2,
                children: [
                  FilledButton(onPressed: () {}, child: const Text('ثبت')),
                  OutlinedButton(onPressed: () {}, child: const Text('انصراف')),
                ],
              ),
              const SizedBox(height: PayeshTokens.space3),
              const TextField(
                decoration: InputDecoration(labelText: 'جست‌وجوی دانش‌آموز'),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}
