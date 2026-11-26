import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'paywall.dart';
import 'session_controller.dart';

/// Row 192 — the «اشتراک» page of the school app: always reachable for a user of a school that
/// Payesh manages (menu item, the top-left badge and «تمدید»), not only behind the paywall.
///
/// One place for everything: the current status (plan, end, days left), renewing or buying
/// ([PaywallView]: trial, plans, online payment, receipt), the payment report (every payment with
/// its result — awaiting approval, paid with the period it bought, rejected with the reason,
/// cancelled, failed) and every subscription the user ever had (trial, purchases, gifts).

String _money(int rial) => '${faNumber(rial)} ریال';

String _date(DateTime? d) =>
    d == null ? '—' : JalaliDate.fromDateTime(d.toLocal()).formatShort();

/// «یک‌ماهه / یک‌ساله / تست رایگان / هدیه» (same words as the paywall).
String subPlanTitle(String key) => switch (key) {
  'monthly' => 'یک‌ماهه',
  'seasonal' => 'سه‌ماهه',
  'yearly' => 'یک‌ساله',
  'trial' => 'تست رایگان',
  'gift' => 'هدیه',
  _ => key,
};

/// Whether the «اشتراک» page belongs in this user's menu: a school Payesh manages, and either a
/// role that needs a subscription or the school's manager/deputy (who renews for the year).
bool showsSubscriptionPage(SessionController c) {
  final sub = c.sub;
  if (c.state is! SignedIn || sub == null || !sub.managed) return false;
  if (sub.blockedSchool) return false;
  const leaders = {'manager', 'vice', 'deputy'};
  return sub.status != 'free' || leaders.contains(sub.role);
}

/// Payment result as the user should read it.
(String, PayeshTone) paymentStateFa(SubPayment p) => switch (p.status) {
  'paid' => ('پرداخت‌شده', PayeshTone.success),
  'rejected' => ('رد شد', PayeshTone.danger),
  'cancelled' => ('لغو شد', PayeshTone.neutral),
  'failed' => ('ناموفق', PayeshTone.danger),
  _ =>
    p.method == 'gateway' && !p.awaitingOwner
        ? ('در انتظار نتیجهٔ درگاه', PayeshTone.warning)
        : ('در انتظار تأیید پشتیبانی', PayeshTone.warning),
};

(String, PayeshTone) periodStateFa(SubPeriod p) => switch (p.state) {
  'current' => ('جاری', PayeshTone.success),
  'upcoming' => ('شروع پس از اشتراک فعلی', PayeshTone.info),
  'cancelled' => ('لغو شده', PayeshTone.neutral),
  _ => ('پایان یافته', PayeshTone.neutral),
};

String periodTitleFa(SubPeriod p) => switch (p.kind) {
  'trial' => 'تست رایگان',
  'gift' => 'هدیهٔ پشتیبانی پایش',
  _ => 'خرید ${subPlanTitle(p.plan)}',
};

/// The page body (inside the shell, a panel or a pushed route).
class SubscriptionPage extends StatefulWidget {
  const SubscriptionPage({super.key, required this.controller});
  final SessionController controller;

  @override
  State<SubscriptionPage> createState() => _SubscriptionPageState();
}

class _SubscriptionPageState extends State<SubscriptionPage> {
  @override
  void initState() {
    super.initState();
    // the report is read once when the page opens (and after pay/receipt/«بررسی دوباره»)
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.controller.loadSubHistory();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final s = c.sub;
        if (s == null) {
          return const Padding(
            padding: EdgeInsets.all(PayeshTokens.space4),
            child: Text('وضعیت اشتراک هنوز خوانده نشده است…'),
          );
        }
        final free = s.status == 'free';
        return SingleChildScrollView(
          key: const Key('subscription-page'),
          padding: const EdgeInsets.all(PayeshTokens.space4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SubStatusCard(sub: s),
              if (!free && !s.blockedSchool) ...[
                const SizedBox(height: PayeshTokens.space3),
                PaywallView(controller: c, showStatus: false),
              ],
              const SizedBox(height: PayeshTokens.space3),
              SubHistoryView(controller: c),
            ],
          ),
        );
      },
    );
  }
}

