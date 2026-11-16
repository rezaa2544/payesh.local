// ایراد هر کادر فرم پس از «ثبت» (ردیف ۱۶۶، خواستهٔ مالک):
// «بعد از تکمیل فرم، کادرهایی که مشکل دارند باید دورشان قرمز شود تا کاربر بفهمد کدام قسمت
// را دوباره بررسی کند — در تمام قسمت‌های برنامه و برای همهٔ کاربرها».
//
// • [FieldIssues] نگه‌دارندهٔ «نام کادر ← پیام» یک فرم است؛ کادر با [FieldIssueScope] و
//   [fieldIssue] پیام خودش را می‌خواند و آن را در `errorText` می‌گذارد ⇒ قاب قرمز + پیام زیر کادر.
// • فرم‌هایی که اعتبارسنجی‌شان کادر را می‌شناسد، مستقیم [FieldIssues.setAll] می‌کنند.
// • برای پیام‌های قدیمی که فقط یک جمله‌اند (مثلاً پاسخ دستگاه)، [FieldIssues.guess] کادرهای
//   ستاره‌دار خالی و کادری را که نامش در پیام آمده پیدا می‌کند تا هیچ خطایی بی‌نشانی نماند.
// • با نوشتن در یک کادر، قرمزی همان کادر برداشته می‌شود ([FieldIssues.clear]).

import 'package:flutter/material.dart';

/// پیام بالای فرم وقتی چند کادر قرمز شده‌اند.
String fieldsToFixFa(int n) => n <= 1
    ? 'کادرِ قرمز را بررسی و اصلاح کنید'
    : 'کادرهای قرمز را بررسی و اصلاح کنید';

/// یک کادر فرم برای [FieldIssues.guess]: برچسب (با «*» یعنی الزامی) و مقدار فعلی.
/// Under a field the general message names: a short pointer to the message above the form.
const String checkFieldFa = 'این کادر را بررسی و اصلاح کنید';

typedef FieldInfo = ({String label, String value});

/// ایرادهای کادرهای یک فرم (نام کادر ← پیام).
class FieldIssues extends ChangeNotifier {
  FieldIssues([Map<String, String>? initial]) {
    if (initial != null) _m.addAll(initial);
  }

  final Map<String, String> _m = {};

  /// کادرهای ثبت‌شدهٔ فرم (برای [guessFrom]): نام ⇒ برچسب و مقدار فعلی.
  final Map<String, FieldInfo Function()> _fields = {};

  /// کادر خودش را معرفی می‌کند تا پیام کلیِ فرم به آن نسبت داده شود.
  void register(String key, FieldInfo Function() info) => _fields[key] = info;

  /// [guess] روی کادرهای ثبت‌شده؛ نتیجه جای ایرادهای قبلی می‌نشیند. تعداد کادرهای قرمز.
  int guessFrom(String? message) {
    if (message == null || message.isEmpty) {
      clearAll();
      return 0;
    }
    final infos = <String, FieldInfo>{};
    for (final e in _fields.entries) {
      try {
        infos[e.key] = e.value();
      } on Object {
        // a field that left the form (disposed controller): ignored
      }
    }
    setAll(guess(message, infos));
    return _m.length;
  }

  /// پیام کادر [key] یا null.
  String? of(String key) => _m[key];

  bool has(String key) => _m.containsKey(key);
  bool get isEmpty => _m.isEmpty;
  bool get isNotEmpty => _m.isNotEmpty;
  Map<String, String> get all => Map.unmodifiable(_m);

  /// همهٔ ایرادهای تازهٔ فرم (ایرادهای قبلی پاک می‌شوند).
  void setAll(Map<String, String> issues) {
    _m
      ..clear()
      ..addAll(issues);
    notifyListeners();
  }

  /// ایراد یک کادر (مثلاً پاسخ دستگاه دربارهٔ همان کادر).
  void set(String key, String message) {
    _m[key] = message;
    notifyListeners();
  }

  /// کاربر کادر را اصلاح کرد ⇒ قرمزی همان کادر برداشته می‌شود.
  void clear(String key) {
    if (_m.remove(key) != null) notifyListeners();
  }

  void clearAll() {
    if (_m.isEmpty) return;
    _m.clear();
    notifyListeners();
  }

