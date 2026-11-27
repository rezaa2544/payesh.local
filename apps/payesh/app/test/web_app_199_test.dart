// Row 199 — the school app in the browser (app.payeshschool.ir): the file dialog filters
// become an HTML `accept` list for the browser's own «choose file» dialog.
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/platform/file_pick.dart';

void main() {
  test('W199-01 sheet filters → .xlsx,.csv (the first filter; «همهٔ فایل‌ها» adds nothing)', () {
    expect(browserAccept(sheetFilters), '.xlsx,.csv');
  });

  test('W199-02 image filters → .jpg,.jpeg,.png', () {
    expect(browserAccept(imageFilters), '.jpg,.jpeg,.png');
  });

  test('W199-03 only «*.*» → no restriction', () {
    expect(browserAccept(const [('همه', '*.*')]), '');
    expect(browserAccept(const []), '');
  });
}
