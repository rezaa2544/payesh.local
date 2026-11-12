import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'base.dart';

class OperatorsPage extends StatefulWidget {
  const OperatorsPage({super.key});
  @override
  State<OperatorsPage> createState() => _OperatorsPageState();
}

class _OperatorsPageState extends OwnerPageState<OperatorsPage> {
  ApiResult? _users;
  ApiResult? _grants;
  ApiResult? _audit;

  @override
  Future<void> load() async {
    final rs = await Future.wait([
      api.platformUsers(),
      api.supportGrants(),
      if (caps.approveGrant) api.audit(),
    ]);
    _users = rs[0];
    _grants = rs[1];
    _audit = rs.length > 2 ? rs[2] : null;
  }

  Future<void> _createUser() async {
    final d = await showReasonDialog(
      context,
      title: 'کاربر جدید پلتفرم',
      submit: 'ثبت',
      fields: [
        const TextDialogField('login_id', 'شناسهٔ ورود', ltr: true),
        SelectDialogField('role', 'نقش', {
          for (final r in OwnerRole.values) r.wire: r.label,
        }, initial: OwnerRole.owner.wire),
      ],
      validate: (v) =>
          v.text('login_id').isEmpty ? 'شناسهٔ ورود را وارد کنید.' : null,
    );
    if (d == null) return;
    await mutate(
      api.createUser(d.text('login_id'), d.text('role'), d.reason),
      'کاربر ثبت شد.',
    );
  }

  Future<void> _requestGrant() async {
    final now = scope.now();
    final d = await showReasonDialog(
      context,
      title: 'درخواست مجوز پشتیبانی',
      submit: 'ارسال برای تأیید مالک',
      lines: const [
        'مجوز تنها پس از تأیید یک مالک دیگر فعال می‌شود، حداکثر ۷۲ ساعت اعتبار دارد و قابل تمدید نیست.',
      ],
      fields: [
        const TextDialogField(
          'tenant_id',
          'شناسهٔ مدرسه',
          ltr: true,
          hint: 'UUID مدرسه',
        ),
        const SelectDialogField('scope', 'دامنه', {
          'metadata': 'فراداده',
          'content_read': 'خواندن محتوا (تک‌رکورد)',
        }, initial: 'metadata'),
        const TextDialogField('case_ref', 'شمارهٔ پرونده', ltr: true),
        DateTimeDialogField(
          'notified',
          'زمان واقعی اطلاع‌رسانی به مدرسه',
          initial: now,
        ),
        DateTimeDialogField(
          'starts',
          'شروع مجوز',
          initial: now.add(const Duration(minutes: 30)),
        ),
        const TextDialogField(
          'hours',
          'مدت (ساعت، حداکثر ۷۲)',
          ltr: true,
          numeric: true,
          initial: '4',
        ),
      ],
      validate: (v) {
        final tid = v.text('tenant_id');
        if (!uuidRe.hasMatch(tid)) return ownerErrors['invalid_tenant_id'];
        return supportGrantError(
          tenantId: tid,
          caseRef: v.text('case_ref'),
          notified: v.time('notified'),
          starts: v.time('starts'),
          hours: num.tryParse(normDigits(v.text('hours'))) ?? 0,
        );
      },
    );
    if (d == null) return;
    await mutate(
      api.requestGrant(
        tenantId: d.text('tenant_id'),
        scope: d.text('scope'),
        caseRef: d.text('case_ref'),
        reason: d.reason,
        schoolNotifiedAt: d.time('notified')!,
        startsAt: d.time('starts')!,
        hours: int.parse(normDigits(d.text('hours'))),
      ),
      'درخواست مجوز ثبت شد و منتظر تأیید مالک است.',
    );
  }

