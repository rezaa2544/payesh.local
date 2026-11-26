// ردیف ۱۹۷ (Q02 / F25): بخش مشترک فرم مرخصی — ولی («درخواست مرخصی») و مدیر/معاون («ثبت مرخصی»).
// روزانه (از تاریخ / تا تاریخ) یا ساعتی (تاریخ + از ساعت / تا ساعت)، نوع مرخصی، توضیح و پیوست
// گواهی (عکس فشرده). قواعد در packages/payesh_sync/lib/src/leave_spec.dart است.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../platform/file_pick.dart';
import '../pulse/web.dart';
import 'family_controller.dart' show jalaliToIso;

/// آنچه کاربر در فرم نوشته — بی‌وابسته به ویجت، تا آزمون‌ها مستقیم بخوانند.
class LeaveDraft extends ChangeNotifier {
  LeaveDraft({required String todayJalali})
    : from = TextEditingController(text: todayJalali);

  String kind = 'day';
  final TextEditingController from;
  final TextEditingController to = TextEditingController();
  final TextEditingController timeFrom = TextEditingController(text: '10:00');
  final TextEditingController timeTo = TextEditingController(text: '12:00');
  final TextEditingController reason = TextEditingController();
  String? type;
  String? attachment;

  bool get dirty =>
      reason.text.trim().isNotEmpty ||
      to.text.trim().isNotEmpty ||
      type != null ||
      attachment != null;

  void setKind(String k) {
    kind = k;
    notifyListeners();
  }

  void setType(String? t) {
    type = t;
    notifyListeners();
  }

  void setAttachment(String? a) {
    attachment = a;
    notifyListeners();
  }

  static String _ascii(String s) {
    const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
    return s.replaceAllMapped(RegExp('[۰-۹٠-٩]'), (m) {
      final i = fa.indexOf(m[0]!);
      return '${i >= 0 ? i : ar.indexOf(m[0]!)}';
    });
  }

  /// «۹:۵» / «09:05» / «۰۹:۰۵» → «09:05»؛ هر چیز دیگر همان‌طور می‌ماند تا قاعده رد کند.
  static String hhmm(String s) {
    final t = _ascii(s.trim()).replaceAll('.', ':');
    // «۱۰» به‌تنهایی = ۱۰:۰۰ (کاربر معمولاً فقط ساعت را می‌نویسد)
    if (RegExp(r'^\d{1,2}$').hasMatch(t)) return '${t.padLeft(2, '0')}:00';
    final m = RegExp(r'^(\d{1,2}):(\d{1,2})$').firstMatch(t);
    if (m == null) return t;
    return '${m[1]!.padLeft(2, '0')}:${m[2]!.padLeft(2, '0')}';
  }

  /// ISO روز شروع (null = تاریخ نادرست).
  String? get fromIso => jalaliToIso(from.text);

  /// ISO روز پایان: خالی = همان روز؛ null = تاریخ نادرست.
  String? get toIso => to.text.trim().isEmpty ? '' : jalaliToIso(to.text);

  /// کد خطای قاعده یا null.
  String? issue() {
    final f = fromIso;
    if (f == null) return 'bad_date';
    final t = toIso;
    if (kind == 'day' && t == null) return 'bad_date';
    return leaveIssue({
      'date': f,
      if (kind == 'hours') 'kind': 'hours',
      if (kind == 'day' && (t ?? '').isNotEmpty) 'date_to': t,
      if (kind == 'hours') 'time_from': hhmm(timeFrom.text),
      if (kind == 'hours') 'time_to': hhmm(timeTo.text),
      'type': ?type,
      'reason': reason.text.trim(),
      'attachment': ?attachment,
    });
  }

  @override
  void dispose() {
    for (final c in [from, to, timeFrom, timeTo, reason]) {
      c.dispose();
    }
    super.dispose();
  }
}

/// فیلدهای فرم مرخصی. [prefix] پیشوند کلیدها (`lvf` ولی، `lvm` مدیر).
class LeaveFields extends StatefulWidget {
  const LeaveFields({
    super.key,
    required this.draft,
    required this.prefix,
    this.error,
    this.pick,
  });

  final LeaveDraft draft;
  final String prefix;

  /// خطای فعلی فرم (برای قرمز کردن فیلد مربوط).
  final String? error;

  /// انتخاب عکس — آزمون‌ها جایگزین می‌کنند؛ پیش‌فرض [pickLeaveImage].
  final Future<String?> Function()? pick;

  @override
  State<LeaveFields> createState() => _LeaveFieldsState();
}

class _LeaveFieldsState extends State<LeaveFields> {
  LeaveDraft get d => widget.draft;
  String get p => widget.prefix;
  String? _pickError;

  Future<void> _pick() async {
    setState(() => _pickError = null);
    try {
      final uri = await (widget.pick ?? pickLeaveImage)();
      if (uri != null) d.setAttachment(uri);
    } on FilePickFailure catch (e) {
      setState(() => _pickError = e.messageFa);
    }
  }