/// «وضعیت اشتراک»: plan, end, days left — or «رایگان» for a role that needs none.
class SubStatusCard extends StatelessWidget {
  const SubStatusCard({super.key, required this.sub});
  final SubStatus sub;

  @override
  Widget build(BuildContext context) {
    final s = sub;
    final tk = context.tokens;
    final free = s.status == 'free';
    final trial = s.status == 'trial' && s.access;
    final (label, tone) = switch (s.status) {
      'free' => ('رایگان — اشتراک لازم نیست', PayeshTone.success),
      _ when trial => (
        'تست رایگان — ${faDigits(s.daysLeft)} روز مانده',
        PayeshTone.warning,
      ),
      _ when s.access => (
        'فعال — ${faDigits(s.daysLeft)} روز مانده',
        s.daysLeft <= 7 || s.renewWarning
            ? PayeshTone.warning
            : PayeshTone.success,
      ),
      'expired' => ('منقضی شده', PayeshTone.danger),
      'cancelled' => ('لغو شده', PayeshTone.danger),
      'school_inactive' => ('مدرسه غیرفعال است', PayeshTone.danger),
      'school_removed' => ('مدرسه در فهرست پایش نیست', PayeshTone.danger),
      _ => ('بدون اشتراک', PayeshTone.danger),
    };
    Widget row(String k, String v, String key) => Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 120,
            child: Text(k, style: TextStyle(color: tk.muted)),
          ),
          Flexible(
            child: Text(
              v,
              key: Key(key),
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
    return PayeshSection(
      key: const Key('sub-status-card'),
      title: 'وضعیت اشتراک',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          StatusBadge(label, key: const Key('sub-state'), tone: tone),
          const SizedBox(height: PayeshTokens.space2),
          if ((s.school ?? '').isNotEmpty)
            row('مدرسه', s.school!, 'sub-school'),
          if (!free && s.plan != null)
            row('طرح فعلی', subPlanTitle(s.plan!), 'sub-plan'),
          if (!free && s.end != null)
            row(
              s.access ? 'اعتبار تا' : 'پایان یافته در',
              _date(s.end),
              'sub-end',
            ),
          if (free)
            Text(
              'مدیریت پایش برای نقش شما اشتراکی تعیین نکرده است؛ همهٔ امکانات رایگان است. سابقهٔ پرداخت‌های پیشین پایین همین صفحه است.',
              key: const Key('sub-free-help'),
              style: TextStyle(color: tk.muted),
            )
          else ...[
            if (s.pending.isNotEmpty)
              row(
                'در انتظار تأیید',
                '${faDigits(s.pending.length)} پرداخت',
                'sub-pending',
              ),
            const SizedBox(height: 4),
            Text(
              s.access
                  ? 'تمدید از همین صفحه: هر طرحی که بخرید از پایان اشتراک فعلی حساب می‌شود و روزهای باقی‌مانده از بین نمی‌رود. همهٔ اشتراک‌ها ۳۱ شهریور (پایان سال تحصیلی) تمام می‌شوند.'
                  : 'برای استفاده از برنامه یکی از طرح‌های زیر را بخرید. همهٔ اشتراک‌ها ۳۱ شهریور (پایان سال تحصیلی) تمام می‌شوند.',
              key: const Key('sub-help'),
              style: TextStyle(color: tk.muted, fontSize: 12.5),
            ),
          ],
        ],
      ),
    );
  }
}

