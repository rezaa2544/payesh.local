import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'base.dart';

class SchoolsPage extends StatefulWidget {
  const SchoolsPage({super.key});
  @override
  State<SchoolsPage> createState() => _SchoolsPageState();
}

/// One provisioning op id per slug for the app's lifetime: a retry after a failure or a
/// lost answer re-sends the same id, so the server never builds a second school.
final Map<String, String> _provisionOps = {};

class _SchoolsPageState extends OwnerPageState<SchoolsPage> {
  ApiResult? _tenants;
  ApiResult? _dels;

  @override
  Future<void> load() async {
    final rs = await Future.wait([
      api.tenants(),
      if (caps.deleteRequest) api.tenantDeletions(),
    ]);
    _tenants = rs[0];
    _dels = rs.length > 1 ? rs[1] : null;
  }

  Future<void> _suspend(Map<String, Object?> t) async {
    final d = await showReasonDialog(
      context,
      title: 'تعلیق مدرسه',
      danger: true,
      submit: 'تعلیق',
      lines: [
        'دسترسی مدرسهٔ ${shortId(t['tenant_id'])} تعلیق می‌شود و رویداد در دفتر ممیزی ثبت خواهد شد.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.suspendTenant('${t['tenant_id']}', d.reason),
      'مدرسه تعلیق شد.',
    );
  }

  Future<void> _requestDeletion(Map<String, Object?> t) async {
    final tid = '${t['tenant_id']}';
    final d = await showReasonDialog(
      context,
      title: 'درخواست حذف مدرسه',
      danger: true,
      submit: 'ثبت درخواست حذف',
      retype: tid,
      lines: const [
        'حذف مدرسه چهارچشمی است: درخواست شما باید توسط مالک دیگری تأیید شود.',
        'اجرا دست‌کم ۲۴ ساعت پس از تأیید انجام می‌شود تا مدرسه مطلع شود و امکان بازگشت باشد.',
        'اجرا سرویس را متوقف و اشتراک را لغو می‌کند؛ داده دست‌کم ۱۸۰ روز نگه داشته می‌شود.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.requestDeletion(tid, d.reason),
      'درخواست حذف ثبت شد؛ منتظر تأیید مالک دیگر.',
    );
  }

  Future<void> _approve(Map<String, Object?> x) async {
    final d = await showReasonDialog(
      context,
      title: 'تأیید حذف مدرسه (مالک دوم)',
      danger: true,
      submit: 'تأیید',
      retype: '${x['tenant_id']}',
      lines: [
        'با تأیید شما، اجرای حذف مدرسهٔ ${shortId(x['tenant_id'])} زودتر از ۲۴ ساعت بعد ممکن نیست.',
        'دلیل درخواست: ${x['reason'] ?? '—'}',
      ],
    );
    if (d == null) return;
    await mutate(
      api.approveDeletion('${x['id']}', d.reason),
      'حذف تأیید شد؛ اجرا پس از ۲۴ ساعت ممکن است.',
    );
  }

  Future<void> _cancel(Map<String, Object?> x) async {
    final d = await showReasonDialog(
      context,
      title: 'لغو درخواست حذف',
      submit: 'لغو درخواست',
      lines: [
        'درخواست حذف مدرسهٔ ${shortId(x['tenant_id'])} بسته می‌شود و اشتراک دست‌نخورده می‌ماند.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.cancelDeletion('${x['id']}', d.reason),
      'درخواست حذف لغو شد.',
    );
  }

  Future<void> _execute(Map<String, Object?> x) async {
    final d = await showReasonDialog(
      context,
      title: 'اجرای حذف مدرسه',
      danger: true,
      submit: 'اجرا',
      retype: '${x['tenant_id']}',
      lines: [
        'سرویس مدرسهٔ ${shortId(x['tenant_id'])} متوقف و اشتراک‌هایش لغو می‌شود.',
        'داده دست‌کم ۱۸۰ روز نگه داشته می‌شود؛ نابودی نهایی خارج از این پنل و با تأیید مالک است.',
      ],
    );
    if (d == null) return;
    await mutate(
      api.executeDeletion('${x['id']}', d.reason),
      'حذف اجرا شد؛ سرویس متوقف و داده نگه داشته شد.',
    );
  }

  Future<void> _createSchool() async {
    final d = await showReasonDialog(
      context,
      title: 'ساخت مدرسه',
      submit: 'ساخت مدرسه',
      lines: const [
        'یک فضای اختصاصی (tenant) با جداسازی RLS و یک مدیر اولیه ساخته می‌شود. کد فعال‌سازی مدیر فقط یک بار نمایش داده می‌شود.',
      ],
      fields: const [
        TextDialogField(
          'slug',
          'نشانی کوتاه مدرسه (لاتین، مثلاً school-12)',
          ltr: true,
        ),
        TextDialogField('display_name', 'نام مدرسه'),
        TextDialogField('manager_name', 'نام مدیر اولیه'),
        TextDialogField('plan_code', 'کد پلن', ltr: true, initial: 'basic'),
      ],
      validate: (v) {
        if (!slugRe.hasMatch(v.text('slug'))) {
          return 'نشانی کوتاه باید ۳ تا ۴۰ نویسهٔ لاتین کوچک، رقم یا - باشد.';
        }
        if (v.text('display_name').length < 2) return 'نام مدرسه را وارد کنید.';
        if (v.text('manager_name').length < 2) return 'نام مدیر را وارد کنید.';
        return v.text('plan_code').isEmpty ? 'کد پلن را وارد کنید.' : null;
      },
    );
    if (d == null || !mounted) return;
    final slug = d.text('slug');
    final op = _provisionOps.putIfAbsent(slug, requestId);
    final r = await api.createSchool(
      provisionOpId: op,
      slug: slug,
      displayName: d.text('display_name'),
      managerName: d.text('manager_name'),
      planCode: d.text('plan_code'),
      reason: d.reason,
    );
    if (!mounted) return;
    if (!r.ok) {
      scope.flash(false, r.message);
      await reload();
      return;
    }
    _provisionOps.remove(slug);
    final m = r.object('manager') ?? const {};
    scope.flash(
      true,
      r.body?['idempotent'] == true
          ? 'این مدرسه قبلاً با همین درخواست ساخته شده بود.'
          : 'مدرسه ساخته شد.',
    );
    await reload();
    final code = m['activation_code'];
    if (code is String && code.isNotEmpty && mounted) {
      await showActivationCodeOnce(context, slug, code);
    }
  }

  @override
  Widget build(BuildContext context) {
    final sid = scope.session.claims.sub;
    final dels = _dels;
    final open = <String, Map<String, Object?>>{};
    final delRows = dels != null && dels.ok
        ? dels.list('requests')
        : const <Map<String, Object?>>[];
    for (final x in delRows) {
      if (x['status'] == 'pending' || x['status'] == 'approved') {
        open['${x['tenant_id']}'] = x;
      }
    }
    final tenants = listBox(
      _tenants,
      'tenants',
      loadingText: 'در حال دریافت مدارس…',
      emptyText: 'هنوز مدرسه‌ای ثبت نشده است.',
      build: (rows) => OwnerTable(
        columns: const ['مدرسه', 'پلن', 'وضعیت', 'پایان اشتراک', 'عملیات'],
        rows: [
          for (final t in rows)
            [
              Code(shortId(t['tenant_id']), full: '${t['tenant_id']}'),
              '${t['plan_code'] ?? '—'}',
              Status(t['status']),
              faDate(t['ends_at']),
              _tenantActions(t, open),
            ],
        ],
      ),
    );
    Widget? delBox;
    if (caps.deleteRequest) {
      if (loading || dels == null) {
        delBox = const StateBox.loading('در حال دریافت درخواست‌های حذف…');
      } else if (!dels.ok) {
        delBox = StateBox.error(dels.message);
      } else if (delRows.isEmpty) {
        delBox = const StateBox.empty('درخواست حذفی ثبت نشده است.');
      } else {
        final now = scope.now();
        delBox = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            OwnerTable(
              columns: const [
                'مدرسه',
                'وضعیت',
                'درخواست',
                'تأیید',
                'اجرا از',
                'نگهداری داده تا',
                'عملیات',
              ],
              rows: [
                for (final x in delRows)
                  [
                    Code(shortId(x['tenant_id']), full: '${x['tenant_id']}'),
                    Status(x['status']),
                    faDate(x['created_at']),
                    faDate(x['approved_at']),
                    faDate(x['not_before']),
                    faDate(x['retain_until']),
                    _deletionActions(x, sid, now),
                  ],
              ],
            ),
            const Notice(
              'اجرا یعنی توقف سرویس و لغو اشتراک؛ داده دست‌کم ۱۸۰ روز نگه داشته می‌شود و هیچ داده‌ای از این پنل نابود نمی‌شود.',
            ),
          ],
        );
      }
    }
    return PageList(
      onRefresh: reload,
      children: [
        PayeshSection(
          title: 'فهرست مدارس',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (caps.createSchool)
                ActionRow([
                  actionButton(
                    'create-school',
                    'ساخت مدرسه',
                    _createSchool,
                    primary: true,
                  ),
                ]),
              const SizedBox(height: 8),
              tenants,
            ],
          ),
        ),
        if (delBox != null)
          PayeshSection(
            title: 'درخواست‌های حذف مدرسه (چهارچشمی + ۲۴ ساعت)',
            child: delBox,
          ),
      ],
    );
  }

  Widget _tenantActions(
    Map<String, Object?> t,
    Map<String, Map<String, Object?>> open,
  ) {
    final tid = '${t['tenant_id']}';
    final st = t['status'];
    final acts = <Widget>[
      if (caps.suspend && st != 'suspended' && st != 'canceled')
        actionButton('suspend-$tid', 'تعلیق', () => _suspend(t)),
      if (caps.deleteRequest && open[tid] != null)
        Pill(
          'درخواست حذف باز',
          key: Key('deletion-open-$tid'),
          tone: PayeshTone.warning,
        )
      else if (caps.deleteRequest && st != 'canceled')
        actionButton(
          'delete-request-$tid',
          'درخواست حذف',
          () => _requestDeletion(t),
          danger: true,
        ),
    ];
    return acts.isEmpty ? const Pill('فقط مشاهده') : ActionRow(acts);
  }

  Widget _deletionActions(Map<String, Object?> x, String sid, DateTime now) {
    final id = '${x['id']}';
    final st = x['status'];
    final mine = x['requested_by'] == sid;
    final acts = <Widget>[];
    if (st == 'pending' && !mine) {
      acts.add(
        actionButton(
          'deletion-approve-$id',
          'تأیید (مالک دوم)',
          () => _approve(x),
          primary: true,
        ),
      );
    }
    if (st == 'pending' && mine) {
      acts.add(
        Pill('منتظر تأیید مالک دیگر', key: Key('wait-second-owner-$id')),
      );
    }
    if (st == 'approved') {
      final nb = DateTime.tryParse('${x['not_before']}');
      if (nb != null && !nb.isAfter(now)) {
        acts.add(
          actionButton(
            'deletion-execute-$id',
            'اجرا',
            () => _execute(x),
            danger: true,
          ),
        );
      } else {
        acts.add(
          Pill('مهلت ۲۴ ساعته در جریان است', key: Key('wait-delay-$id')),
        );
      }
    }
    if (st == 'pending' || st == 'approved') {
      acts.add(actionButton('deletion-cancel-$id', 'لغو', () => _cancel(x)));
    }
    return acts.isEmpty ? const Text('—') : ActionRow(acts);
  }
}

/// The manager's activation code: shown once, in this dialog only — never persisted,
/// never put in a flash message, log or report.
Future<void> showActivationCodeOnce(
  BuildContext context,
  String slug,
  String code,
) => showDialog<void>(
  context: context,
  barrierDismissible: false,
  builder: (ctx) => AlertDialog(
    title: Text('کد فعال‌سازی مدیر مدرسهٔ $slug'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'این کد فقط همین یک بار نمایش داده می‌شود و در هیچ جای برنامه ذخیره نمی‌شود. آن را از راهی امن به مدیر مدرسه بدهید.',
        ),
        const SizedBox(height: 12),
        Directionality(
          textDirection: TextDirection.ltr,
          child: SelectableText(
            code,
            key: const Key('activation-code'),
            style: const TextStyle(fontFamily: 'monospace', fontSize: 20),
          ),
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Clipboard.setData(ClipboardData(text: code)),
        child: const Text('رونوشت'),
      ),
      FilledButton(
        key: const Key('once-close'),
        onPressed: () => Navigator.of(ctx).pop(),
        child: const Text('یادداشت کردم، بستن'),
      ),
    ],
  ),
);
