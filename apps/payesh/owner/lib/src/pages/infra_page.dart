import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'base.dart';

/// Row 123 «زیرساخت»: control plane only (manual registration, health, capacity/usage,
/// alerts, history). Risky operations are change REQUESTS; executing one needs a separate
/// owner approval with the target's short id retyped.
class InfraPage extends StatefulWidget {
  const InfraPage({super.key});
  @override
  State<InfraPage> createState() => _InfraPageState();
}

class _InfraPageState extends OwnerPageState<InfraPage> {
  ApiResult? _infra;
  ApiResult? _changes;

  @override
  Future<void> load() async {
    final rs = await Future.wait([api.infra(), api.infraChanges()]);
    _infra = rs[0];
    _changes = rs[1];
  }

  Future<void> _addProvider() async {
    final d = await showReasonDialog(
      context,
      title: 'ثبت دستی ارائه‌دهنده',
      submit: 'ثبت',
      lines: const ['ثبت دستی است و هیچ سروری ساخته نمی‌شود.', secretHint],
      fields: const [
        TextDialogField('code', 'کد (لاتین، مثلاً radcloud)', ltr: true),
        TextDialogField('display_name', 'نام نمایشی'),
        SelectDialogField('kind', 'نوع', infraProviderKinds, initial: 'host'),
        TextDialogField(
          'credential_ref',
          'ارجاع Credential (اختیاری)',
          ltr: true,
          hint: 'secret:NAME',
        ),
      ],
      validate: (v) {
        if (!providerCodeRe.hasMatch(v.text('code'))) {
          return 'کد باید ۲ تا ۴۰ نویسهٔ لاتین کوچک، رقم، - یا _ باشد.';
        }
        if (v.text('display_name').length < 2) {
          return 'نام نمایشی را وارد کنید.';
        }
        return credentialError(v.text('credential_ref'));
      },
    );
    if (d == null) return;
    await mutate(
      api.infraAddProvider(
        code: d.text('code'),
        displayName: d.text('display_name'),
        kind: d.text('kind'),
        credentialRef: d.text('credential_ref'),
        reason: d.reason,
      ),
      'ارائه‌دهنده ثبت شد.',
    );
  }

  Future<void> _addService(Map<String, Object?> p) async {
    final d = await showReasonDialog(
      context,
      title: 'ثبت سرویس برای ${p['display_name'] ?? p['code']}',
      submit: 'ثبت',
      fields: const [
        TextDialogField('name', 'نام سرویس'),
        SelectDialogField('kind', 'نوع', infraServiceKinds, initial: 'gateway'),
        TextDialogField('region', 'منطقه (اختیاری)', ltr: true),
      ],
      validate: (v) {
        if (v.text('name').length < 2) return 'نام سرویس را وارد کنید.';
        final r = v.text('region');
        return r.isEmpty || regionRe.hasMatch(r)
            ? null
            : 'منطقه فقط با نویسهٔ لاتین، رقم، فاصله، . _ - مجاز است.';
      },
    );
    if (d == null) return;
    await mutate(
      api.infraAddService(
        providerId: '${p['id']}',
        name: d.text('name'),
        kind: d.text('kind'),
        region: d.text('region'),
        reason: d.reason,
      ),
      'سرویس ثبت شد.',
    );
  }

  Future<void> _addEndpoint(Map<String, Object?> s) async {
    final d = await showReasonDialog(
      context,
      title: 'ثبت Endpoint برای ${s['name']}',
      submit: 'ثبت',
      lines: const [
        'نام کاربری و رمز در نشانی پذیرفته نیست. بررسی سلامت فقط یک درخواست کوتاه است، بدنهٔ پاسخ خوانده نمی‌شود و نشانی‌های شبکهٔ داخلی رد می‌شوند.',
      ],
      fields: const [
        TextDialogField(
          'url',
          'نشانی (https://… یا tcp://host:port)',
          ltr: true,
        ),
        SelectDialogField('check_kind', 'نوع بررسی', {
          'http': 'HTTP',
          'tcp': 'TCP',
        }, initial: 'http'),
        TextDialogField(
          'expected_status',
          'کد HTTP مورد انتظار (اختیاری)',
          ltr: true,
          numeric: true,
        ),
      ],
      validate: (v) => endpointError(
        v.text('url'),
        v.text('check_kind'),
        v.text('expected_status'),
      ),
    );
    if (d == null) return;
    final n = normDigits(d.text('expected_status'));
    await mutate(
      api.infraAddEndpoint(
        serviceId: '${s['id']}',
        url: d.text('url'),
        checkKind: d.text('check_kind'),
        expectedStatus: n.isEmpty ? null : int.parse(n),
        reason: d.reason,
      ),
      'Endpoint ثبت شد.',
    );
  }

