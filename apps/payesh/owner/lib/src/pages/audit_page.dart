import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../format.dart';
import '../widgets.dart';
import 'base.dart';

class AuditPage extends StatefulWidget {
  const AuditPage({super.key});
  @override
  State<AuditPage> createState() => _AuditPageState();
}

class _AuditPageState extends OwnerPageState<AuditPage> {
  ApiResult? _r;

  @override
  Future<void> load() async => _r = await api.audit();

  @override
  Widget build(BuildContext context) {
    final content = listBox(
      _r,
      'events',
      loadingText: 'در حال دریافت رویدادها…',
      emptyText: 'هنوز رویدادی ثبت نشده است.',
      build: (ev) {
        final broken = auditChainBreaks(ev);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: Pill(
                broken > 0
                    ? 'گسست در زنجیرهٔ هش: ${faNum(broken)}'
                    : 'پیوستگی زنجیرهٔ رویدادهای نمایش‌داده‌شده برقرار است',
                key: Key(broken > 0 ? 'chain-broken' : 'chain-continuous'),
                tone: broken > 0 ? PayeshTone.danger : PayeshTone.success,
              ),
            ),
            const SizedBox(height: 8),
            OwnerTable(
              columns: const [
                '#',
                'زمان',
                'عمل',
                'عامل',
                'موضوع',
                'دلیل',
                'هش',
              ],
              rows: [
                for (final e in ev)
                  [
                    faNum(e['sequence_id']),
                    faDate(e['created_at']),
                    Code('${e['action']}'),
                    Code(shortId(e['actor_ref']), full: '${e['actor_ref']}'),
                    '${e['subject_type'] ?? ''} ${shortId(e['subject_ref'])}',
                    '${e['reason'] ?? '—'}',
                    Code(
                      '${e['event_hash'] ?? ''}'.length > 12
                          ? '${e['event_hash']}'.substring(0, 12)
                          : '${e['event_hash'] ?? ''}',
                      full: '${e['event_hash'] ?? ''}',
                    ),
                  ],
              ],
            ),
            const Notice(
              'بررسی پیوستگی در برنامه فقط نشانگر است؛ بازمحاسبهٔ معتبر هش در آزمون سرور انجام می‌شود.',
            ),
          ],
        );
      },
    );
    return PageList(
      onRefresh: reload,
      children: [PayeshSection(title: 'دفتر ممیزی زنجیره‌هش', child: content)],
    );
  }
}
