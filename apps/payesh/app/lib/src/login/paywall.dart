import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'session_controller.dart';

/// Row 145 — صفحهٔ اشتراک (برگردان viewSubscription در p2 src/js/23-subscription.js).
///
/// نقشی که مالک «نیاز به اشتراک» گذاشته، تا پرداخت و تأیید هیچ امکانی ندارد؛ مگر دورهٔ
/// آزمایشی تعریف شده باشد (یک بار برای هر دستگاه، حتی پس از نصب دوباره).

String _money(int rial) => '${faNumber(rial)} ریال';

String _planDesc(SubPlanOffer p, List<SubPlanOffer> all) {
  final m = all.where((x) => x.key == 'monthly').firstOrNull;
  if (p.key == 'monthly' || m == null || m.price <= 0) {
    return 'دسترسی کامل برای ${faDigits(p.months * 30)} روز';
  }
  final save = 100 - (p.price * 100 / (m.price * p.months)).round();
  return save > 0
      ? '${p.key == 'yearly' ? 'به‌صرفه‌ترین گزینه' : 'صرفه‌جویی'} — ${faDigits(save)}٪ نسبت به خرید ماهانه'
      : 'دسترسی کامل برای ${faDigits(p.months * 30)} روز';
}

/// p2: «یک‌ماهه / سه‌ماهه / یک‌ساله».
String _planTitle(String key) => switch (key) {
  'monthly' => 'یک‌ماهه',
  'seasonal' => 'سه‌ماهه',
  'yearly' => 'یک‌ساله',
  'trial' => 'تست رایگان',
  'gift' => 'هدیه',
  _ => key,
};

String _date(DateTime? d) =>
    d == null ? '—' : JalaliDate.fromDateTime(d.toLocal()).formatShort();

/// نوار کوچک وضعیت اشتراک برای کاربری که دسترسی دارد (آزمایشی/فعال).
class SubBanner extends StatelessWidget {
  const SubBanner({super.key, required this.controller, required this.sub});
  final SessionController controller;
  final SubStatus sub;

  @override
  Widget build(BuildContext context) {
    final trial = sub.status == 'trial';
    return Wrap(
      spacing: PayeshTokens.space2,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        StatusBadge(
          trial
              ? '🎁 تست رایگان — ${faDigits(sub.daysLeft)} روز'
              : '✅ اشتراک فعال — تا ${_date(sub.end)}',
          key: const Key('sub-banner'),
          tone: trial || sub.daysLeft <= 7
              ? PayeshTone.warning
              : PayeshTone.success,
        ),
      ],
    );
  }
}

class PaywallView extends StatefulWidget {
  const PaywallView({super.key, required this.controller});
  final SessionController controller;

  @override
  State<PaywallView> createState() => _PaywallViewState();
}

class _PaywallViewState extends State<PaywallView> {
  final _ref = TextEditingController();
  String? _plan;
  String? _lastUrl;

