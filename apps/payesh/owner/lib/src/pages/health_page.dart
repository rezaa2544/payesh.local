import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../widgets.dart';
import 'base.dart';

class HealthPage extends StatefulWidget {
  const HealthPage({super.key});
  @override
  State<HealthPage> createState() => _HealthPageState();
}

class _HealthPageState extends OwnerPageState<HealthPage> {
  ApiResult? _r;

  @override
  Future<void> load() async => _r = await api.healthSummary();

  @override
  Widget build(BuildContext context) {
    final r = _r;
    Widget content;
    if (loading || r == null) {
      content = const StateBox.loading('در حال بررسی سلامت…');
    } else if (!r.ok) {
      content = StateBox.error(r.message);
    } else {
      final x = r.body!;
      final configured = x['configured'] == true;
      content = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          OwnerTable(
            columns: const ['شاخص', 'مقدار'],
            rows: [
              [
                'پیکربندی',
                Pill(
                  configured ? 'پیکربندی‌شده' : 'پیکربندی‌نشده',
                  key: const Key('health-configured'),
                  tone: configured ? PayeshTone.success : PayeshTone.danger,
                ),
              ],
              ['نمونهٔ سرور', Code('${x['instance'] ?? '—'}')],
              [
                'پیش‌فرض محتوا',
                Pill(
                  x['content_default'] == 'deny'
                      ? 'رد (Default Deny)'
                      : '${x['content_default']}',
                  tone: PayeshTone.success,
                ),
              ],
              [
                'وضعیت امنیت',
                Pill(
                  '${x['security'] ?? 'UNKNOWN'}',
                  key: const Key('health-security'),
                  tone: PayeshTone.warning,
                ),
              ],
            ],
          ),
          const Notice(
            'سلامت جداگانهٔ هر مدرسه (آخرین همگام‌سازی، نسخه، خطاها) هنوز در API وجود ندارد.',
          ),
        ],
      );
    }
    return PageList(
      onRefresh: reload,
      children: [
        PayeshSection(title: 'سلامت API پلتفرم (فقط فراداده)', child: content),
      ],
    );
  }
}
