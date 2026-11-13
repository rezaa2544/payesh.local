// صفحهٔ «پلن‌ها» — بخش اشتراک (برگردان p2 src/js/23-subscription.js): سیاست هر نقش
// («اشتراکی» یا «رایگان»)، دورهٔ آزمایشی (یک بار برای هر دستگاه)، پلن‌ها و قیمت‌ها، درگاه
// پرداخت (فقط پیوند)، ثبت رسید، کادر دامنه، پرداخت‌ها و مشترکان (هدیه/بازنشانی).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'school_registry.dart';
import 'schools_section.dart';

class SubscriptionSection extends StatefulWidget {
  const SubscriptionSection({
    super.key,
    required this.registry,
    required this.flash,
    this.canManage = true,
  });
  final SchoolRegistry registry;
  final void Function(bool ok, String text) flash;
  final bool canManage;

  @override
  State<SubscriptionSection> createState() => _SubscriptionSectionState();
}

class _SubscriptionSectionState extends State<SubscriptionSection>
    with RegistryLoader {
  @override
  SchoolRegistry get registry => widget.registry;
  @override
  void Function(bool ok, String text) get flash => widget.flash;

  SubSettings? _s;
  int _loadedRev = -1;
  final _days = TextEditingController();
  final _note = TextEditingController();
  final _pay = TextEditingController();
  final _verify = TextEditingController();
  final _domain = TextEditingController();
  final Map<String, TextEditingController> _price = {
    for (final p in subPlans) p.key: TextEditingController(),
  };

  @override
  void dispose() {
    for (final c in [_days, _note, _pay, _verify, _domain, ..._price.values]) {
      c.dispose();
    }
    super.dispose();
  }

  /// فرم را با نسخهٔ تازهٔ فهرست پر می‌کند (فقط وقتی rev عوض شده باشد).
  void _sync() {
    final v = view;
    if (v == null || v.rev == _loadedRev) return;
    _loadedRev = v.rev;
    final s = _s = v.settings;
    _days.text = '${s.trialDays}';
    _note.text = s.receiptNote;
    _pay.text = s.payUrl;
    _verify.text = s.verifyUrl;
    _domain.text = v.domain;
    for (final p in subPlans) {
      final x = s.prices[p.key];
      _price[p.key]!.text = x == null ? '' : '$x';
    }
  }

  Future<void> _save(String okText) async {
    final s = _s;
    if (s == null) return;
    final days = int.tryParse(digitsOnly(_days.text));
    if (days == null || days < 0 || days > 365) {
      flash(false, 'روزهای آزمایشی باید بین ۰ تا ۳۶۵ باشد.');
      return;
    }
    s
      ..trialDays = days
      ..receiptNote = _note.text
      ..payUrl = _pay.text
      ..verifyUrl = _verify.text;
    for (final p in subPlans) {
      final t = digitsOnly(_price[p.key]!.text);
      if (s.prices.containsKey(p.key)) {
        final n = int.tryParse(t);
        if (n == null) {
          flash(false, 'قیمت پلن ${p.title} را وارد کنید.');
          return;
        }
        s.prices[p.key] = n;
      }
    }
    if (s.prices.values.every((x) => x == null) && s.paywallEnabled) {
      flash(false, 'دست‌کم یک پلن باید ارائه شود.');
      return;
    }
    _loadedRev = -1;
    try {
      await registry.saveSettings(s, domain: _domain.text);
    } on SchoolsFailure catch (e) {
      flash(false, e.messageFa);
      return;
    }
    flash(true, okText);
    await reloadRegistry();
  }

  Future<void> _decide(Map<String, Object?> p, bool ok) async {
    final d = await showReasonDialog(
      context,
      title: ok ? 'تأیید پرداخت ${p['id']}' : 'رد پرداخت ${p['id']}',
      danger: !ok,
      submit: ok ? 'تأیید' : 'رد',
      lines: [
        '${p['name'] ?? ''} (${subRoleTitles[p['role']] ?? p['role']}) — پلن ${_planTitle(p['plan'])}، مبلغ ${faNum(p['amount'] ?? 0)} ریال',
        if (p['ref'] != null) 'شمارهٔ رسید/مرجع: ${p['ref']}',
        ok
            ? 'با تأیید، اشتراک این کاربر از پایان اشتراک فعلی (یا از امروز) تمدید می‌شود (p2).'
            : 'دلیل رد به کاربر نمایش داده می‌شود.',
      ],
    );
    if (d == null) return;
    await change(
      () => registry.decide('${p['id']}', ok, reason: d.reason),
      ok
          ? 'پرداخت تأیید شد؛ سرور مدرسه تا یک دقیقهٔ دیگر فعال می‌کند.'
          : 'پرداخت رد شد.',
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
      title: gift
          ? '🎁 فعال‌سازی اشتراک ${sub['name'] ?? ''}'
          : '♻️ بازنشانی اشتراک ${sub['name'] ?? ''}',
      danger: !gift,
      submit: gift ? 'فعال‌سازی' : 'بازنشانی',
      lines: [
        gift ? 'اشتراک این کاربر به این تعداد روز تمدید می‌شود.' : 'رکورد اشتراک این کاربر پاک می‌شود (p2 «♻️ بازنشانی»). دورهٔ آزمایشیِ مصرف‌شدهٔ دستگاه دوباره باز نمی‌شود.',
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
      gift
          ? 'فعال‌سازی ثبت شد؛ سرور مدرسه تا یک دقیقهٔ دیگر اعمال می‌کند.'
          : 'بازنشانی ثبت شد.',
    );
  }

  String _planTitle(Object? k) => switch (k) {
    'trial' => 'آزمایشی',
    'gift' => 'هدیه',
    _ => subPlans.where((p) => p.key == k).firstOrNull?.title ?? '${k ?? '—'}',
  };

  Widget _field(
    TextEditingController c,
    String key,
    String label, {
    bool ltr = false,
    bool numeric = false,
    String? hint,
    int lines = 1,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: TextField(
      key: Key(key),
      controller: c,
      enabled: widget.canManage,
      maxLines: lines,
      textDirection: ltr ? TextDirection.ltr : null,
      keyboardType: numeric ? TextInputType.number : null,
      inputFormatters: numeric
          ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9۰-۹]'))]
          : null,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    _sync();
    final v = view;
    final s = _s;
    if (v == null || s == null) {
      return const PayeshSection(
        title: 'اشتراک‌ها',
        child: StateBox.loading('در حال دریافت تنظیمات اشتراک…'),
      );
    }
    final edit = widget.canManage;
    final names = {for (final x in v.schools) '${x['id']}': '${x['name']}'};
    final pending = v.payments
        .where((p) => p['status'] == 'pending' && p['decision'] == null)
        .length;
    // آمار p2: فعال / آزمایشی / منقضی / درآمد
    var active = 0, trial = 0, expired = 0, revenue = 0;
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
    return Column(
      key: const Key('subscription-section'),
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
              Pill(
                'در انتظار تأیید: ${faNum(pending)}',
                key: const Key('sub-pending-count'),
                tone: pending > 0 ? PayeshTone.warning : PayeshTone.neutral,
              ),
              Pill('درآمد: ${faNum(revenue)} ریال'),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'سیاست اشتراک برای هر نقش',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SwitchListTile(
                key: const Key('sub-paywall'),
                contentPadding: EdgeInsets.zero,
                value: s.paywallEnabled,
                title: const Text('دیوار پرداخت فعال است'),
                subtitle: const Text(
                  'خاموش = همهٔ نقش‌ها بدون اشتراک کار می‌کنند.',
                ),
                onChanged: edit
                    ? (x) => setState(() => s.paywallEnabled = x)
                    : null,
              ),
              for (final r in subRoles)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    children: [
                      Expanded(child: Text(subRoleTitles[r]!)),
                      SegmentedButton<String>(
                        key: Key('sub-role-$r'),
                        segments: const [
                          ButtonSegment(
                            value: 'required',
                            label: Text('نیاز به اشتراک'),
                          ),
                          ButtonSegment(value: 'free', label: Text('رایگان')),
                        ],
                        selected: {s.roles[r] ?? 'free'},
                        onSelectionChanged: edit
                            ? (x) => setState(() => s.roles[r] = x.first)
                            : null,
                      ),
                    ],
                  ),
                ),
              const Notice(
                'نقشِ «نیاز به اشتراک» تا پرداخت و تأیید هیچ امکانی ندارد، مگر دورهٔ آزمایشی تعریف شده باشد.',
              ),
              const Divider(),
              SwitchListTile(
                key: const Key('sub-trial'),
                contentPadding: EdgeInsets.zero,
                value: s.trialEnabled,
                title: const Text('دورهٔ آزمایشی'),
                subtitle: const Text(
                  'فقط یک بار برای هر دستگاه — حتی پس از حذف و نصب دوبارهٔ برنامه (شناسهٔ دستگاه درهم‌سازی‌شده در دیتابیس).',
                ),
                onChanged: edit
                    ? (x) => setState(() => s.trialEnabled = x)
                    : null,
              ),
              _field(
                _days,
                'sub-trial-days',
                'تعداد روزهای آزمایشی (۰ تا ۳۶۵)',
                numeric: true,
              ),
              const Divider(),
              Text(
                'پلن‌ها و قیمت (ریال)',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              for (final p in subPlans)
                Row(
                  children: [
                    Checkbox(
                      key: Key('sub-plan-on-${p.key}'),
                      value: s.prices.containsKey(p.key),
                      onChanged: edit
                          ? (x) => setState(() {
                              if (x == true) {
                                s.prices[p.key] =
                                    int.tryParse(
                                      digitsOnly(_price[p.key]!.text),
                                    ) ??
                                    p.price;
                                _price[p.key]!.text = '${s.prices[p.key]}';
                              } else {
                                s.prices.remove(p.key);
                              }
                            })
                          : null,
                    ),
                    SizedBox(
                      width: 90,
                      child: Text('${p.title} (${faNum(p.months)} ماه)'),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _field(
                        _price[p.key]!,
                        'sub-price-${p.key}',
                        'قیمت ${p.title}',
                        numeric: true,
                        ltr: true,
                      ),
                    ),
                  ],
                ),
              if (edit)
                ActionRow([
                  actionButton(
                    'sub-save',
                    'ذخیرهٔ سیاست اشتراک',
                    () => _save(
                      'سیاست اشتراک ذخیره شد؛ سرورهای مدرسه تا یک دقیقهٔ دیگر دنبال می‌کنند.',
                    ),
                    primary: true,
                  ),
                ]),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'درگاه پرداخت',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: s.gatewayConfigured
                    ? const Pill(
                        'درگاه فعال',
                        key: Key('gateway-on'),
                        tone: PayeshTone.success,
                      )
                    : const Pill(
                        'درگاه تنظیم نشده',
                        key: Key('gateway-off'),
                        tone: PayeshTone.warning,
                      ),
              ),
              const SizedBox(height: 8),
              _field(
                _pay,
                'sub-pay-url',
                'پیوند درگاه پرداخت',
                ltr: true,
                hint: 'https://…/pay?amount={amount}&id={payment_id}&callback={callback}',
              ),
              _field(
                _verify,
                'sub-verify-url',
                'پیوند تأیید پرداخت (اختیاری)',
                ltr: true,
                hint: 'https://…/verify?id={payment_id}',
              ),
              const Notice(
                'جای‌نگهدارها: {amount} مبلغ به ریال، {amount_toman} به تومان، {payment_id} کد پیگیری (SUB-…)، {callback} نشانی بازگشت، {description} شرح، {mobile} شمارهٔ همراه کاربر. '
                'با «پیوند تأیید»، سرور مدرسه پس از بازگشت از درگاه پرداخت را خودکار تأیید و اشتراک را فعال می‌کند؛ بدون آن، پرداخت در فهرست زیر برای تأیید شما می‌ماند. '
                'تا درگاه تنظیم نشده، کاربران با «ثبت رسید» پرداخت می‌کنند.',
              ),
              const Divider(),
              SwitchListTile(
                key: const Key('sub-receipt'),
                contentPadding: EdgeInsets.zero,
                value: s.receiptEnabled,
                title: const Text('ثبت رسید (کارت‌به‌کارت) با تأیید مالک'),
                onChanged: edit
                    ? (x) => setState(() => s.receiptEnabled = x)
                    : null,
              ),
              _field(
                _note,
                'sub-receipt-note',
                'راهنمای پرداخت برای کاربر (مثلاً شمارهٔ کارت و نام صاحب حساب)',
                lines: 2,
              ),
              if (edit)
                ActionRow([
                  actionButton(
                    'sub-save-gateway',
                    'ذخیرهٔ درگاه و رسید',
                    () => _save('تنظیمات پرداخت ذخیره شد.'),
                    primary: true,
                  ),
                ]),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'دامنهٔ سایت',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _field(
                _domain,
                'sub-domain',
                'دامنه (مثلاً https://payesh.ir)',
                ltr: true,
              ),
              const Notice(
                'سایت معرفی بعداً ساخته می‌شود؛ فرم «درخواست ثبت نام مدرسه جدید» همان‌جا هم قرار می‌گیرد. اگر سرور مدرسه نشانی عمومی نداشته باشد، نشانی بازگشت درگاه از همین دامنه ساخته می‌شود.',
              ),
              if (edit)
                ActionRow([
                  actionButton(
                    'sub-save-domain',
                    'ذخیرهٔ دامنه',
                    () => _save('دامنه ذخیره شد.'),
                  ),
                ]),
            ],
          ),
        ),
        const SizedBox(height: PayeshTokens.space3),
        PayeshSection(
          title: 'پرداخت‌ها',
          child: v.payments.isEmpty
              ? const StateBox.empty('هنوز پرداختی ثبت نشده است.')
              : OwnerTable(
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
                    for (final p in v.payments)
                      [
                        Code('${p['id']}'),
                        faDate(p['created_at']),
                        names['${p['school_id']}'] ?? '—',
                        '${p['name'] ?? ''} (${subRoleTitles[p['role']] ?? p['role'] ?? ''})',
                        '${_planTitle(p['plan'])} — ${faNum(p['amount'] ?? 0)} ریال',
                        '${p['method'] == 'gateway' ? 'درگاه' : 'رسید'}${p['ref'] != null ? ' — ${p['ref']}' : ''}${p['gateway_ref'] != null ? ' — ${p['gateway_ref']}' : ''}',
                        _payStatus(p),
                        edit &&
                                p['decision'] == null &&
                                (p['status'] == 'pending' ||
                                    p['status'] == 'failed')
                            ? ActionRow([
                                actionButton(
                                  'pay-approve-${p['id']}',
                                  'تأیید',
                                  () => _decide(p, true),
                                  primary: true,
                                ),
                                actionButton(
                                  'pay-reject-${p['id']}',
                                  'رد',
                                  () => _decide(p, false),
                                ),
                              ])
                            : const Text('—'),
                      ],
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
                        _planTitle(m['plan']),
                        faDate(m['end']),
                        edit
                            ? ActionRow([
                                actionButton(
                                  'sub-gift-$sid-${m['uid']}',
                                  '🎁 فعال‌سازی',
                                  () => _grant(sid, m, 'gift'),
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
            key: const Key('sub-refresh'),
            onPressed: reloadRegistry,
            child: const Text('بروزرسانی'),
          ),
        ),
      ],
    );
  }

  Widget _payStatus(Map<String, Object?> p) {
    final d = p['decision'];
    if (d is Map && p['status'] != 'paid' && p['status'] != 'rejected') {
      return Pill(
        d['status'] == 'approved'
            ? 'تأیید شد (در حال اعمال)'
            : 'رد شد (در حال اعمال)',
        tone: d['status'] == 'approved'
            ? PayeshTone.success
            : PayeshTone.danger,
      );
    }
    return switch (p['status']) {
      'paid' => const Pill('پرداخت‌شده', tone: PayeshTone.success),
      'rejected' => const Pill('ردشده', tone: PayeshTone.danger),
      'failed' => const Pill('ناموفق', tone: PayeshTone.danger),
      _ => Pill(
        p['awaiting_owner'] == true
            ? 'بازگشت از درگاه — منتظر تأیید'
            : 'در انتظار تأیید',
        tone: PayeshTone.warning,
      ),
    };
  }

  Widget _subStatus(Object? s) => switch (s) {
    'trial' => const Pill('آزمایشی', tone: PayeshTone.info),
    'expired' => const Pill('منقضی', tone: PayeshTone.warning),
    _ => const Pill('فعال', tone: PayeshTone.success),
  };
}
