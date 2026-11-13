// ردیف ۱۴۹ — «پیگیری پرداخت‌ها و اشتراک‌ها»: خلاصه، جست‌وجو و پالایش، تأیید/رد پرداخت در
// انتظار، لغو پرداخت تأییدشده، و مشترکان هر مدرسه با هدیه/بازنشانی/لغو اشتراک.
// تصمیم‌ها رمزشده در صندوقچه نوشته می‌شوند و سرور مدرسه تا یک دقیقهٔ بعد اعمال می‌کند و
// وضعیت نهایی را برمی‌گرداند (server/school-registry.js poll).

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../guard/fraud.dart';
import '../widgets.dart';
import 'school_registry.dart';
import 'schools_section.dart';

/// پالایه‌های فهرست پرداخت‌ها.
const Map<String, String> paymentFilters = {
  'all': 'همه',
  'pending': 'در انتظار تأیید',
  'paid': 'پرداخت‌شده',
  'rejected': 'ردشده',
  'cancelled': 'لغوشده',
  'failed': 'ناموفق',
};

String planTitleFa(Object? k) => switch (k) {
  'trial' => 'آزمایشی',
  'gift' => 'هدیه',
  _ => subPlans.where((p) => p.key == k).firstOrNull?.title ?? '${k ?? '—'}',
};

/// وضعیت مؤثر یک پرداخت (تصمیمِ هنوز اعمال‌نشدهٔ مالک هم حساب می‌شود).
String paymentState(Map<String, Object?> p) {
  final d = p['decision'];
  final st = '${p['status'] ?? 'pending'}';
  if (d is Map && d['status'] == 'cancelled' && st != 'cancelled') {
    return 'cancelling';
  }
  if (d is Map && st != 'paid' && st != 'rejected' && st != 'cancelled') {
    return d['status'] == 'approved' ? 'approving' : 'rejecting';
  }
  return st;
}

class PaymentsSection extends StatefulWidget {
  const PaymentsSection({
    super.key,
    required this.registry,
    required this.flash,
    this.canManage = true,
  });
  final SchoolRegistry registry;
  final void Function(bool ok, String text) flash;
  final bool canManage;

  @override
  State<PaymentsSection> createState() => _PaymentsSectionState();
}

class _PaymentsSectionState extends State<PaymentsSection> with RegistryLoader {
  @override
  SchoolRegistry get registry => widget.registry;
  @override
  void Function(bool ok, String text) get flash => widget.flash;

  String _filter = 'all';
  String _query = '';
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _decide(Map<String, Object?> p, String action) async {
    final ok = action == 'approve';
    final cancel = action == 'cancel';
    final d = await showReasonDialog(
      context,
      title: switch (action) {
        'approve' => 'تأیید پرداخت ${p['id']}',
        'cancel' => 'لغو پرداخت ${p['id']}',
        _ => 'رد پرداخت ${p['id']}',
      },
      danger: !ok,
      submit: switch (action) {
        'approve' => 'تأیید',
        'cancel' => 'لغو پرداخت',
        _ => 'رد',
      },
      lines: [
        '${p['name'] ?? ''} (${subRoleTitles[p['role']] ?? p['role']}) — پلن ${planTitleFa(p['plan'])}، مبلغ ${faNum(p['amount'] ?? 0)} ریال',
        if (p['ref'] != null) 'شمارهٔ رسید/مرجع: ${p['ref']}',
        switch (action) {
          'approve' => 'با تأیید، اشتراک فعال می‌شود: ماهانه ۳۱ روز و سالانه تا ۳۱ شهریور (پایان سال تحصیلی).',
          'cancel' => 'اشتراکی که از این پرداخت ساخته شده همین حالا بسته می‌شود؛ بازگرداندن وجه بیرون از برنامه انجام می‌شود.',
          _ => 'دلیل رد به کاربر نمایش داده می‌شود.',
        },
      ],
    );
    if (d == null) return;
    await change(
      () => cancel
          ? registry.cancelPayment('${p['id']}', reason: d.reason)
          : registry.decide('${p['id']}', ok, reason: d.reason),
      switch (action) {
        'approve' =>
          'پرداخت تأیید شد؛ سرور مدرسه تا یک دقیقهٔ دیگر فعال می‌کند.',
        'cancel' =>
          'لغو پرداخت ثبت شد؛ سرور مدرسه تا یک دقیقهٔ دیگر اشتراک را می‌بندد.',
        _ => 'پرداخت رد شد.',
      },
    );
  }