  @override
  void dispose() {
    _ref.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final s = c.sub!;
    final busy = c.subBusy;
    if (s.blockedSchool) {
      return PayeshSection(
        key: const Key('paywall'),
        title: 'دسترسی بسته است',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.status == 'school_inactive'
                  ? 'این مدرسه از سوی پشتیبانی پایش غیرفعال شده است؛ تا فعال شدن دوباره، ورود و کار با برنامه ممکن نیست.'
                  : 'این مدرسه در فهرست مدارس پایش نیست.',
              key: const Key('paywall-school-blocked'),
            ),
            const SizedBox(height: PayeshTokens.space3),
            OutlinedButton(
              key: const Key('paywall-recheck'),
              onPressed: busy ? null : c.checkSub,
              child: const Text('بررسی دوباره'),
            ),
          ],
        ),
      );
    }
    final plans = s.plans;
    _plan ??= plans.isEmpty ? null : plans.first.key;
    final theme = Theme.of(context);
    return Column(
      key: const Key('paywall'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PayeshSection(
          title: 'اشتراک',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              StatusBadge(
                s.status == 'expired'
                    ? 'منقضی — ${_date(s.end)}'
                    : 'بدون اشتراک',
                key: const Key('paywall-status'),
                tone: PayeshTone.danger,
              ),
              const SizedBox(height: PayeshTokens.space2),
              Text(
                s.status == 'expired'
                    ? 'اشتراک شما منقضی شده است. برای ادامهٔ کار یکی از طرح‌های زیر را تهیه کنید.'
                    : 'برای نقش شما اشتراک لازم است؛ تا پرداخت و تأیید آن، امکانات برنامه فعال نمی‌شود.',
                key: const Key('paywall-help'),
              ),
            ],
          ),
        ),
        if (c.subNotice != null)
          Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space3),
            child: Text(
              c.subNotice!,
              key: const Key('paywall-notice'),
              style: TextStyle(color: theme.colorScheme.primary),
            ),
          ),
        if (c.subError != null)
          Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space3),
            child: Semantics(
              liveRegion: true,
              child: Text(
                c.subError!,
                key: const Key('paywall-error'),
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ),
          ),
        if (s.trialAvailable) ...[
          const SizedBox(height: PayeshTokens.space3),
          PayeshSection(
            title: '🎁 تست رایگان',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${faDigits(s.trialDays)} روز استفادهٔ کامل و رایگان — فقط یک بار برای هر دستگاه (حتی با حذف و نصب دوبارهٔ برنامه).',
                  key: const Key('paywall-trial-help'),
                ),
                const SizedBox(height: PayeshTokens.space3),
                FilledButton.tonal(
                  key: const Key('paywall-trial'),
                  onPressed: busy ? null : c.startTrial,
                  child: const Text('شروع دورهٔ آزمایشی'),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'طرح‌ها',
          child: plans.isEmpty
              ? const Text(
                  'هنوز طرحی تعریف نشده است — با پشتیبانی پایش تماس بگیرید.',
                  key: Key('paywall-no-plans'),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final p in plans)
                      Padding(
                        padding: const EdgeInsets.only(
                          bottom: PayeshTokens.space2,
                        ),
                        child: Card(
                          key: Key('plan-${p.key}'),
                          margin: EdgeInsets.zero,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                            side: BorderSide(
                              color: _plan == p.key
                                  ? theme.colorScheme.primary
                                  : theme.dividerColor,
                              width: _plan == p.key ? 2 : 1,
                            ),
                          ),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(12),
                            onTap: busy
                                ? null
                                : () => setState(() => _plan = p.key),
                            child: Padding(
                              padding: const EdgeInsets.all(
                                PayeshTokens.space3,
                              ),
                              child: Row(
                                children: [
                                  Icon(
                                    _plan == p.key
                                        ? Icons.radio_button_checked
                                        : Icons.radio_button_off,
                                    color: theme.colorScheme.primary,
                                  ),
                                  const SizedBox(width: PayeshTokens.space2),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          _planTitle(p.key),
                                          style: theme.textTheme.titleSmall,
                                        ),
                                        Text(
                                          _planDesc(p, plans),
                                          style: theme.textTheme.bodySmall,
                                        ),
                                      ],
                                    ),
                                  ),
                                  Text(
                                    _money(p.price),
                                    style: theme.textTheme.titleSmall,
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    const SizedBox(height: PayeshTokens.space2),
                    if (s.gateway)
                      FilledButton.icon(
                        key: const Key('paywall-pay'),
                        onPressed: busy || _plan == null
                            ? null
                            : () async {
                                final u = await c.payWithGateway(_plan!);
                                if (mounted) setState(() => _lastUrl = u);
                              },
                        icon: const Icon(Icons.credit_card),
                        label: const Text('💳 پرداخت آنلاین'),
                      ),
                    if (_lastUrl != null) ...[
                      const SizedBox(height: PayeshTokens.space2),
                      Row(
                        children: [
                          Expanded(
                            child: SelectableText(
                              _lastUrl!,
                              key: const Key('paywall-pay-url'),
                              textDirection: TextDirection.ltr,
                              maxLines: 2,
                            ),
                          ),
                          IconButton(
                            key: const Key('paywall-copy-url'),
                            tooltip: 'رونوشت پیوند پرداخت',
                            icon: const Icon(Icons.copy),
                            onPressed: () => Clipboard.setData(
                              ClipboardData(text: _lastUrl!),
                            ),
                          ),
                        ],
                      ),
                    ],
                    if (s.receipt) ...[
                      const SizedBox(height: PayeshTokens.space3),
                      Text(
                        s.gateway
                            ? 'یا پس از واریز (کارت‌به‌کارت و…)، شمارهٔ پیگیری را ثبت کنید:'
                            : 'پس از واریز (کارت‌به‌کارت و…)، شمارهٔ پیگیری را ثبت کنید:',
                        style: theme.textTheme.bodySmall,
                      ),
                      if (s.receiptNote.trim().isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(
                            top: PayeshTokens.space2,
                          ),
                          child: SelectableText(
                            s.receiptNote,
                            key: const Key('paywall-receipt-note'),
                          ),
                        ),
                      const SizedBox(height: PayeshTokens.space2),
                      TextField(
                        key: const Key('paywall-ref'),
                        controller: _ref,
                        enabled: !busy,
                        textDirection: TextDirection.ltr,
                        decoration: const InputDecoration(
                          labelText: 'شمارهٔ پیگیری / رسید',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: PayeshTokens.space2),
                      OutlinedButton(
                        key: const Key('paywall-receipt'),
                        onPressed: busy || _plan == null
                            ? null
                            : () async {
                                if (await c.submitReceipt(_plan!, _ref.text)) {
                                  _ref.clear();
                                }
                              },
                        child: const Text('ثبت رسید'),
                      ),
                    ],
                    if (!s.gateway && !s.receipt)
                      const Text(
                        'پرداخت هنوز فعال نشده است — با پشتیبانی پایش تماس بگیرید.',
                        key: Key('paywall-no-method'),
                      ),
                  ],
                ),
        ),
        if (s.pending.isNotEmpty) ...[
          const SizedBox(height: PayeshTokens.space3),
          PayeshSection(
            title: 'پرداخت‌های در انتظار تأیید',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final p in s.pending)
                  Padding(
                    padding: const EdgeInsets.only(bottom: PayeshTokens.space2),
                    child: Text(
                      '${p.id} — ${_planTitle(p.plan)} — ${_money(p.amount)}${p.ref == null ? '' : ' — رسید ${p.ref}'}',
                      key: Key('pending-${p.id}'),
                      textDirection: TextDirection.rtl,
                    ),
                  ),
              ],
            ),
          ),
        ],
        const SizedBox(height: PayeshTokens.space3),
        OutlinedButton(
          key: const Key('paywall-recheck'),
          onPressed: busy ? null : c.checkSub,
          child: const Text('بررسی دوباره'),
        ),
      ],
    );
  }
}
