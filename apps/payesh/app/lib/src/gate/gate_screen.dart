// Row 197 (Q06 / F38, F44) — «درِ مدرسه»: the guard's page. Today's visitors (in / out) and the
// students who may leave early today with an approved leave. Opens for the manager and for a
// guard whose «درِ مدرسه» area is open (the guard's default — staff_access.dart).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';

class GateController extends SchoolController {
  GateController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<VisitorRow> visitors = const [];
  List<EarlyExit> exits = const [];

  int get inside => visitors.where((v) => v.inside).length;

  @override
  Future<void> read(SchoolRecords db) async {
    final g = GateBook(db);
    visitors = await g.today();
    exits = await g.earlyExits();
  }

  Future<bool> checkIn({
    required String name,
    String phone = '',
    String reason = '',
    String host = '',
  }) async {
    if (name.trim().isEmpty) {
      formError = visitorIssueFa['visitor_name'];
      emit();
      return false;
    }
    final r = await run(
      (db) =>
          GateBook(db)
              .checkIn(name: name, phone: phone, reason: reason, host: host),
      form: true,
    );
    return r != null;
  }

  Future<void> checkOut(VisitorRow v) => run((db) => GateBook(db).checkOut(v));
}

/// «۰۹:۳۰» from an ISO instant, in Tehran time (UTC+3:30, no DST since 1401).
String gateClockFa(String iso) {
  final t = DateTime.tryParse(iso);
  if (t == null) return '';
  final l = t.toUtc().add(const Duration(hours: 3, minutes: 30));
  String two(int v) => v.toString().padLeft(2, '0');
  return Web.fa('${two(l.hour)}:${two(l.minute)}');
}

class GateScreen extends StatefulWidget {
  const GateScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final GateController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<GateScreen> createState() => _GateScreenState();
}

class _GateScreenState extends State<GateScreen> {
  GateController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _add() async {
    c.clearForm();
    await openPanel<void>(context, (_) => _VisitorForm(controller: c));
  }

  Future<void> _out(VisitorRow v) async {
    final ok = await confirmAction(
      context,
      prefix: 'gate',
      title: 'ثبت خروج',
      message: 'خروج «${v.name}» همین حالا ثبت شود؟',
    );
    if (ok) await c.checkOut(v);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'gate',
      title: 'درِ مدرسه',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub:
          '${Web.fa(c.inside)} مراجع داخل مدرسه · ${Web.fa(c.exits.length)} خروج با مرخصی امروز',
      subKey: const Key('gate-count'),
      headActions: [
        WebBtn(
          '+ ثبت ورود مراجع',
          key: const Key('gate-add'),
          kind: WebBtnKind.primary,
          onPressed: _add,
        ),
      ],
      children: [
        const WebCardHead(
          key: Key('gate-exits-head'),
          icon: '🚪',
          title: 'خروج زودهنگام با مرخصی تأییدشده — امروز',
        ),
        if (c.exits.isEmpty)
          const WebEmpty(
            'امروز هیچ دانش‌آموزی مرخصی تأییدشده ندارد.',
            key: Key('gate-exits-empty'),
          )
        else
          for (final e in c.exits)
            WebCard.tight(
              key: Key('gate-exit-${e.leaveId}'),
              child: WebItem(
                title: e.student.isEmpty
                    ? 'دانش‌آموز ${Web.fa(e.studentId ?? 0)}'
                    : e.student,
                titleTrailing: [
                  WebBadge(
                    e.hours
                        ? 'ساعت ${Web.fa(e.timeFrom)} تا ${Web.fa(e.timeTo)}'
                        : 'تمام روز',
                    tone: e.hours ? WebTone.amber : WebTone.purple,
                  ),
                ],
                // row 204: the name alone — «دهم الکترونیک» of a field school is no «کلاس»
                sub: e.className.isEmpty ? null : e.className,
              ),
            ),
        const WebCardHead(
          key: Key('gate-visitors-head'),
          icon: '🧾',
          title: 'مراجعین امروز',
        ),
        if (c.visitors.isEmpty)
          const WebEmpty(
            'امروز هنوز مراجعی ثبت نشده است.',
            key: Key('gate-visitors-empty'),
          )
        else
          for (final v in c.visitors)
            WebCard.tight(
              key: Key('gate-visitor-${v.id}'),
              child: WebItem(
                title: v.name,
                titleTrailing: [
                  WebBadge(
                    v.inside ? 'داخل مدرسه' : 'خارج شد',
                    tone: v.inside ? WebTone.amber : WebTone.green,
                  ),
                  if (v.queued) const WebBadge('در صف ارسال'),
                ],
                sub: [
                  'ورود ${gateClockFa(v.inAt)}${v.inside ? '' : ' · خروج ${gateClockFa(v.outAt)}'}',
                  if (v.host.isNotEmpty) 'نزد: ${v.host}',
                  if (v.reason.isNotEmpty) v.reason,
                  if (v.phone.isNotEmpty) Web.fa(v.phone),
                ].join('\n'),
                actions: [
                  if (v.inside)
                    WebBtn(
                      'ثبت خروج',
                      key: Key('gate-out-${v.id}'),
                      kind: WebBtnKind.primary,
                      onPressed: () => _out(v),
                    ),
                ],
              ),
            ),
      ],
    ),
  );
}

class _VisitorForm extends StatefulWidget {
  const _VisitorForm({required this.controller});
  final GateController controller;

  @override
  State<_VisitorForm> createState() => _VisitorFormState();
}

class _VisitorFormState extends State<_VisitorForm> {
  final name = TextEditingController();
  final phone = TextEditingController();
  final host = TextEditingController();
  final reason = TextEditingController();

  @override
  void dispose() {
    for (final x in [name, phone, host, reason]) {
      x.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final ok = await widget.controller.checkIn(
      name: name.text,
      phone: phone.text,
      host: host.text,
      reason: reason.text,
    );
    if (ok && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => SchoolForm(
        prefix: 'gate',
        title: 'ثبت ورود مراجع',
        controller: c,
        submitLabel: 'ثبت ورود',
        onSubmit: _save,
        fields: [
          SchoolField('gate-f-name', 'نام و نام خانوادگی *', name),
          SchoolField('gate-f-phone', 'شمارهٔ تماس', phone),
          SchoolField('gate-f-host', 'نزد چه کسی (مثلاً معاون، دفتر)', host),
          SchoolField('gate-f-reason', 'علت مراجعه', reason, lines: 2),
        ],
      ),
    );
  }
}