/// «گزارش پرداخت‌ها» + «همهٔ اشتراک‌ها» (also under the paywall).
class SubHistoryView extends StatelessWidget {
  const SubHistoryView({super.key, required this.controller});
  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final h = c.subHistory;
    final tk = context.tokens;
    final note = c.subHistoryLoading
        ? 'در حال دریافت گزارش…'
        : c.subHistoryError != null
        ? (h == null
              ? 'گزارش دریافت نشد: ${c.subHistoryError}'
              : 'به‌روز نشد (${c.subHistoryError}) — آخرین گزارش دریافت‌شده نمایش داده می‌شود.')
        : null;
    Widget status() => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (note != null)
          Flexible(
            child: Text(
              note,
              key: const Key('sub-history-note'),
              style: TextStyle(
                color: c.subHistoryError != null ? tk.danger : tk.muted,
                fontSize: 12.5,
              ),
            ),
          ),
        const SizedBox(width: 8),
        TextButton.icon(
          key: const Key('sub-history-refresh'),
          onPressed: c.subHistoryLoading ? null : c.loadSubHistory,
          icon: const Icon(Icons.refresh, size: 18),
          label: const Text('به‌روزرسانی گزارش'),
        ),
      ],
    );
    final payments = h?.payments ?? const <SubPayment>[];
    final periods = h?.periods ?? const <SubPeriod>[];
    return Column(
      key: const Key('sub-history'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PayeshSection(
          key: const Key('sub-payments'),
          title: 'گزارش پرداخت‌ها',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              status(),
              if (h != null && payments.isEmpty)
                const Text(
                  'هنوز پرداختی ثبت نکرده‌اید.',
                  key: Key('sub-payments-empty'),
                ),
              for (final p in payments) _PaymentTile(p: p),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          key: const Key('sub-periods'),
          title: 'همهٔ اشتراک‌ها',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (h != null && periods.isEmpty)
                const Text(
                  'هنوز اشتراکی نداشته‌اید.',
                  key: Key('sub-periods-empty'),
                ),
              if (h == null && note == null)
                const Text('—', key: Key('sub-periods-wait')),
              for (final p in periods) _PeriodTile(p: p),
            ],
          ),
        ),
      ],
    );
  }
}

class _PaymentTile extends StatelessWidget {
  const _PaymentTile({required this.p});
  final SubPayment p;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final (st, tone) = paymentStateFa(p);
    final small = TextStyle(color: tk.muted, fontSize: 12.5);
    return Container(
      key: Key('sub-pay-${p.id}'),
      margin: const EdgeInsets.only(top: PayeshTokens.space2),
      padding: const EdgeInsets.all(PayeshTokens.space3),
      constraints: const BoxConstraints(maxWidth: 560),
      decoration: BoxDecoration(
        border: Border.all(color: tk.line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                subPlanTitle(p.plan),
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              Text(_money(p.amount)),
              StatusBadge(st, key: Key('sub-pay-state-${p.id}'), tone: tone),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              _date(p.createdAt),
              p.method == 'gateway' ? 'پرداخت آنلاین' : 'رسید واریز',
              if (p.ref != null) 'شمارهٔ رسید ${p.ref}',
              'کد پیگیری ${p.id}',
            ].join(' · '),
            style: small,
          ),
          if (p.status == 'paid' && (p.periodStart ?? p.paidAt) != null)
            Text(
              'اعتبار: ${_date(p.periodStart ?? p.paidAt)} تا ${_date(p.periodEnd)}',
              key: Key('sub-pay-period-${p.id}'),
              style: small,
            ),
          if (p.reason != null)
            Text(
              'دلیل: ${p.reason}',
              key: Key('sub-pay-reason-${p.id}'),
              style: TextStyle(color: tk.danger, fontSize: 12.5),
            ),
        ],
      ),
    );
  }
}

class _PeriodTile extends StatelessWidget {
  const _PeriodTile({required this.p});
  final SubPeriod p;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final (st, tone) = periodStateFa(p);
    return Container(
      key: Key('sub-period-${p.payment ?? '${p.kind}-${p.start}'}'),
      margin: const EdgeInsets.only(top: PayeshTokens.space2),
      padding: const EdgeInsets.symmetric(
        horizontal: PayeshTokens.space3,
        vertical: PayeshTokens.space2,
      ),
      constraints: const BoxConstraints(maxWidth: 560),
      decoration: BoxDecoration(
        border: Border.all(color: tk.line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            periodTitleFa(p),
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          Text('${_date(p.start)} تا ${_date(p.end)}'),
          if (p.amount != null && p.amount! > 0)
            Text(
              _money(p.amount!),
              style: TextStyle(color: tk.muted, fontSize: 12.5),
            ),
          StatusBadge(st, tone: tone),
        ],
      ),
    );
  }
}

/// Opens the «اشتراک» page in a small panel (row 182) — from the badge or «تمدید».
Future<void> openSubscription(BuildContext context, SessionController c) =>
    openPanel<void>(
      context,
      (_) => Scaffold(
        appBar: AppBar(title: const Text('اشتراک')),
        body: SubscriptionPage(controller: c),
      ),
    );
