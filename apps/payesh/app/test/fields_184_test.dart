// Row 184 — every input box in every panel has a standard width: text 360, digits 220,
// a few characters 120, search 240 (row 185; 320 in row 184), an address 480; only multi-line text keeps the full width.
// The owner: «همه کادرها در همه پنل‌ها … شامل تمام کادرها از جمله کادرهای ورود اطلاعات و سرچ‌ها».
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'nav_support.dart';
import 'school_support.dart';
import 'users_wave6_test.dart' as w6;

final _field = RegExp(
  r'\b(TextField|TextFormField|DropdownButtonFormField(<[^>(]*>)?|DropdownMenu(<[^>(]*>)?)\(',
);

/// The generic helpers that take the width from their own parameters.
const _sizedElsewhere = {
  'school/school_source.dart', // SchoolField — width param, multi-line full
  'system/school_profile_screen.dart', // _sized(lines, numeric, field)
};

/// Index of the `)` that closes `s[open]` (string contents skipped).
int _close(String s, int open) {
  var depth = 0;
  String? quote;
  for (var i = open; i < s.length; i++) {
    final c = s[i];
    if (quote != null) {
      if (c == r'\') {
        i++;
      } else if (c == quote) {
        quote = null;
      }
      continue;
    }
    if (c == "'" || c == '"') {
      quote = c;
    } else if (c == '(') {
      depth++;
    } else if (c == ')' && --depth == 0) {
      return i;
    }
  }
  return s.length - 1;
}

/// Every field call in [dir] that is not inside a [FieldBox] and is not multi-line.
List<String> unsized(String dir) {
  final bad = <String>[];
  for (final f in Directory(dir).listSync(recursive: true).whereType<File>()) {
    if (!f.path.endsWith('.dart')) continue;
    final rel = f.path.split(RegExp(r'(^|/)lib/src/')).last;
    final s = f.readAsStringSync();
    for (final m in _field.allMatches(s)) {
      final before = s.substring(m.start < 200 ? 0 : m.start - 200, m.start);
      final inBox = RegExp(
        r'FieldBox\((\s*width:[^;]*?)?\s*child:\s*(const\s+)?$',
      ).hasMatch(before);
      final args = s.substring(m.end - 1, _close(s, m.end - 1) + 1);
      final multi = RegExp(r'maxLines:\s*(null|[2-9]|\d\d)|minLines:')
          .hasMatch(args);
      if (inBox || multi) continue;
      if (_sizedElsewhere.contains(rel)) continue;
      final line = '\n'.allMatches(s.substring(0, m.start)).length + 1;
      bad.add('$rel:$line ${m.group(1)}');
    }
  }
  return bad;
}

void main() {
  test('F184-01 school app: no one-line field spans the page — each is in a standard FieldBox', () {
    expect(unsized('lib'), isEmpty);
  });

  test('F184-02 owner app: the same for the owner panel (logins, dialogs, searches)', () {
    expect(unsized('../owner/lib'), isEmpty);
  });

  test('F184-03 NEG: the guard catches a bare field', () {
    final tmp = Directory.systemTemp.createTempSync('f184');
    addTearDown(() => tmp.deleteSync(recursive: true));
    Directory('${tmp.path}/lib/src/x').createSync(recursive: true);
    File('${tmp.path}/lib/src/x/a.dart').writeAsStringSync(
      "final a = TextField(key: Key('bare'));\n"
      "final b = FieldBox(width: kFieldText, child: TextField(key: Key('ok')));\n"
      "final c = TextField(key: Key('note'), maxLines: 4);\n",
    );
    expect(unsized('${tmp.path}/lib'), ['x/a.dart:1 TextField']);
  });

  testWidgets(
    'F184-04 «کاربران» on a Windows window: the search box is the standard search width (row 185: 240), not the page width',
    (tester) async {
      tester.view.physicalSize = const Size(1568, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await bootSchool(tester, role: 'manager', seed: w6.seed);
      await openPage(tester, 'users');
      final box = tester.getSize(find.byKey(const Key('usr-search')));
      expect(box.width, kFieldSearch);
      expect(box.width, lessThan(1568 / 3), reason: 'NEG: not stretched');
    },
  );
}