  Future<void> _recordMetric(Map<String, Object?> s) async {
    final d = await showReasonDialog(
      context,
      title: 'ثبت دستی عدد برای ${s['name']}',
      submit: 'ثبت',
      lines: const [
        'هر عدد باید برچسب [M] (اندازه‌گیری‌شده) یا [E] (برآورد) داشته باشد. اگر مقدار را نمی‌دانید، آن را خالی بگذارید تا «نامعلوم» ثبت شود.',
      ],
      fields: [
        SelectDialogField(
          'metric',
          'سنجه',
          {for (final (k, t) in infraMetrics) k: t},
          initial: 'capacity_cpu',
          onChanged: (v, set) => set('unit', infraDefaultUnit[v] ?? 'count'),
        ),
        const TextDialogField(
          'value',
          'مقدار (خالی = نامعلوم)',
          ltr: true,
          numeric: true,
        ),
        SelectDialogField(
          'unit',
          'یکا',
          infraUnits,
          initial: infraDefaultUnit['capacity_cpu']!,
        ),
        const SelectDialogField('label', 'برچسب', {
          'M': 'اندازه‌گیری‌شده [M]',
          'E': 'برآورد [E]',
        }, initial: 'M'),
      ],
      validate: (v) {
        final n = normDigits(v.text('value'));
        if (n.isEmpty) return null;
        final x = num.tryParse(n);
        return x != null && x.isFinite && x >= 0
            ? null
            : 'مقدار باید عدد نامنفی باشد یا خالی بماند.';
      },
    );
    if (d == null) return;
    final n = normDigits(d.text('value'));
    await mutate(
      api.infraRecordMetric(
        serviceId: '${s['id']}',
        metric: d.text('metric'),
        unit: d.text('unit'),
        value: n.isEmpty ? null : num.parse(n),
        label: d.text('label'),
        reason: d.reason,
      ),
      n.isEmpty ? 'سنجه «نامعلوم» ثبت شد.' : 'عدد ثبت شد.',
    );
  }

  Future<void> _check(Map<String, Object?> e) async {
    final r = await api.infraCheck('${e['id']}');
    if (!mounted) return;
    if (r.ok) {
      final c = r.object('check') ?? const {};
      final lat = c['latency_ms'];
      scope.flash(
        c['ok'] == true,
        c['ok'] == true
            ? 'Endpoint سالم است${lat != null ? ' (${faNum(lat)} میلی‌ثانیه)' : ''}.'
            : 'Endpoint پاسخ درست نداد${c['error_code'] != null ? ' (${c['error_code']})' : ''}.',
      );
    } else {
      scope.flash(false, r.message);
    }
    await reload();
  }

  /// Step 1 of 2: the request. Nothing changes until an owner approves (step 2).
  Future<void> _requestChange(
    String action,
    String targetId,
    String targetLabel, [
    Map<String, Object?>? payload,
  ]) async {
    final d = await showReasonDialog(
      context,
      title: 'درخواست: ${infraChanges[action]}',
      danger: true,
      submit: 'ثبت درخواست',
      retype: targetLabel,
      lines: const [
        'این عمل پرخطر است و دو مرحله دارد: (۱) ثبت همین درخواست؛ (۲) تأیید جداگانهٔ مالک پلتفرم. تا تأیید، هیچ تغییری اعمال نمی‌شود.',
        'درخواست و تأیید هر دو در دفتر ممیزی ثبت می‌شوند.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.infraRequestChange(
        action: action,
        targetId: targetId,
        reason: d.reason,
        payload: payload,
      ),
      'درخواست ثبت شد؛ منتظر تأیید مالک.',
    );
  }

