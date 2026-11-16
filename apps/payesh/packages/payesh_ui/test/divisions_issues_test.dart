// ردیف ۱۶۶: استان ⇒ شهرستان‌ها (بدون تایپ دستی) و قاب قرمز کادرهای نادرست.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  test('۳۱ استان و ۴۸۴ شهرستان؛ هر استان دست‌کم یک شهرستان', () {
    expect(iranProvinceNames.length, 31);
    var n = 0;
    for (final p in iranProvinceNames) {
      final c = iranCountiesOf(p);
      expect(c, isNotEmpty, reason: p);
      expect(c.toSet().length, c.length, reason: '$p بدون تکرار');
      n += c.length;
    }
    expect(n, 484);
    expect(iranCountiesOf('آذربایجان شرقی'), containsAll(['تبریز', 'مراغه']));
    expect(iranCountiesOf('خراسان رضوی'), containsAll(['مشهد', 'نیشابور']));
    expect(iranCountiesOf('تهران'), contains('تهران'));
    expect(iranCountiesOf('ناشناخته'), isEmpty);
    expect(iranCountiesOf(null), isEmpty);
  });

  test('FieldIssues: تنظیم، پاک‌کردن، حدس از پیام کلی', () {
    final f = FieldIssues();
    var ticks = 0;
    f.addListener(() => ticks++);
    f.setAll({'a': 'x', 'b': 'y'});
    expect(f.of('a'), 'x');
    f.clear('a');
    expect(f.has('a'), isFalse);
    f.clear('a');
    expect(ticks, 2);
    final g = FieldIssues.guess('تلفن همراه رابط باید ۱۱ رقم باشد', {
      'name': (label: 'نام مدرسه *', value: ''),
      'phone': (label: 'تلفن همراه رابط', value: '12'),
      'mobile': (label: 'تلفن همراه', value: '12'),
      'note': (label: 'توضیح', value: ''),
    });
    expect(g.keys.toSet(), {'name', 'phone'});
    expect(g['name'], 'این کادر را پر کنید');
    expect(g['phone'], checkFieldFa, reason: 'no duplicate of the summary');
    expect(FieldIssues.plainLabel('شهرستان (منطقه) *'), 'شهرستان');
    expect(
      FieldIssues.guess('نام کاربری یا رمز عبور نادرست است', {
        'u': (label: 'نام کاربری', value: 'a'),
        'p': (label: 'رمز عبور', value: 'b'),
        's': (label: 'نشانی سرور', value: 'c'),
      }).keys.toSet(),
      {'u', 'p'},
    );
    expect(
      FieldIssues.guess('نام کاربری، شمارهٔ همراه یا کد ملی را درست بنویسید', {
        'login': (label: 'شمارهٔ همراه، کد ملی یا نام کاربری', value: '09'),
        'pw': (label: 'رمز عبور', value: 'x'),
      }).keys.toSet(),
      {'login'},
      reason: 'a label of alternatives',
    );
  });

  testWidgets('FieldIssueScope ⇒ errorText ⇒ قاب قرمز', (t) async {
    final f = FieldIssues();
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FieldIssueScope(
            issues: f,
            child: Builder(
              builder: (c) => TextField(
                key: const Key('x'),
                decoration: InputDecoration(errorText: fieldIssue(c, 'x')),
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('غلط'), findsNothing);
    f.set('x', 'غلط');
    await t.pump();
    expect(find.text('غلط'), findsOneWidget);
    final deco = t.widget<TextField>(find.byKey(const Key('x'))).decoration!;
    expect(deco.errorText, 'غلط');
  });
}