  Future<void> _grant(
    String schoolId,
    Map<String, Object?> sub,
    String kind,
  ) async {
    final gift = kind == 'gift';
    final d = await showReasonDialog(
      context,
      title: switch (kind) {
        'gift' => '🎁 فعال‌سازی اشتراک ${sub['name'] ?? ''}',
        'cancel' => '⛔ لغو اشتراک ${sub['name'] ?? ''}',
        _ => '♻️ بازنشانی اشتراک ${sub['name'] ?? ''}',
      },
      danger: !gift,
      submit: switch (kind) {
        'gift' => 'فعال‌سازی',
        'cancel' => 'لغو اشتراک',
        _ => 'بازنشانی',
      },
      lines: [
        switch (kind) {
          'gift' => 'اشتراک این کاربر به این تعداد روز تمدید می‌شود (حداکثر تا ۳۱ شهریور).',
          'cancel' => 'اشتراک این کاربر همین حالا تمام می‌شود و تا خرید دوباره امکانات بسته است.',
          _ => 'رکورد اشتراک این کاربر پاک می‌شود (p2 «♻️ بازنشانی»). دورهٔ آزمایشیِ مصرف‌شدهٔ دستگاه دوباره باز نمی‌شود.',
        },
      ],
      fields: [
        if (gift)
          const TextDialogField(
            'days',
            'تعداد روز',
            numeric: true,
            initial: '30',
          ),
      ],
      validate: (v) {
        if (!gift) return null;
        final n = int.tryParse(digitsOnly(v.text('days')));
        return n == null || n < 1 || n > 3650
            ? 'تعداد روز باید بین ۱ تا ۳۶۵۰ باشد.'
            : null;
      },
    );
    if (d == null) return;
    await change(
      () => registry.grant(
        schoolId,
        kind,
        days: gift ? int.parse(digitsOnly(d.text('days'))) : 0,
        userId: sub['uid'] is int ? sub['uid']! as int : null,
      ),
      switch (kind) {
        'gift' =>
          'فعال‌سازی ثبت شد؛ سرور مدرسه تا یک دقیقهٔ دیگر اعمال می‌کند.',
        'cancel' =>
          'لغو اشتراک ثبت شد؛ سرور مدرسه تا یک دقیقهٔ دیگر اعمال می‌کند.',
        _ => 'بازنشانی ثبت شد.',
      },
    );
  }