  /// برچسب بی‌ستاره و بی‌توضیح پرانتزی: «نام مدرسه *» ⇒ «نام مدرسه».
  static String plainLabel(String label) => label
      .replaceAll(RegExp(r'\([^)]*\)'), ' ')
      .replaceAll('*', ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  static String _norm(String s) => s
      .replaceAll('ي', 'ی')
      .replaceAll('ك', 'ک')
      .replaceAll('\u200c', ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  /// کادرهای مربوط به یک پیام کلی (برای فرم‌هایی که اعتبارسنجی‌شان کادر را نمی‌گوید):
  ///  ۱) هر کادر الزامی («*» در برچسب) که خالی مانده؛
  ///  ۲) هر کادری که نامش در پیام آمده (نامی که فقط بخشی از نام بلندترِ آمده است کنار می‌رود:
  ///     «تلفن همراه رابط» نه «تلفن همراه»). اگر هیچ کادری پیدا نشد، نقشه خالی است و پیام بالای
  ///     فرم می‌ماند.
  static Map<String, String> guess(
    String message,
    Map<String, FieldInfo> fields,
  ) {
    final out = <String, String>{};
    for (final e in fields.entries) {
      if (e.value.label.contains('*') && e.value.value.trim().isEmpty) {
        out[e.key] = 'این کادر را پر کنید';
      }
    }
    final msg = _norm(message);
    // every field named in the message, except a name that is only part of a longer named one
    // («تلفن همراه» inside «تلفن همراه رابط»)
    final named = <String, String>{};
    for (final e in fields.entries) {
      final l = _norm(plainLabel(e.value.label));
      if (l.length >= 2 && msg.contains(l)) {
        named[e.key] = l;
        continue;
      }
      // a label of alternatives («شمارهٔ همراه، کد ملی یا نام کاربری»): any of them named
      for (final part in l.split(RegExp(r'\s*(?:،|,|/| یا )\s*'))) {
        if (part.length >= 4 && part != l && msg.contains(part)) {
          named[e.key] = part;
          break;
        }
      }
    }
    for (final e in named.entries) {
      final shadowed = named.values.any(
        (o) => o != e.value && o.length > e.value.length && o.contains(e.value),
      );
      // the message itself stays above the form; under the field only a short pointer (no
      // duplicate of the summary)
      if (!shadowed) out[e.key] = checkFieldFa;
    }
    return out;
  }
}

/// ایرادهای فرم را به کادرهای زیرش می‌رساند.
class FieldIssueScope extends InheritedNotifier<FieldIssues> {
  const FieldIssueScope({
    super.key,
    required FieldIssues issues,
    required super.child,
  }) : super(notifier: issues);

  static FieldIssues? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<FieldIssueScope>()?.notifier;
}

/// پیام ایراد کادر [key] در نزدیک‌ترین [FieldIssueScope]، یا null.
String? fieldIssue(BuildContext context, String key) =>
    FieldIssueScope.maybeOf(context)?.of(key);

/// Row 166 — a text field outside [SchoolField]-style helpers joins the surrounding
/// [FieldIssueScope]: it is registered (label + current text) and gets its red outline.
/// Pair with [clearFieldIssue] in `onChanged`.
InputDecoration issueDecoration(
  BuildContext context,
  String key,
  TextEditingController c,
  InputDecoration d,
) {
  final issues = FieldIssueScope.maybeOf(context);
  if (issues == null) return d;
  issues.register(key, () => (label: d.labelText ?? '', value: c.text));
  final issue = issues.of(key);
  return issue == null ? d : d.copyWith(errorText: issue, errorMaxLines: 3);
}

/// Typing in a field clears its red outline (see [issueDecoration]).
void clearFieldIssue(BuildContext context, String key) =>
    FieldIssueScope.maybeOf(context)?.clear(key);

/// Row 166 — red outline of one field of a form that shows a single [error] message and keeps no
/// [FieldIssues]: [required] and empty, or named by the message; null otherwise.
String? fieldIssueFor(
  String? error,
  String label,
  String value, {
  bool required = false,
}) => error == null
    ? null
    : FieldIssues.guess(error, {
        'f': (label: required ? '$label *' : label, value: value),
      })['f'];
