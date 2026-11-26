// Row 194: the Windows «Open» dialog in the 32-bit edition (no dart:ffi): the shell runs the
// stock .NET OpenFileDialog through Windows PowerShell (always present on Windows 7+).
import 'package:payesh_core/io.dart';

// coverage:ignore-start
// Runs only inside the 32-bit shell on Windows.

/// Same contract as the FFI version: the chosen path, or null when cancelled.
Future<String?> windowsOpenFileDialog({
  required String title,
  required List<(String, String)> filters,
}) async {
  String q(String s) => s.replaceAll("'", "''");
  final filter = [
    for (final (label, pattern) in filters) '${q(label)} ($pattern)|$pattern',
  ].join('|');
  final script =
      'Add-Type -AssemblyName System.Windows.Forms;'
      r'$d=New-Object System.Windows.Forms.OpenFileDialog;'
      "\$d.Title='${q(title)}';\$d.Filter='$filter';\$d.Multiselect=\$false;"
      r'$w=New-Object System.Windows.Forms.Form;$w.TopMost=$true;'
      "if(\$d.ShowDialog(\$w) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
      r'[Console]::Out.Write($d.FileName)}';
  final r = await Process.run('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
  final out = '${r.stdout}'.trim();
  return r.exitCode == 0 && out.isNotEmpty ? out : null;
}

// coverage:ignore-end
