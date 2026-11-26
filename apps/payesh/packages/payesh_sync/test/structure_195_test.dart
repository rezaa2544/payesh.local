// ردیف ۱۹۵ — ساختار مدرسه بر پایهٔ مقطع (p2 `26-curriculum.js`، `18-modals.js`، `15-schedule.js`):
// ابتدایی و متوسطه اول «کلاس‌محور» (کلاس ثابت، برنامهٔ هر کلاس جدا)، متوسطه دوم «رشته‌محور»
// (پایه × رشته، محل هر زنگ را مدیر تعیین می‌کند).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> school(
  Map<String, Object?> profile,
) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('schools', 1, {
    'name': 'مدرسه',
    'workdays': [0, 1, 2, 3, 4],
    ...profile,
  });
  await put('subjects', 41, {'name': 'ریاضی', 'weekly_hours': 2});
  await put('subjects', 42, {'name': 'علوم', 'weekly_hours': 1});
  await put('users', 10, {
    'name': 'دبیر ریاضی',
    'role': 'teacher',
    'subject': 'ریاضی',
  });
  await put('users', 11, {
    'name': 'دبیر علوم',
    'role': 'teacher',
    'subject': 'علوم',
  });
  return (e, ob);
}

SchoolRecords db(
  SqliteEngine e,
  SqliteOutbox ob, [
  String role = 'manager',
  int uid = 1,
]) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  random: Random(7),
  now: () => DateTime.utc(2026, 11, 14, 8),
);

Matcher failsWith(String code, [String? text]) => throwsA(
  isA<RecordFailure>()
      .having((f) => f.code, 'code', code)
      .having((f) => f.messageFa, 'msg', contains(text ?? '')),
);

