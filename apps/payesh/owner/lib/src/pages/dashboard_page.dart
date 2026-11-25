import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../infra/arch_card.dart';
import '../monitor/live_panel.dart';
import '../schools/school_registry.dart';
import 'dashboard_d2.dart';
import '../widgets.dart';
import 'base.dart';

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});
  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends OwnerPageState<DashboardPage> {
  ApiResult? _r;

  /// Row 180 design 2: the registry read behind the KPI cards and the «مدارس» card.
  OwnerOverview? _ov;

  static const _items = [
    ('subscriptions', 'اشتراک‌ها', Icons.credit_card_outlined),
    ('plans', 'پلن‌ها', Icons.layers_outlined),
    ('active_users', 'کاربران فعال پلتفرم', Icons.people_outline),
    ('open_grants', 'مجوزهای باز پشتیبانی', Icons.key_outlined),
  ];

  @override
  Future<void> load() async {
    final reg = scope.schools;
    final now = scope.now();
    final (r, v) = await (
      api.dashboard(),
      reg == null
          ? Future<SchoolsView?>.value()
          : reg.load().then<SchoolsView?>((v) => v, onError: (_) => null),
    ).wait;
    _r = r;
    _ov = v == null || !v.connected ? null : OwnerOverview.of(v, now);
  }

  @override
  Widget build(BuildContext context) {
    final r = _r;
    final router = scope.router;
    // ردیف ۱۵۶: «بار لحظه‌ای» داخل کادر «نبض پلتفرم»؛ تا وقتی کادر نیست (بارگیری، خطا،
    // بدون داده) همان کارت جدا بالای داشبورد می‌ماند.
    Widget? hero;
    Widget content;
    if (loading || r == null) {
      content = const StateBox.loading('در حال دریافت خلاصه…');
    } else if (!r.ok) {
      content = StateBox.error(r.message);
    } else {
      final d = r.object('dashboard') ?? const {};
      int n(String k) => num.tryParse('${d[k] ?? 0}')?.toInt() ?? 0;
      if (_ov == null && _items.every((i) => n(i.$1) == 0)) {
        content = const StateBox.empty('هنوز داده‌ای برای خلاصه وجود ندارد.');
      } else {
        final d2 = context.tokens.isMinimal;
        // ردیف ۱۵۱: کارت قهرمان «نبض» مثل داشبورد پنل کاربران؛ بالای صفحه
        // ردیف ۱۸۰ (طرح ۲): کارت قهرمان نیست — چهار کارت KPI در یک ردیف، بعد بار و پایش زنده
        hero = d2
            ? null
            : NabdHeroCard(
                key: const Key('nabd-hero'),
                title: 'نبض پلتفرم',
                value: n('active_users'),
                caption: 'کاربران فعال پلتفرم',
                details: [
                  'اشتراک‌ها: ${faNumber(n('subscriptions'))}',
                  'پلن‌ها: ${faNumber(n('plans'))}',
                  'مجوزهای باز: ${faNumber(n('open_grants'))}',
                ],
                side: router == null
                    ? null
                    : LoadCard(router: router, embedded: true),
              );
        content = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (d2)
              LayoutBuilder(
                builder: (context, box) {
                  final cols = box.maxWidth >= 900 ? 4 : 2;
                  final w = (box.maxWidth - 12 * (cols - 1)) / cols;
                  final tiles =
                      _ov?.kpis() ??
                      [
                        for (final i in _items)
                          StatTile(
                            key: Key('metric-${i.$1}'),
                            label: i.$2,
                            value: n(i.$1),
                            icon: i.$3,
                          ),
                      ];
                  return Wrap(
                    key: const Key('owner-kpis'),
                    spacing: 12,
                    runSpacing: 12,
                    children: [
                      for (final t in tiles) SizedBox(width: w, child: t),
                    ],
                  );
                },
              )
            else
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
            if (!d2)
              const Notice(
                'داشبورد فقط شمارش و وضعیت فراداده است؛ محتوای مدارس نمایش داده نمی‌شود.',
              ),
          ],
        );
      }
    }
    final monitor = scope.monitor;
    final d2 = context.tokens.isMinimal;
    final ov = _ov;
    final side = scope.dashSide;
    // ردیف ۱۸۰ (طرح ۲، مو به مو): زیر KPIها «مدارس» (راست) و «پردازش کمکی» فشرده (چپ)
    Widget? pair;
    if (d2 && !loading && (ov != null || side != null)) {
      final schools = ov == null
          ? null
          : SchoolsOverviewCard(
              overview: ov,
              onOpenAll: scope.open == null
                  ? null
                  : () => scope.open!('schools'),
            );
      pair = LayoutBuilder(
        builder: (context, box) {
          if (box.maxWidth >= 900 && schools != null && side != null) {
            return IntrinsicHeight(
              key: const Key('dash-pair'),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(flex: 3, child: schools),
                  const SizedBox(width: 16),
                  Expanded(flex: 2, child: side),
                ],
              ),
            );
          }
          return Column(
            key: const Key('dash-pair'),
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ?schools,
              if (schools != null && side != null) const SizedBox(height: 16),
              ?side,
            ],
          );
        },
      );
    }
    return PageList(
      onRefresh: () async {
        await reload();
        await monitor?.probeNow();
      },
      children: [
        // ردیف ۱۸۰ (طرح ۲): کارت‌های KPI اول صفحه
        if (d2) content,
        ?pair,
        // ردیف ۱۵۳: بار لحظه‌ای و مسیر بار (پیش‌نیاز حالت‌های معماری)
        if (hero != null)
          hero
        else if (router != null)
          LoadCard(router: router),
        if (monitor != null)
          LiveInfraPanel(
            monitor: monitor,
            api: api,
            side: pair != null ? null : side,
          ),
        if (!d2) content,
      ],
    );
  }
}
