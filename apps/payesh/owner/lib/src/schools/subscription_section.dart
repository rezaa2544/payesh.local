// صفحهٔ «پلن‌ها» — بخش اشتراک (برگردان p2 src/js/23-subscription.js): سیاست هر نقش
// (کلید «نیاز به اشتراک»، ردیف ۱۴۹: ماهانه و سالانهٔ جداگانه با مبلغ ریالی)، دورهٔ آزمایشی
// (یک بار برای هر دستگاه)، درگاه پرداخت (فقط پیوند)، ثبت رسید و کادر دامنه.
// پرداخت‌ها و مشترکان در payments_section.dart (پیگیری، تأیید، رد، لغو).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_ui/payesh_ui.dart';

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

  /// کلید «نقش/پلن» ← کادر قیمت (ریال).
  final Map<String, TextEditingController> _price = {
    for (final r in subRoles)
      for (final p in offeredPlans) '$r/${p.key}': TextEditingController(),
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
    for (final r in subRoles) {
      for (final p in offeredPlans) {
        final x = s.rolePrices[r]?[p.key];
        _price['$r/${p.key}']!.text = x == null ? '' : '$x';
      }
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
    for (final r in subRoles) {
      for (final p in offeredPlans) {
        if (!s.offered(r, p.key)) continue;
        final n = int.tryParse(digitsOnly(_price['$r/${p.key}']!.text));
        if (n == null || n <= 0) {
          flash(
            false,
            'قیمت ${p.title} برای ${subRoleTitles[r]} را به ریال وارد کنید.',
          );
          return;
        }
        s.rolePrices[r]![p.key] = n;
      }
      if (s.paywallEnabled &&
          s.roles[r] == 'required' &&
          offeredPlans.every((p) => !s.offered(r, p.key))) {
        flash(
          false,
          'برای ${subRoleTitles[r]} (نیاز به اشتراک) دست‌کم یکی از ماهانه یا سالانه را روشن کنید.',
        );
        return;
      }
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
              for (final r in subRoles) _roleCard(r, s, edit),
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
              const Notice(
                'ماهانه: ۳۱ روز از پرداخت. سالانه: مبلغ کامل، حتی اگر دیر خریده شود. همهٔ اشتراک‌ها در پایان سال تحصیلی (۳۱ شهریور) تمام می‌شوند و برای سال جدید دوباره خریده می‌شوند؛ از ۱ تیر به مدیران هشدار تمدید داده می‌شود و سالانه‌ای که از ۱ تیر خریده شود سال بعد را پوشش می‌دهد.',
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

  /// ردیف ۱۴۹: هر نقش — کلید «نیاز به اشتراک»، و ماهانه/سالانه هر کدام با کلید و مبلغ ریالی.
  Widget _roleCard(String r, SubSettings s, bool edit) {
    final required = (s.roles[r] ?? 'free') == 'required';
    final theme = Theme.of(context);
    return Card(
      key: Key('sub-role-card-$r'),
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    subRoleTitles[r]!,
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                Text(
                  required ? 'نیاز به اشتراک' : 'رایگان',
                  key: Key('sub-role-label-$r'),
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(width: 6),
                Switch(
                  key: Key('sub-role-$r'),
                  value: required,
                  onChanged: edit
                      ? (x) =>
                            setState(() => s.roles[r] = x ? 'required' : 'free')
                      : null,
                ),
              ],
            ),
            if (required)
              for (final p in offeredPlans)
                Row(
                  children: [
                    Switch(
                      key: Key('sub-on-$r-${p.key}'),
                      value: s.offered(r, p.key),
                      onChanged: edit
                          ? (x) => setState(() {
                              final c = _price['$r/${p.key}']!;
                              if (x) {
                                final n =
                                    int.tryParse(digitsOnly(c.text)) ?? p.price;
                                s.rolePrices[r]![p.key] = n;
                                c.text = '$n';
                              } else {
                                s.rolePrices[r]![p.key] = null;
                              }
                            })
                          : null,
                    ),
                    SizedBox(
                      width: 64,
                      child: Text(p.key == 'monthly' ? 'ماهانه' : 'سالانه'),
                    ),
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: TextField(
                          key: Key('sub-price-$r-${p.key}'),
                          controller: _price['$r/${p.key}'],
                          enabled: edit && s.offered(r, p.key),
                          textDirection: TextDirection.ltr,
                          keyboardType: TextInputType.number,
                          inputFormatters: [
                            FilteringTextInputFormatter.allow(
                              RegExp(r'[0-9۰-۹]'),
                            ),
                          ],
                          decoration: InputDecoration(
                            labelText: p.key == 'monthly'
                                ? 'مبلغ ماهانه (۳۱ روز)'
                                : 'مبلغ سالانه (تا ۳۱ شهریور)',
                            suffixText: 'ریال',
                            border: const OutlineInputBorder(),
                            isDense: true,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
          ],
        ),
      ),
    );
  }
}