  bool _err(List<String> codes) =>
      widget.error != null && codes.any((c) => widget.error == leaveIssueFa(c));

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: d,
    builder: (context, _) {
      final hours = d.kind == 'hours';
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<String>(
              key: Key('$p-kind'),
              isExpanded: true,
              initialValue: d.kind,
              decoration: const InputDecoration(labelText: 'نوع مرخصی'),
              items: [
                for (final e in leaveKindsFa.entries)
                  DropdownMenuItem(value: e.key, child: Text(e.value)),
              ],
              onChanged: (v) => d.setKind(v ?? 'day'),
            ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          FieldBox(
            width: kFieldDigits,
            child: TextField(
              key: Key('$p-date'),
              controller: d.from,
              keyboardType: TextInputType.datetime,
              decoration: InputDecoration(
                labelText: hours ? 'تاریخ شمسی' : 'از تاریخ',
                hintText: '۱۴۰۵/۰۸/۲۱',
                errorText: _err(['bad_date']) && d.fromIso == null
                    ? checkFieldFa
                    : null,
              ),
            ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          if (!hours)
            FieldBox(
              width: kFieldDigits,
              child: TextField(
                key: Key('$p-date-to'),
                controller: d.to,
                keyboardType: TextInputType.datetime,
                decoration: InputDecoration(
                  labelText: 'تا تاریخ (برای چند روز)',
                  hintText: 'خالی = همان روز',
                  errorText:
                      _err(['bad_range', 'range_too_long']) ||
                          (_err(['bad_date']) && d.toIso == null)
                      ? checkFieldFa
                      : null,
                ),
              ),
            )
          else
            WebWrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                for (final (k, label, c) in [
                  ('time-from', 'از ساعت', d.timeFrom),
                  ('time-to', 'تا ساعت', d.timeTo),
                ])
                  FieldBox(
                    width: kFieldFilter,
                    child: TextField(
                      key: Key('$p-$k'),
                      controller: c,
                      keyboardType: TextInputType.datetime,
                      textDirection: TextDirection.ltr,
                      decoration: InputDecoration(
                        labelText: label,
                        hintText: '۱۰:۳۰',
                        errorText: _err(['bad_time']) ? checkFieldFa : null,
                      ),
                    ),
                  ),
              ],
            ),
          const SizedBox(height: PayeshTokens.space3),
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<String?>(
              key: Key('$p-type'),
              isExpanded: true,
              initialValue: d.type,
              decoration: const InputDecoration(labelText: 'علت مرخصی'),
              items: [
                const DropdownMenuItem<String?>(child: Text('— انتخاب —')),
                for (final e in leaveTypesFa.entries)
                  DropdownMenuItem<String?>(value: e.key, child: Text(e.value)),
              ],
              onChanged: d.setType,
            ),
          ),
          const SizedBox(height: PayeshTokens.space3),
          TextField(
            key: Key('$p-reason'),
            controller: d.reason,
            minLines: 2,
            maxLines: 5,
            maxLength: leaveReasonMax,
            decoration: const InputDecoration(
              labelText: 'توضیح',
              hintText: 'مثلاً مراجعه به پزشک',
            ),
          ),
          const SizedBox(height: PayeshTokens.space2),
          WebWrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              WebBtn(
                d.attachment == null ? '📎 پیوست گواهی (عکس)' : '📎 تعویض عکس',
                key: Key('$p-attach'),
                onPressed: _pick,
              ),
              if (d.attachment != null) ...[
                WebBadge(
                  'عکس پیوست شد · ${faNumber((d.attachment!.length * 3 / 4 / 1024).ceil())} کیلوبایت',
                  key: Key('$p-attach-ok'),
                  tone: WebTone.green,
                ),
                WebBtn(
                  'برداشتن',
                  key: Key('$p-attach-clear'),
                  kind: WebBtnKind.ghost,
                  onPressed: () => d.setAttachment(null),
                ),
              ],
            ],
          ),
          if (_pickError != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                _pickError!,
                key: Key('$p-attach-error'),
                style: TextStyle(color: Web.red, fontSize: 12.5),
              ),
            ),
        ],
      );
    },
  );
}

/// نمایش عکس گواهی پیوست (مدیر و ولی).
Future<void> showLeaveAttachment(
  BuildContext context,
  String title,
  List<int>? bytes,
) => showDialog<void>(
  context: context,
  builder: (ctx) => AlertDialog(
    key: const Key('lv-att-dialog'),
    title: Text(title),
    content: bytes == null
        ? const Text('پیوست خوانده نشد.')
        : InteractiveViewer(
            child: Image.memory(
              Uint8List.fromList(bytes),
              key: const Key('lv-att-image'),
              errorBuilder: (_, _, _) => const Text('پیوست خوانده نشد.'),
            ),
          ),
    actions: [
      TextButton(
        key: const Key('lv-att-close'),
        onPressed: () => Navigator.pop(ctx),
        child: const Text('بستن'),
      ),
    ],
  ),
);