  bool _matches(Map<String, Object?> p, Map<String, String> names) {
    final st = paymentState(p);
    final f = switch (_filter) {
      'all' => true,
      'pending' => st == 'pending',
      'paid' => st == 'paid' || st == 'approving',
      'rejected' => st == 'rejected' || st == 'rejecting',
      'cancelled' => st == 'cancelled' || st == 'cancelling',
      _ => st == _filter,
    };
    if (!f) return false;
    final q = latinDigits(_query.trim()).toLowerCase();
    if (q.isEmpty) return true;
    final hay = [
      p['id'],
      p['name'],
      p['ref'],
      p['gateway_ref'],
      names['${p['school_id']}'],
    ].map((x) => latinDigits('${x ?? ''}').toLowerCase()).join(' ');
    return hay.contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final v = view;
    if (v == null) {
      return const PayeshSection(
        title: 'پرداخت‌ها و اشتراک‌ها',
        child: StateBox.loading('در حال دریافت پرداخت‌ها…'),
      );
    }
    final edit = widget.canManage;
    final names = {for (final x in v.schools) '${x['id']}': '${x['name']}'};
    final pending = v.payments
        .where((p) => paymentState(p) == 'pending')
        .length;
    var active = 0, trial = 0, expired = 0, cancelled = 0, revenue = 0;
    final subs = <(String, Map<String, Object?>)>[];
    for (final e in v.acks.entries) {
      final list = e.value['subs'];
      if (list is! List) continue;
      for (final x in list) {
        if (x is! Map) continue;
        final m = x.cast<String, Object?>();
        subs.add((e.key, m));
        switch (m['status']) {
          case 'trial':
            trial++;
          case 'expired':
            expired++;
          case 'cancelled':
            cancelled++;
          default:
            active++;
        }
      }
    }
    for (final p in v.payments) {
      if (p['status'] == 'paid' && p['amount'] is num) {
        revenue += (p['amount']! as num).round();
      }
    }
    final shown = [
      for (final p in v.payments)
        if (_matches(p, names)) p,
    ];
    final now = DateTime.now();
    // ردیف ۱۵۴: پرداخت‌های مشکوک (همان قاعده‌های موتور هوشمند)
    final suspect = <String, List<String>>{};
    for (final f in suspiciousPayments(v.payments, v.settings, now: now)) {
      for (final id in f.paymentIds) {
        suspect.putIfAbsent(id, () => []).add(f.titleFa);
      }
    }
    return Column(
      key: const Key('payments-section'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!v.connected)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: OfflineNote(v.error ?? 'دیتابیس در دسترس نیست.'),
          ),
        PayeshSection(
          title: 'اشتراک‌ها — خلاصه',
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              Pill('فعال: ${faNum(active)}', tone: PayeshTone.success),
              Pill('آزمایشی: ${faNum(trial)}', tone: PayeshTone.info),
              Pill('منقضی: ${faNum(expired)}', tone: PayeshTone.warning),
              Pill('لغوشده: ${faNum(cancelled)}', tone: PayeshTone.neutral),
              Pill(
                'در انتظار تأیید: ${faNum(pending)}',
                key: const Key('sub-pending-count'),
                tone: pending > 0 ? PayeshTone.warning : PayeshTone.neutral,
              ),
              if (suspect.isNotEmpty)
                Pill(
                  'مشکوک: ${faNum(suspect.length)}',
                  key: const Key('sub-suspect-count'),
                  tone: PayeshTone.danger,
                ),
              Pill(
                'درآمد: ${faNum(revenue)} ریال',
                key: const Key('sub-revenue'),
              ),
              Pill(
                'پایان سال تحصیلی: ${AcademicYear.yearEndLabel(now)}',
                key: const Key('sub-year-end'),
              ),
              if (AcademicYear.inRenewWindow(now))
                const Pill(
                  'پنجرهٔ تمدید باز است (از ۱ تیر)',
                  key: Key('sub-renew-open'),
                  tone: PayeshTone.warning,
                ),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'پرداخت‌ها',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final e in paymentFilters.entries)
                    ChoiceChip(
                      key: Key('pay-filter-${e.key}'),
                      label: Text(e.value),
                      selected: _filter == e.key,
                      onSelected: (_) => setState(() => _filter = e.key),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                key: const Key('pay-search'),
                controller: _search,
                onChanged: (x) => setState(() => _query = x),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'جست‌وجو: کد پیگیری، نام، شمارهٔ رسید، مدرسه',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 8),
              if (shown.isEmpty)
                StateBox.empty(
                  v.payments.isEmpty
                      ? 'هنوز پرداختی ثبت نشده است.'
                      : 'پرداختی با این پالایه پیدا نشد.',
                )
              else
                OwnerTable(
                  columns: const [
                    'کد پیگیری',
                    'زمان',
                    'مدرسه',
                    'کاربر',
                    'پلن / مبلغ',
                    'روش / مرجع',
                    'وضعیت',
                    'عملیات',
                  ],
                  rows: [
                    for (final p in shown)
                      [
                        Code('${p['id']}'),
                        faDate(p['created_at']),
                        names['${p['school_id']}'] ?? '—',
                        '${p['name'] ?? ''} (${subRoleTitles[p['role']] ?? p['role'] ?? ''})',
                        '${planTitleFa(p['plan'])} — ${faNum(p['amount'] ?? 0)} ریال',
                        '${p['method'] == 'gateway' ? 'درگاه' : 'رسید'}${p['ref'] != null ? ' — ${p['ref']}' : ''}${p['gateway_ref'] != null ? ' — ${p['gateway_ref']}' : ''}',
                        if (suspect['${p['id']}'] case final why?)
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              _payStatus(p),
                              const SizedBox(height: 4),
                              Pill(
                                'مشکوک: ${why.toSet().join('، ')}',
                                key: Key('pay-suspect-${p['id']}'),
                                tone: PayeshTone.danger,
                              ),
                            ],
                          )
                        else
                          _payStatus(p),
                        _actions(p, edit),
                      ],
                  ],
                ),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'مشترکان',
          child: subs.isEmpty
              ? const StateBox.empty(
                  'هنوز گزارشی از سرورهای مدرسه نرسیده است (هر دقیقه به‌روز می‌شود).',
                )
              : OwnerTable(
                  columns: const [
                    'مدرسه',
                    'کاربر',
                    'نقش',
                    'وضعیت',
                    'پلن',
                    'پایان',
                    'عملیات',
                  ],
                  rows: [
                    for (final (sid, m) in subs)
                      [
                        names[sid] ?? '—',
                        '${m['name'] ?? '—'}',
                        subRoleTitles[m['role']] ?? '${m['role'] ?? ''}',
                        _subStatus(m['status']),
                        planTitleFa(m['plan']),
                        faDate(m['end']),
                        edit
                            ? ActionRow([
                                actionButton(
                                  'sub-gift-$sid-${m['uid']}',
                                  '🎁 فعال‌سازی',
                                  () => _grant(sid, m, 'gift'),
                                ),
                                if (m['status'] != 'expired' &&
                                    m['status'] != 'cancelled')
                                  actionButton(
                                    'sub-cancel-$sid-${m['uid']}',
                                    '⛔ لغو',
                                    () => _grant(sid, m, 'cancel'),
                                  ),
                                actionButton(
                                  'sub-reset-$sid-${m['uid']}',
                                  '♻️ بازنشانی',
                                  () => _grant(sid, m, 'reset'),
                                ),
                              ])
                            : const Text('—'),
                      ],
                  ],
                ),
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            key: const Key('pay-refresh'),
            onPressed: reloadRegistry,
            child: const Text('بروزرسانی'),
          ),
        ),
      ],
    );
  }

  Widget _actions(Map<String, Object?> p, bool edit) {
    if (!edit) return const Text('—');
    final st = paymentState(p);
    if (st == 'pending' || st == 'failed') {
      return ActionRow([
        actionButton(
          'pay-approve-${p['id']}',
          'تأیید',
          () => _decide(p, 'approve'),
          primary: true,
        ),
        actionButton('pay-reject-${p['id']}', 'رد', () => _decide(p, 'reject')),
      ]);
    }
    if (st == 'paid' || st == 'approving') {
      return ActionRow([
        actionButton(
          'pay-cancel-${p['id']}',
          'لغو',
          () => _decide(p, 'cancel'),
        ),
      ]);
    }
    return const Text('—');
  }

  Widget _payStatus(Map<String, Object?> p) => switch (paymentState(p)) {
    'approving' => const Pill(
      'تأیید شد (در حال اعمال)',
      tone: PayeshTone.success,
    ),
    'rejecting' => const Pill('رد شد (در حال اعمال)', tone: PayeshTone.danger),
    'cancelling' => const Pill(
      'لغو شد (در حال اعمال)',
      tone: PayeshTone.danger,
    ),
    'paid' => const Pill('پرداخت‌شده', tone: PayeshTone.success),
    'rejected' => const Pill('ردشده', tone: PayeshTone.danger),
    'cancelled' => const Pill('لغوشده', tone: PayeshTone.neutral),
    'failed' => const Pill('ناموفق', tone: PayeshTone.danger),
    _ => Pill(
      p['awaiting_owner'] == true
          ? 'بازگشت از درگاه — منتظر تأیید'
          : 'در انتظار تأیید',
      tone: PayeshTone.warning,
    ),
  };

  Widget _subStatus(Object? s) => switch (s) {
    'trial' => const Pill('آزمایشی', tone: PayeshTone.info),
    'expired' => const Pill('منقضی', tone: PayeshTone.warning),
    'cancelled' => const Pill('لغوشده', tone: PayeshTone.neutral),
    _ => const Pill('فعال', tone: PayeshTone.success),
  };
}
