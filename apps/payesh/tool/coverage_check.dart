// Line-coverage gate for lcov files (row 69). Usage:
//   dart tool/coverage_check.dart <min-percent> <lcov.info>...
// Exits 1 when any file set is below the threshold, 2 on missing/empty input.
import 'dart:io';

void main(List<String> args) {
  if (args.length < 2) {
    stderr.writeln('usage: coverage_check.dart <min-percent> <lcov.info>...');
    exit(2);
  }
  final min = double.parse(args.first);
  var failed = false;
  for (final path in args.skip(1)) {
    final f = File(path);
    if (!f.existsSync()) {
      stderr.writeln('COVERAGE-INPUT-ERROR missing $path');
      exit(2);
    }
    var found = 0, hit = 0;
    for (final line in f.readAsLinesSync()) {
      if (line.startsWith('DA:')) {
        found++;
        final count = int.parse(line.substring(3).split(',')[1]);
        if (count > 0) hit++;
      }
    }
    if (found == 0) {
      stderr.writeln('COVERAGE-INPUT-ERROR no line data in $path');
      exit(2);
    }
    final pct = 100 * hit / found;
    final ok = pct >= min;
    if (!ok) failed = true;
    stdout.writeln(
      '${ok ? 'COVERAGE-OK' : 'COVERAGE-FAIL'} $path lines=$hit/$found '
      '${pct.toStringAsFixed(1)}% (min $min%)',
    );
  }
  exit(failed ? 1 : 0);
}
