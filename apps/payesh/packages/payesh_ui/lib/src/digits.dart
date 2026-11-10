const String _fa = '۰۱۲۳۴۵۶۷۸۹';
const String _ar = '٠١٢٣٤٥٦٧٨٩';

/// Latin 0–9 → Persian ۰–۹ (same as the web client's `fa()`); everything else unchanged.
String faDigits(Object? value) {
  final s = value == null ? '' : '$value';
  final b = StringBuffer();
  for (final r in s.runes) {
    b.writeCharCode(r >= 0x30 && r <= 0x39 ? _fa.codeUnitAt(r - 0x30) : r);
  }
  return b.toString();
}

/// Persian ۰–۹ and Arabic-Indic ٠–٩ → Latin 0–9 (the web client's `norm()`), for parsing input.
String latinDigits(Object? value) {
  final s = value == null ? '' : '$value';
  final b = StringBuffer();
  for (final c in s.codeUnits) {
    final f = _fa.codeUnits.indexOf(c);
    final a = _ar.codeUnits.indexOf(c);
    b.writeCharCode(f >= 0 ? 0x30 + f : (a >= 0 ? 0x30 + a : c));
  }
  return b.toString();
}

/// Integer with Persian digits and the Persian thousands separator (٬), e.g. ۱٬۲۳۴٬۵۶۷.
String faNumber(int n) {
  final neg = n < 0;
  final s = n.abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write('٬');
    b.write(s[i]);
  }
  return '${neg ? '−' : ''}${faDigits(b)}';
}
