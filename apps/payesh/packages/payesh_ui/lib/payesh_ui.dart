/// Payesh native design system (ADR-43 / row 73).
///
/// * ISO dates are stored; Jalali is display-only ([JalaliDate], [jalaliText]).
/// * Persian digits on screen ([faDigits]); [latinDigits] normalises user input.
/// * Light/dark Material 3 themes built from the same tokens as the web client.
/// * Right-to-left everywhere ([PayeshUi.locale] = fa-IR), bundled Vazirmatn (OFL-1.1).
library;

export 'src/a11y.dart';
export 'src/digits.dart';
export 'src/jalali.dart';
export 'src/theme.dart';
export 'src/tokens.dart';
export 'src/widgets.dart';
