import 'dart:math' as math;
import 'dart:ui' show Color;

double _lin(double c) =>
    c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();

/// WCAG 2.x relative luminance.
double relativeLuminance(Color c) =>
    0.2126 * _lin(c.r) + 0.7152 * _lin(c.g) + 0.0722 * _lin(c.b);

/// WCAG 2.x contrast ratio (1 … 21).
double contrastRatio(Color a, Color b) {
  final la = relativeLuminance(a), lb = relativeLuminance(b);
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

/// AA for normal text.
const double wcagAA = 4.5;

/// AA for large text and UI components (borders, icons, focus rings).
const double wcagAALarge = 3.0;