  Future<void> _requestCredential(Map<String, Object?> p) async {
    final d = await showReasonDialog(
      context,
      title: 'درخواست تغییر ارجاع Secret برای ${p['code']}',
      danger: true,
      submit: 'ادامه',
      lines: const [secretHint],
      fields: const [
        TextDialogField(
          'credential_ref',
          'ارجاع تازه (خالی = حذف ارجاع)',
          ltr: true,
          hint: 'secret:NAME',
        ),
      ],
      validate: (v) => credentialError(v.text('credential_ref')),
    );
    if (d == null) return;
    await _requestChange('set_credential_ref', '${p['id']}', '${p['code']}', {
      'credential_ref': d.text('credential_ref'),
    });
  }

  /// Step 2 of 2: owner only; the target's short id must be retyped; runs once.
  Future<void> _approve(Map<String, Object?> x) async {
    final d = await showReasonDialog(
      context,
      title: 'تأیید و اجرا: ${infraChanges[x['action']] ?? x['action']}',
      danger: true,
      submit: 'تأیید و اجرا',
      retype: shortId(x['target_id']),
      lines: [
        'دلیل درخواست: ${x['reason'] ?? '—'}',
        'درخواست‌دهنده: ${shortId(x['requested_by'])}',
        'با تأیید، تغییر بلافاصله اجرا و در ممیزی ثبت می‌شود و قابل تکرار نیست.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.infraApprove('${x['id']}', d.reason),
      'تغییر تأیید و اجرا شد.',
    );
  }

  Widget _metric(String key, String title, Object? m) {
    final mm = m is Map<String, Object?> ? m : null;
    final known = mm != null && mm['value'] != null;
    final lab =
        infraLabels[known ? '${mm['label']}' : '?'] ?? infraLabels['?']!;
    final unit = known && mm['unit'] != null
        ? ' ${infraUnits['${mm['unit']}'] ?? mm['unit']}'
        : '';
    final tk = context.tokens;
    return Container(
      key: Key('metric-$key-${known ? 'known' : 'unknown'}'),
      width: 200,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        border: Border.all(color: tk.line),
        borderRadius: BorderRadius.circular(PayeshTokens.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: TextStyle(color: tk.muted, fontSize: 12)),
          const SizedBox(height: 4),
          Text(
            known ? '${faNum(mm['value'])}$unit' : 'نامعلوم',
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: AlignmentDirectional.centerStart,
            child: Pill(lab.$1, tone: toneOf(lab.$2)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final r = _infra;
    final c = _changes;
    final sections = <Widget>[];
    if (loading || r == null || c == null) {
      sections.add(const StateBox.loading('در حال دریافت…'));
      return PageList(onRefresh: reload, children: sections);
    }
    if (!r.ok) {
      for (final t in const [
        'ارائه‌دهنده‌ها',
        'سرویس‌ها، ظرفیت و مصرف',
        'Endpointها و سلامت',
        'هشدارهای باز',
      ]) {
        sections.add(PayeshSection(title: t, child: StateBox.error(r.message)));
      }
    } else {
      final d = r.body ?? const {};
      final prov = d['provisioning'];
      final auto = prov is Map && prov['automated'] == true;
      sections.add(
        Notice(
          auto
              ? 'سرور گزارش Provisioning خودکار داده است؛ این برنامه آن را بدون شاهد تأیید نمی‌کند.'
              : 'ساخت خودکار سرور (Provisioning) فعال نیست. ثبت زیرساخت دستی است و عددی که منبع واقعی ندارد «نامعلوم» نمایش داده می‌شود.',
          key: Key('provisioning-${auto ? 'automated' : 'manual'}'),
        ),
      );
      final providers = r.list('providers');
      final services = r.list('services');
      final endpoints = r.list('endpoints');
      final alerts = r.list('open_alerts');
      final provName = {
        for (final p in providers)
          '${p['id']}': '${p['display_name'] ?? p['code']}',
      };
      final svcName = {for (final s in services) '${s['id']}': '${s['name']}'};

      sections.add(
        PayeshSection(
          title: 'ارائه‌دهنده‌ها',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (caps.infraRegister)
                ActionRow([
                  actionButton(
                    'infra-add-provider',
                    'ثبت ارائه‌دهنده',
                    _addProvider,
                  ),
                ]),
              const SizedBox(height: 8),
              if (providers.isEmpty)
                const StateBox.empty('هنوز ارائه‌دهنده‌ای ثبت نشده است.')
              else
                OwnerTable(
                  columns: const [
                    'کد',
                    'نام',
                    'نوع',
                    'حالت',
                    'Credential',
                    'وضعیت',
                    'عملیات',
                  ],
                  rows: [
                    for (final p in providers)
                      [
                        Code('${p['code']}'),
                        '${p['display_name'] ?? '—'}',
                        infraProviderKinds['${p['kind']}'] ?? '${p['kind']}',
                        Pill(
                          p['api_mode'] == 'manual'
                              ? 'دستی'
                              : '${p['api_mode']}',
                          tone: PayeshTone.info,
                        ),
                        p['credential'] == 'reference' &&
                                p['credential_ref'] != null
                            ? Tooltip(
                                message: 'فقط نام Secret روی سرور؛ مقدار آن هرگز به برنامه نمی‌رسد',
                                child: Code(
                                  '${p['credential_ref']}',
                                  key: Key('credential-ref-${p['id']}'),
                                ),
                              )
                            : const Pill('ندارد'),
                        Status(p['status'] == 'active' ? 'active' : 'disabled'),
                        _providerActions(p),
                      ],
                  ],
                ),
            ],
          ),
        ),
      );

      sections.add(
        PayeshSection(
          title: 'سرویس‌ها، ظرفیت و مصرف',
          child: services.isEmpty
              ? const StateBox.empty('هنوز سرویسی ثبت نشده است.')
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final s in services) ...[
                      Text(
                        [
                          '${s['name']}',
                          infraServiceKinds['${s['kind']}'] ?? '${s['kind']}',
                          provName['${s['provider_id']}'] ??
                              shortId(s['provider_id']),
                          if (s['region'] != null && s['region'] != '')
                            '${s['region']}',
                        ].join(' · '),
                        key: Key('service-${s['id']}'),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final (k, t) in infraMetrics)
                            _metric(
                              k,
                              t,
                              (s['metrics'] is Map
                                  ? s['metrics']! as Map
                                  : const <String, Object?>{})[k],
                            ),
                        ],
                      ),
                      if (caps.infraRegister)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: ActionRow([
                            actionButton(
                              'infra-add-endpoint-${s['id']}',
                              'ثبت Endpoint',
                              () => _addEndpoint(s),
                            ),
                            actionButton(
                              'infra-record-metric-${s['id']}',
                              'ثبت عدد دستی',
                              () => _recordMetric(s),
                            ),
                          ]),
                        ),
                      const SizedBox(height: 12),
                    ],
                    const Notice(
                      '«نامعلوم» یعنی هیچ منبع واقعی (API ارائه‌دهنده یا ثبت دستی با برچسب [M]/[E]) برای این عدد نیست. API ارائه‌دهنده‌ها هنوز وصل نیست (ردیف ۱۲۴).',
                    ),
                  ],
                ),
        ),
      );

      sections.add(
        PayeshSection(
          title: 'Endpointها و سلامت',
          child: endpoints.isEmpty
              ? const StateBox.empty('هنوز Endpointی ثبت نشده است.')
              : OwnerTable(
                  columns: const [
                    'نشانی',
                    'سرویس',
                    'نوع بررسی',
                    'سلامت',
                    'تأخیر',
                    'آخرین بررسی',
                    'عملیات',
                  ],
                  rows: [for (final e in endpoints) _endpointRow(e, svcName)],
                ),
        ),
      );

      sections.add(
        PayeshSection(
          title: 'هشدارهای باز',
          child: alerts.isEmpty
              ? const StateBox.empty('هشدار بازی نیست.')
              : OwnerTable(
                  columns: const ['نوع', 'شدت', 'Endpoint', 'از زمان'],
                  rows: [
                    for (final a in alerts)
                      [
                        a['kind'] == 'endpoint_down'
                            ? 'Endpoint پاسخ نمی‌دهد (۳ شکست پیاپی)'
                            : '${a['kind']}',
                        Pill(
                          a['severity'] == 'critical' ? 'بحرانی' : 'هشدار',
                          tone: a['severity'] == 'critical'
                              ? PayeshTone.danger
                              : PayeshTone.warning,
                        ),
                        Code(
                          shortId(a['endpoint_id']),
                          full: '${a['endpoint_id']}',
                        ),
                        faDate(a['opened_at']),
                      ],
                  ],
                ),
        ),
      );
    }

    final Widget ch;
    if (!c.ok) {
      ch = StateBox.error(c.message);
    } else if (c.list('changes').isEmpty) {
      ch = const StateBox.empty('هنوز درخواست تغییری ثبت نشده است.');
    } else {
      ch = OwnerTable(
        columns: const [
          'عمل',
          'هدف',
          'دلیل',
          'درخواست‌دهنده',
          'وضعیت',
          'زمان',
          'عملیات',
        ],
        rows: [
          for (final x in c.list('changes'))
            [
              infraChanges['${x['action']}'] ?? '${x['action']}',
              Code(shortId(x['target_id']), full: '${x['target_id']}'),
              '${x['reason'] ?? '—'}',
              Code(shortId(x['requested_by'])),
              Pill(
                (infraChangeStatus['${x['status']}'] ?? ('${x['status']}', ''))
                    .$1,
                key: Key('change-status-${x['id']}-${x['status']}'),
                tone: toneOf(
                  (infraChangeStatus['${x['status']}'] ?? ('', '')).$2,
                ),
              ),
              faDate(x['decided_at'] ?? x['created_at']),
              caps.infraApprove && x['status'] == 'pending'
                  ? actionButton(
                      'infra-approve-${x['id']}',
                      'تأیید و اجرا',
                      () => _approve(x),
                      danger: true,
                    )
                  : Pill(
                      x['status'] == 'pending' ? 'فقط مالک تأیید می‌کند' : '—',
                    ),
            ],
        ],
      );
    }
    sections.add(
      PayeshSection(title: 'درخواست‌های تغییر (تاریخچه)', child: ch),
    );
    return PageList(onRefresh: reload, children: sections);
  }

  Widget _providerActions(Map<String, Object?> p) {
    final id = '${p['id']}';
    final active = p['status'] == 'active';
    final acts = <Widget>[
      if (caps.infraRegister && active)
        actionButton(
          'infra-add-service-$id',
          'ثبت سرویس',
          () => _addService(p),
        ),
      if (caps.infraRequestChange) ...[
        if (active)
          actionButton(
            'infra-req-disable-provider-$id',
            'درخواست غیرفعال‌سازی',
            () => _requestChange('disable_provider', id, '${p['code']}'),
            danger: true,
          )
        else
          actionButton(
            'infra-req-enable-provider-$id',
            'درخواست فعال‌سازی',
            () => _requestChange('enable_provider', id, '${p['code']}'),
          ),
        actionButton(
          'infra-req-credential-$id',
          'تغییر ارجاع Secret',
          () => _requestCredential(p),
        ),
      ],
    ];
    return acts.isEmpty ? const Pill('فقط مشاهده') : ActionRow(acts);
  }

  List<Object?> _endpointRow(
    Map<String, Object?> e,
    Map<String, String> svcName,
  ) {
    final id = '${e['id']}';
    final hv = e['health'] is Map<String, Object?>
        ? e['health']! as Map<String, Object?>
        : const {'state': 'unknown'};
    final state = '${hv['state'] ?? 'unknown'}';
    final hs = infraHealth[state] ?? infraHealth['unknown']!;
    final enabled = e['enabled'] == true;
    final acts = <Widget>[
      if (caps.infraCheck && enabled)
        actionButton('infra-check-$id', 'بررسی دستی', () => _check(e)),
      if (caps.infraRequestChange && enabled)
        actionButton(
          'infra-req-disable-endpoint-$id',
          'درخواست غیرفعال‌سازی',
          () => _requestChange('disable_endpoint', id, '${e['url']}'),
          danger: true,
        ),
      if (!enabled) const Pill('غیرفعال', tone: PayeshTone.danger),
    ];
    return [
      Code('${e['url']}'),
      svcName['${e['service_id']}'] ?? shortId(e['service_id']),
      e['check_kind'] == 'tcp' ? 'TCP' : 'HTTP',
      Pill(
        '${hs.$1}${state == 'down' && hv['error_code'] != null ? ' (${hv['error_code']})' : ''}',
        key: Key('health-$id-$state'),
        tone: toneOf(hs.$2),
      ),
      hv['latency_ms'] == null
          ? 'نامعلوم'
          : '${faNum(hv['latency_ms'])} میلی‌ثانیه',
      hv['checked_at'] != null ? faDate(hv['checked_at']) : 'هرگز',
      acts.isEmpty ? const Pill('فقط مشاهده') : ActionRow(acts),
    ];
  }
}
