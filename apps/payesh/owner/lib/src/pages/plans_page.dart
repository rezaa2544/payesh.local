import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import '../schools/payments_section.dart';
import '../schools/subscription_section.dart';
import 'base.dart';

class PlansPage extends StatefulWidget {
  const PlansPage({super.key});
  @override
  State<PlansPage> createState() => _PlansPageState();
}

class _PlansPageState extends OwnerPageState<PlansPage> {
  ApiResult? _plans;
  ApiResult? _subs;

  @override
  Future<void> load() async {
    final rs = await Future.wait([api.plans(), api.subscriptions()]);
    _plans = rs[0];
    _subs = rs[1];
  }

  Future<void> _createPlan() async {
    final d = await showReasonDialog(
      context,
      title: 'پلن جدید',
      submit: 'ثبت پلن',
      fields: const [
        TextDialogField('code', 'کد پلن (لاتین)', ltr: true),
        TextDialogField('name', 'نام'),
        TextDialogField(
          'mb',
          'فضا (مگابایت)',
          ltr: true,
          numeric: true,
          initial: '1024',
        ),
      ],
      validate: (v) {
        final mb = num.tryParse(normDigits(v.text('mb')));
        return planCodeRe.hasMatch(v.text('code')) &&
                v.text('name').isNotEmpty &&
                mb != null &&
                mb >= 0
            ? null
            : 'کد، نام و فضا را درست وارد کنید.';
      },
    );
    if (d == null) return;
    await mutate(
      api.createPlan(
        code: d.text('code'),
        name: d.text('name'),
        storageMb: num.parse(normDigits(d.text('mb'))),
        reason: d.reason,
      ),
      'پلن ثبت شد.',
    );
  }

  Future<void> _renew(Map<String, Object?> s) async {
    final d = await showReasonDialog(
      context,
      title: 'تمدید اشتراک',
      submit: 'تمدید',
      lines: [
        'اشتراک مدرسهٔ ${shortId(s['tenant_id'])} (پلن ${s['plan_code'] ?? '—'}) تمدید می‌شود.',
      ],
      fields: const [
        TextDialogField(
          'days',
          'تعداد روز',
          ltr: true,
          numeric: true,
          initial: '30',
        ),
      ],
      validate: (v) {
        final n = int.tryParse(normDigits(v.text('days')));
        return n != null && n >= 1 && n <= 366
            ? null
            : 'تعداد روز باید بین ۱ و ۳۶۶ باشد.';
      },
    );
    if (d == null) return;
    await mutate(
      api.renew('${s['id']}', d.reason, int.parse(normDigits(d.text('days')))),
      'اشتراک تمدید شد.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final plans = listBox(
      _plans,
      'plans',
      loadingText: 'در حال دریافت پلن‌ها…',
      emptyText: 'هنوز پلنی تعریف نشده است.',
      build: (rows) => OwnerTable(
        columns: const ['کد', 'نام', 'سقف کاربر', 'سقف هنرجو', 'فضا', 'وضعیت'],
        rows: [
          for (final x in rows)
            [
              Code('${x['code']}'),
              '${x['name'] ?? '—'}',
              capText(x['max_users']),
              capText(x['max_students']),
              x['storage_mb'] == null
                  ? 'نامحدود'
                  : faBytes(
                      (num.tryParse('${x['storage_mb']}') ?? 0) * 1048576,
                    ),
              x['archived_at'] != null
                  ? const Pill('بایگانی', tone: PayeshTone.danger)
                  : const Pill('فعال', tone: PayeshTone.success),
            ],
        ],
      ),
    );
    final subs = listBox(
      _subs,
      'subscriptions',
      loadingText: 'در حال دریافت اشتراک‌ها…',
      emptyText: 'هنوز اشتراکی ثبت نشده است.',
      build: (rows) => OwnerTable(
        columns: const ['مدرسه', 'پلن', 'وضعیت', 'شروع', 'پایان', 'عملیات'],
        rows: [
          for (final x in rows)
            [
              Code(shortId(x['tenant_id']), full: '${x['tenant_id']}'),
              '${x['plan_code'] ?? '—'}',
              Status(x['status']),
              faDate(x['starts_at']),
              faDate(x['ends_at']),
              caps.renew
                  ? actionButton('renew-${x['id']}', 'تمدید', () => _renew(x))
                  : const Pill('فقط مشاهده'),
            ],
        ],
      ),
    );
    final reg = scope.schools;
    return PageList(
      onRefresh: reload,
      children: [
        if (reg != null)
          SubscriptionSection(
            registry: reg,
            flash: scope.flash,
            canManage: caps.renew,
          ),
        if (reg != null) ...[
          const SizedBox(height: PayeshTokens.space3),
          PaymentsSection(
            registry: reg,
            flash: scope.flash,
            canManage: caps.renew,
          ),
          const SizedBox(height: PayeshTokens.space3),
        ],
        PayeshSection(
          title: reg == null ? 'پلن‌ها' : 'پلن‌های فضای ابری پلتفرم',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (caps.createPlan)
                ActionRow([
                  actionButton(
                    'create-plan',
                    'پلن جدید',
                    _createPlan,
                    primary: true,
                  ),
                ]),
              const SizedBox(height: 8),
              plans,
            ],
          ),
        ),
        PayeshSection(
          title: reg == null ? 'اشتراک‌ها' : 'اشتراک‌های فضای ابری پلتفرم',
          child: subs,
        ),
      ],
    );
  }
}
