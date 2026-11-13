import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
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
              [
                'نمونهٔ سرور',
                x['mode'] == 'local'
                    ? const Pill(
                        'سرور مستقل',
                        key: Key('health-local'),
                        tone: PayeshTone.success,
                      )
                    : Code('${x['instance'] ?? '—'}'),
              ],
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
          if (x['database'] is Map) ..._databaseRows(x),
          if (x['database'] is! Map)
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

const _dbState = {
  'synced': ('همگام با دیتابیس', PayeshTone.success),
  'error': ('خطا در اتصال به دیتابیس', PayeshTone.danger),
  'pending': ('در انتظار همگام‌سازی', PayeshTone.warning),
  'not_configured': ('دیتابیس تعریف نشده', PayeshTone.warning),
};

/// سرور مستقل: وضعیت نگه‌داری داده‌های پنل در دیتابیس (صندوقچهٔ آروان).
List<Widget> _databaseRows(Map<String, Object?> x) {
  final d = (x['database']! as Map).cast<String, Object?>();
  final st = _dbState['${d['state']}'] ?? ('${d['state']}', PayeshTone.warning);
  final servers = x['school_servers'];
  return [
    const SizedBox(height: 12),
    OwnerTable(
      key: const Key('health-db'),
      columns: const ['دیتابیس پنل', 'مقدار'],
      rows: [
        [
          'وضعیت',
          Pill(st.$1, key: Key('health-db-${d['state']}'), tone: st.$2),
        ],
        ['صندوقچه', Code('${d['bucket'] ?? '—'}')],
        ['آخرین همگام‌سازی', faDate(d['last_sync_at'])],
        if (d['error'] is String) ['خطا', '${d['error']}'],
        ['سرورهای مدرسهٔ پیرو', servers is num ? faNum(servers) : '—'],
      ],
    ),
    Notice(
      d['state'] == 'not_configured'
          ? 'داده‌های پنل روی همین دستگاه نگه داشته می‌شوند. برای نگه‌داری در آروان و دیدن همین داده‌ها روی دستگاه دیگر، دیتابیس را در «تنظیمات» وصل کنید.'
          : 'همهٔ بخش‌ها روی همین دستگاه کار می‌کنند و هر تغییر به‌صورت رمزشده در همین صندوقچه هم ذخیره می‌شود.',
    ),
  ];
}
