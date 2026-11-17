# SQLite3 Multiple Ciphers 2.6.1 (SQLite 3.54.0), unmodified amalgamation

Source: https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.6.1/sqlite3mc-2.6.1-sqlite-3.54.0-amalgamation.zip
(zip sha256 3f25af603566a23c821d8e581778b5ece2a541d2435776de57b8d845c176815a; the files here are
byte-identical copies, see SHA256SUMS). License: MIT (SQLite3 Multiple Ciphers), public domain (SQLite).

Row 168: this is the exact source of package:sqlite3 3.9.1's prebuilt `libsqlite3mc.*.android.so`
(same SQLITE_SOURCE_ID 2026-10-09 15:46:58 be8d059e…), which is linked for Android 7.0 (API 24) and
imports `__register_atfork` / `stderr` (API 23): it cannot load on Android 5.0/5.1. apps/payesh/pubspec.yaml
therefore builds it from this source for Android only (`hooks.user_defines.sqlite3.source.android: source`);
Flutter passes the app's minSdk (21) to the NDK, so the library only links against Android 5.0 libc.
The defines are package:sqlite3's defaults without SQLITE_HAVE_STRCHRNUL (strchrnul is API 24) and
the Windows-only SQLITE_HAVE_LOCALTIME_S. Windows/Linux/macOS keep the prebuilt sqlite3mc binary.

To upgrade: replace the files with the amalgamation matching the new package:sqlite3 prebuilts,
regenerate SHA256SUMS, and keep the define list in pubspec.yaml in sync with
package:sqlite3/src/hook/compile/description.dart `_defaultDefines`.
