import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// ISO timestamp → Jalali date + local time with Persian digits; `—` when empty/unreadable.
String faDate(Object? iso) {
  if (iso == null || iso == '') return '—';
  final d = DateTime.tryParse('$iso');
  if (d == null) return '—';
  final l = d.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  final day = jalaliText(
    '${l.year.toString().padLeft(4, '0')}-${two(l.month)}-${two(l.day)}',
  );
  if (day == '—') return '—';
  return '$day، ساعت ${faDigits('${two(l.hour)}:${two(l.minute)}')}';
}

/// Web badge tone (`ok`/`info`/`warn`/`bad`/'') → design-system tone.
PayeshTone toneOf(String t) => switch (t) {
  'ok' => PayeshTone.success,
  'info' => PayeshTone.info,
  'warn' => PayeshTone.warning,
  'bad' => PayeshTone.danger,
  _ => PayeshTone.neutral,
};

/// Status badge text + tone (same labels as the web panel).
(String, PayeshTone) statusBadge(Object? status) {
  final (l, t) = statusLabel(status);
  return (l, toneOf(t));
}