  Future<void> _approve(Map<String, Object?> e) async {
    final d = await showReasonDialog(
      context,
      title: 'تأیید درخواست مجوز',
      submit: 'تأیید',
      lines: [
        'درخواست ${shortId(e['subject_ref'])} برای مدرسهٔ ${shortId(e['tenant_id'])} تأیید می‌شود.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.approveGrant('${e['subject_ref']}', d.reason),
      'درخواست تأیید شد.',
    );
  }

  Future<void> _revoke(Map<String, Object?> g) async {
    final d = await showReasonDialog(
      context,
      title: 'ابطال فوری مجوز',
      danger: true,
      submit: 'ابطال',
      lines: ['مجوز ${shortId(g['id'])} بلافاصله باطل می‌شود.'],
    );
    if (d == null) return;
    await mutate(api.revokeGrant('${g['id']}', d.reason), 'مجوز باطل شد.');
  }

  @override
  Widget build(BuildContext context) {
    final now = scope.now();
    final users = listBox(
      _users,
      'users',
      loadingText: 'در حال دریافت کاربران…',
      emptyText: 'کاربری ثبت نشده است.',
      build: (rows) => OwnerTable(
        columns: const ['شناسهٔ ورود', 'نقش', 'وضعیت', 'ایجاد'],
        rows: [
          for (final x in rows)
            [
              Code('${x['login_id']}'),
              roleLabel(x['role']),
              Status(x['status']),
              faDate(x['created_at']),
            ],
        ],
      ),
    );
    final grants = listBox(
      _grants,
      'grants',
      loadingText: 'در حال دریافت مجوزها…',
      emptyText: 'هیچ مجوز پشتیبانی ثبت نشده است.',
      build: (rows) => OwnerTable(
        columns: const [
          'مدرسه',
          'دامنه',
          'پرونده',
          'بازه',
          'خواندن',
          'وضعیت',
          'عملیات',
        ],
        rows: [for (final x in rows) _grantRow(x, now)],
      ),
    );
    Widget? reqs;
    if (caps.approveGrant) {
      reqs = listBox(
        _audit,
        'events',
        loadingText: 'در حال دریافت درخواست‌ها…',
        emptyText: 'درخواست تازه‌ای در دفتر ممیزی نیست.',
        build: (ev) {
          final rows = ev.where((e) => e['action'] == 'grant.request').toList();
          if (rows.isEmpty) {
            return const StateBox.empty('درخواست تازه‌ای در دفتر ممیزی نیست.');
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              OwnerTable(
                columns: const [
                  'زمان',
                  'درخواست‌دهنده',
                  'مدرسه',
                  'دلیل',
                  'عملیات',
                ],
                rows: [
                  for (final e in rows)
                    [
                      faDate(e['created_at']),
                      Code(shortId(e['actor_ref'])),
                      Code(shortId(e['tenant_id'])),
                      '${e['reason'] ?? '—'}',
                      actionButton(
                        'approve-grant-${e['subject_ref']}',
                        'تأیید (چهارچشمی)',
                        () => _approve(e),
                        primary: true,
                      ),
                    ],
                ],
              ),
              const Notice(
                'تأییدکننده نمی‌تواند همان درخواست‌دهنده باشد؛ سرور این قید را اعمال می‌کند.',
              ),
            ],
          );
        },
      );
    }
    return PageList(
      onRefresh: reload,
      children: [
        PayeshSection(
          title: 'کاربران پلتفرم',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (caps.createUser)
                ActionRow([
                  actionButton(
                    'create-user',
                    'کاربر جدید',
                    _createUser,
                    primary: true,
                  ),
                ]),
              const SizedBox(height: 8),
              users,
            ],
          ),
        ),
        PayeshSection(
          title: 'مجوزهای پشتیبانی',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (caps.requestGrant)
                ActionRow([
                  actionButton(
                    'request-grant',
                    'درخواست مجوز',
                    _requestGrant,
                    primary: true,
                  ),
                ]),
              const SizedBox(height: 8),
              grants,
            ],
          ),
        ),
        if (reqs != null)
          PayeshSection(
            title: 'درخواست‌های ثبت‌شده (از دفتر ممیزی)',
            child: reqs,
          ),
      ],
    );
  }

  List<Object?> _grantRow(Map<String, Object?> x, DateTime now) {
    final ends = DateTime.tryParse('${x['ends_at']}');
    final revoked = x['revoked_at'] != null;
    final live = !revoked && ends != null && ends.isAfter(now);
    return [
      Code(shortId(x['tenant_id']), full: '${x['tenant_id']}'),
      x['scope'] == 'content_read' ? 'خواندن محتوا' : 'فراداده',
      '${x['case_ref'] ?? '—'}',
      '${faDate(x['starts_at'])} تا ${faDate(x['ends_at'])}',
      '${faNum(x['used_reads'])} / ${faNum(x['max_actions'])}',
      revoked
          ? const Pill('ابطال‌شده', tone: PayeshTone.danger)
          : live
          ? const Pill('فعال', tone: PayeshTone.success)
          : const Pill('پایان‌یافته'),
      caps.revokeGrant && live
          ? actionButton(
              'revoke-grant-${x['id']}',
              'ابطال فوری',
              () => _revoke(x),
              danger: true,
            )
          : const Text('—'),
    ];
  }
}