void main() {
  test('S195-U01 مقطع → ساختار: ابتدایی/متوسطه اول کلاس‌محور، متوسطه دوم رشته‌محور؛ پایه و رشتهٔ مجاز', () async {
    expect(levelOf('متوسطهٔ دوم'), 'متوسطه دوم');
    expect(levelOf('متوسطه اول'), 'متوسطه اول');
    expect(levelOf('دبستان'), 'ابتدایی');
    expect(levelOfGrade('نهم'), 'متوسطه اول');
    expect(levelOfGrade('یازدهم'), 'متوسطه دوم');
    for (final (lv, field) in [
      ('ابتدایی', false),
      ('متوسطه اول', false),
      ('متوسطه دوم', true),
    ]) {
      final (e, ob) = await school({'level': lv});
      final s = await SchoolStructure.read(db(e, ob));
      expect(s.fieldBased, field, reason: lv);
      expect(s.grades, levelGrades[lv]);
    }
    final (e, ob) = await school({
      'level': 'متوسطه دوم',
      'branches': ['نظری'],
    });
    final s = await SchoolStructure.read(db(e, ob));
    expect(s.allowedFields, contains('علوم تجربی'));
    expect(s.fieldFits('مکانیک خودرو'), isFalse);
    expect(s.gradeFits('هفتم'), isFalse);
    // مقطعِ نامعلوم: از داده (کلاسِ پایهٔ دهم ⇒ رشته‌محور؛ وگرنه کلاس‌محور)
    final (e2, ob2) = await school({});
    expect((await SchoolStructure.read(db(e2, ob2))).classBased, isTrue);
    await e2.put('classes', 5, {
      'id': 5,
      'name': 'دهم تجربی',
      'grade': 'دهم',
      'branch': 'علوم تجربی',
      'kind': 'class',
    }, version: 1);
    expect((await SchoolStructure.read(db(e2, ob2))).fieldBased, isTrue);
  });

  test('S195-U02 کلاس‌محور: کلاس ثابت با اتاق، ظرفیت و دبیر پایه؛ پایهٔ خارج از مقطع و رشته رد می‌شود', () async {
    final (e, ob) = await school({'level': 'متوسطه اول'});
    final b = ClassBook(db(e, ob));
    final w = await b.saveClass(
      const ClassDraft(
        name: 'هفتم الف',
        grade: 'هفتم',
        room: 'اتاق ۱۰۲',
        capacity: '۲۸',
        teacherId: 10,
      ),
    );
    final c = await e.get('classes', w.id!);
    expect(c!.data['mode'], 'class');
    expect(c.data['room'], 'اتاق ۱۰۲');
    expect(c.data['capacity'], 28);
    expect(c.data['teacher_id'], 10);
    // نوع چیدمان از مقطع می‌آید، نه انتخاب دستی
    final w2 = await b.saveClass(
      const ClassDraft(name: 'هفتم ب', grade: 'هفتم', mode: 'field'),
    );
    expect((await e.get('classes', w2.id!))!.data['mode'], 'class');
    final v = await b.overview();
    expect(v.structure.classBased, isTrue);
    final row = v.classes.firstWhere((x) => x.name == 'هفتم الف');
    expect(
      (row.room, row.capacity, row.teacher),
      ('اتاق ۱۰۲', 28, 'دبیر ریاضی'),
    );
    final n = ob.list().length;
    await expectLater(
      b.saveClass(const ClassDraft(name: 'دهم', grade: 'دهم')),
      failsWith('invalid', 'مقطع'),
    );
    await expectLater(
      b.saveClass(
        const ClassDraft(name: 'هشتم x', grade: 'هشتم', branch: 'کامپیوتر'),
      ),
      failsWith('invalid', 'رشته ندارد'),
    );
    await expectLater(
      b.saveClass(const ClassDraft(name: 'هشتم', grade: 'هشتم', capacity: '0')),
      failsWith('invalid', 'ظرفیت'),
    );
    await expectLater(
      b.saveClass(const ClassDraft(name: 'هشتم', grade: 'هشتم', teacherId: 1)),
      failsWith('invalid', 'دبیر پایه'),
    );
    await expectLater(
      b.saveLookup(kind: 'branch', name: 'ریاضی فیزیک'),
      failsWith('invalid', 'کلاس‌محور'),
    );
    await expectLater(
      b.saveLookup(kind: 'grade', name: 'دوازدهم'),
      failsWith('invalid', 'مقطع'),
    );
    await expectLater(
      b.saveLookup(kind: 'grade', name: 'الف'),
      failsWith('invalid', 'پایه نیست'),
    );
    expect(ob.list(), hasLength(n), reason: 'هیچ رد شده‌ای در صف نمی‌رود');
  });

  test(
    'S195-U03 رشته‌محور: رشته فقط از شاخه‌های مدرسه؛ کلاس رشته لازم دارد',
    () async {
      final (e, ob) = await school({
        'level': 'متوسطه دوم',
        'branches': ['نظری'],
        'fields': ['علوم تجربی', 'ریاضی فیزیک'],
      });
      final b = ClassBook(db(e, ob));
      await b.saveLookup(kind: 'branch', name: 'علوم تجربی');
      await expectLater(
        b.saveLookup(kind: 'branch', name: 'مکانیک خودرو'),
        failsWith('invalid', 'شاخه'),
      );
      await expectLater(
        b.saveClass(const ClassDraft(grade: 'دهم')),
        failsWith('invalid', 'رشته'),
      );
      await expectLater(
        b.saveClass(const ClassDraft(grade: 'دهم', branch: 'الکترونیک')),
        failsWith('invalid', 'شاخه'),
      );
      final w = await b.saveClass(
        const ClassDraft(grade: 'دهم', branch: 'علوم تجربی', mode: 'class'),
      );
      final c = await e.get('classes', w.id!);
      expect((c!.data['name'], c.data['mode']), ('دهم علوم تجربی', 'field'));
    },
  );

  test('S195-U04 برنامهٔ کلاس‌محور: هر کلاس جدا؛ دو کلاسِ هم‌پایه در یک زنگ؛ تکرارِ همان کلاس رد', () async {
    final (e, ob) = await school({'level': 'ابتدایی'});
    Future<void> put(String c, int id, Map<String, Object?> d) =>
        e.put(c, id, {...d, 'id': id}, version: 1);
    await put('classes', 5, {
      'name': 'سوم الف',
      'grade': 'سوم',
      'kind': 'class',
      'mode': 'class',
      'room': 'اتاق ۳',
      'teacher_id': 10,
    });
    await put('classes', 6, {
      'name': 'سوم ب',
      'grade': 'سوم',
      'kind': 'class',
      'mode': 'class',
    });
    await put('classes', 7, {'name': 'آزمایشگاه', 'kind': 'room'});
    await put('users', 21, {'name': 'سارا', 'role': 'student', 'class_id': 5});
    await put('users', 22, {'name': 'مینا', 'role': 'student', 'class_id': 6});
    final t = Timetable(db(e, ob));
    var v = await t.view();
    expect(v.classBased, isTrue);
    expect(v.classOptions.map((o) => o.$2), ['سوم الف', 'سوم ب']);
    expect(v.classId, 5);
    expect((v.homeRoom, v.homeroom), ('اتاق ۳', 'دبیر ریاضی'));
    final a = await t.saveSlot(
      const SlotDraft(
        grade: '',
        classId: 5,
        day: 0,
        period: 1,
        subjectId: 41,
        teacherId: 10,
      ),
    );
    // همان زنگ برای «سوم ب» (پایهٔ مشترک) رد نمی‌شود — پیش از ردیف ۱۹۵ رد می‌شد
    final bSlot = await t.saveSlot(
      const SlotDraft(
        grade: '',
        classId: 6,
        day: 0,
        period: 1,
        subjectId: 42,
        teacherId: 11,
        roomId: 7,
      ),
    );
    final ra = await e.get('schedule', a.id!);
    expect(
      (ra!.data['class_id'], ra.data['grade'], ra.data['room']),
      (5, 'سوم', 'اتاق ۳'),
    );
    expect((await e.get('schedule', bSlot.id!))!.data['room'], 'آزمایشگاه');
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: '',
          classId: 5,
          day: 0,
          period: 1,
          subjectId: 42,
        ),
      ),
      failsWith('duplicate', 'سوم الف'),
    );
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: '',
          classId: 6,
          day: 1,
          period: 1,
          subjectId: 41,
          teacherId: 10,
        ),
      ),
      completes,
    );
    await expectLater(
      t.saveSlot(
        const SlotDraft(grade: 'سوم', day: 2, period: 1, subjectId: 41),
      ),
      failsWith('invalid', 'کلاس'),
    );
    v = await t.view(classId: 6);
    expect(v.slots.map((s) => s.subject), unorderedEquals(['علوم', 'ریاضی']));
    // دانش‌آموز فقط برنامهٔ کلاس خودش را می‌بیند (نه کلاس هم‌پایه)
    final s21 = await Timetable(db(e, ob, 'student', 21)).view();
    expect(s21.slots.map((s) => s.classId).toSet(), {5});
    final s22 = await Timetable(db(e, ob, 'student', 22)).view();
    expect(s22.slots.map((s) => s.classId).toSet(), {6});
  });

  test('S195-U05 تولید خودکار کلاس‌محور: هر کلاسِ هم‌پایه برنامهٔ کامل خودش را می‌گیرد', () async {
    final (e, ob) = await school({'level': 'ابتدایی'});
    for (final (id, n) in [(5, 'چهارم الف'), (6, 'چهارم ب')]) {
      await e.put('classes', id, {
        'id': id,
        'name': n,
        'grade': 'چهارم',
        'kind': 'class',
        'mode': 'class',
      }, version: 1);
    }
    final t = Timetable(db(e, ob));
    final g = await t.generate();
    expect(g.demands, 6, reason: '۲ ساعت ریاضی + ۱ ساعت علوم برای هر دو کلاس');
    expect(g.placements.map((p) => p.classId).toSet(), {5, 6});
    await t.applyGenerated(g);
    final rows = await db(e, ob).all('schedule');
    expect(rows.where((r) => r.data['class_id'] == 5), hasLength(3));
    expect(rows.where((r) => r.data['class_id'] == 6), hasLength(3));
  });

  test(
    'S195-U06 رشته‌محور: محلِ هر زنگ پایهٔ دهم به بالا را مدیر تعیین می‌کند',
    () async {
      final (e, ob) = await school({
        'level': 'متوسطه دوم',
        'branches': ['نظری'],
      });
      await e.put('classes', 8, {
        'id': 8,
        'name': 'کارگاه ۱',
        'kind': 'room',
      }, version: 1);
      final t = Timetable(db(e, ob));
      expect((await t.view()).classBased, isFalse);
      await expectLater(
        t.saveSlot(
          const SlotDraft(
            grade: 'دهم',
            branch: 'علوم تجربی',
            day: 0,
            period: 1,
            subjectId: 41,
          ),
        ),
        failsWith('invalid', 'محل برگزاری'),
      );
      final w = await t.saveSlot(
        const SlotDraft(
          grade: 'دهم',
          branch: 'علوم تجربی',
          day: 0,
          period: 1,
          subjectId: 41,
          roomId: 8,
        ),
      );
      expect((await e.get('schedule', w.id!))!.data['room'], 'کارگاه ۱');
    },
  );
}
