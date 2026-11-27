// The 32-bit Windows edition's native host (row 169, D-50).
//
// The edition is the same Flutter code compiled to JavaScript and shown by a small 32-bit
// Chromium (CEF 109) program (tools/web32/shell). That program injects `window.payeshHost`
// — synchronous functions that do what dart:io does natively: real files under the user's
// profile, DPAPI, starting processes, opening links. Binary data crosses as "latin1" strings
// (one char = one byte). Errors are thrown as JS errors "<code>|<message>".
//
// Without the shell (a plain browser while developing, or the headless test) a small
// in-memory host stands in, so the UI still starts.
import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

/// Error raised by the host (Windows error code + message).
final class HostError implements Exception {
  const HostError(this.code, this.message);
  final int code;
  final String message;
  @override
  String toString() => 'HostError($code): $message';
}

/// Kind of a path on disk.
enum HostType { file, directory, link, none }

/// What `stat` returns.
final class HostStat {
  const HostStat(this.type, this.size, this.modifiedMs);
  final HostType type;
  final int size;
  final int modifiedMs;
}

/// Result of a finished process.
final class HostRun {
  const HostRun(this.pid, this.code, this.out, this.err);
  final int pid;
  final int code;
  final String out;
  final String err;
}

/// The host contract (see tools/web32/shell/README.md).
abstract class WebHost {
  static WebHost? _instance;

  /// The shell's host when present, otherwise the in-memory stand-in. In a plain browser
  /// (row 199, app.payeshschool.ir) [prepare] installs [BrowserHost] first.
  static WebHost get instance =>
      _instance ??= _JsHost.tryCreate() ?? MemoryHost();

  /// Row 199: picks the host once at start-up — the 32-bit shell's when present, otherwise
  /// (a plain browser) [BrowserHost], whose files persist in IndexedDB; the in-memory
  /// stand-in only when the browser has no IndexedDB helper (tests, private modes).
  static Future<void> prepare() async {
    if (_instance != null) return;
    final shell = _JsHost.tryCreate();
    if (shell != null) {
      _instance = shell;
      return;
    }
    _instance = await BrowserHost.open() ?? MemoryHost();
  }

  /// Tests replace the host.
  static set instance(WebHost h) => _instance = h;

  /// True inside the real 32-bit shell.
  bool get isShell;

  /// `{os, osVersion, env, exe, pid, cpus, hostname, locale, temp, home, app, args}`.
  Map<String, Object?> info();

  HostStat stat(String path);
  Uint8List read(String path, [int start = -1, int end = -1]);
  void write(String path, List<int> data, {bool append = false});
  List<(String, HostType)> list(String path);
  void mkdir(String path);
  void remove(String path, {bool recursive = false});
  void rename(String from, String to);
  void copy(String from, String to);
  void setModified(String path, int ms);

  int fopen(String path, String mode);
  Uint8List fread(int handle, int position, int length);
  void fwrite(int handle, int position, List<int> data);
  int fsize(int handle);
  void ftruncate(int handle, int length);
  void fsync(int handle);
  void fclose(int handle);

  Uint8List dpapi(List<int> data, List<int> entropy, {required bool protect});
  HostRun run(
    String exe,
    List<String> args, {
    String? cwd,
    int timeoutMs = 60000,
  });
  int spawn(String exe, List<String> args, {String? cwd});
  bool kill(int pid);
  void openUrl(String url);

  /// DNS (getaddrinfo in the shell): the IP addresses of [host].
  List<String> resolve(String host);
  void trustPem(String pem);
  void exit(int code);
  void log(String line);
}

/// "latin1" string → bytes.
Uint8List bytesOfLatin1(String s) {
  final out = Uint8List(s.length);
  for (var i = 0; i < s.length; i++) {
    out[i] = s.codeUnitAt(i) & 0xff;
  }
  return out;
}

/// bytes → "latin1" string.
String latin1Of(List<int> b) {
  const chunk = 8192;
  if (b.length <= chunk) return String.fromCharCodes(b);
  final sb = StringBuffer();
  for (var i = 0; i < b.length; i += chunk) {
    sb.write(
      String.fromCharCodes(b, i, i + chunk < b.length ? i + chunk : b.length),
    );
  }
  return sb.toString();
}

HostType _type(String t) => switch (t) {
  'f' => HostType.file,
  'd' => HostType.directory,
  'l' => HostType.link,
  _ => HostType.none,
};

final class _JsHost implements WebHost {
  _JsHost(this._o);
  final JSObject _o;

  static _JsHost? tryCreate() {
    final h = globalContext.getProperty<JSAny?>('payeshHost'.toJS);
    return h == null ? null : _JsHost(h as JSObject);
  }

  @override
  bool get isShell => true;

  T _call<T extends JSAny?>(String fn, [List<JSAny?> args = const []]) {
    try {
      return _o.callMethodVarArgs<T>(fn.toJS, args);
    } catch (e) {
      final s = '$e';
      final m = RegExp(r'(\d+)\|(.*)$', dotAll: true).firstMatch(s);
      if (m != null) throw HostError(int.parse(m[1]!), m[2]!);
      throw HostError(-1, s);
    }
  }

  String _s(String fn, [List<JSAny?> args = const []]) =>
      _call<JSString>(fn, args).toDart;
  int _i(String fn, [List<JSAny?> args = const []]) =>
      _call<JSNumber>(fn, args).toDartInt;

  Map<String, Object?>? _info;
  @override
  Map<String, Object?> info() =>
      _info ??= (jsonDecode(_s('info')) as Map).cast<String, Object?>();

  @override
  HostStat stat(String path) {
    final m = jsonDecode(_s('stat', [path.toJS])) as Map;
    return HostStat(
      _type('${m['t']}'),
      (m['s'] as num?)?.toInt() ?? 0,
      (m['m'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  Uint8List read(String path, [int start = -1, int end = -1]) =>
      bytesOfLatin1(_s('read', [path.toJS, start.toJS, end.toJS]));

  @override
  void write(String path, List<int> data, {bool append = false}) =>
      _call<JSAny?>('write', [path.toJS, latin1Of(data).toJS, append.toJS]);

  @override
  List<(String, HostType)> list(String path) => [
    for (final e in jsonDecode(_s('list', [path.toJS])) as List)
      ('${(e as List)[0]}', _type('${e[1]}')),
  ];

  @override
  void mkdir(String path) => _call<JSAny?>('mkdir', [path.toJS]);

  @override
  void remove(String path, {bool recursive = false}) =>
      _call<JSAny?>('remove', [path.toJS, recursive.toJS]);

  @override
  void rename(String from, String to) =>
      _call<JSAny?>('rename', [from.toJS, to.toJS]);

  @override
  void copy(String from, String to) =>
      _call<JSAny?>('copy', [from.toJS, to.toJS]);

  @override
  void setModified(String path, int ms) =>
      _call<JSAny?>('setMtime', [path.toJS, ms.toJS]);

  @override
  int fopen(String path, String mode) => _i('fopen', [path.toJS, mode.toJS]);

  @override
  Uint8List fread(int handle, int position, int length) =>
      bytesOfLatin1(_s('fread', [handle.toJS, position.toJS, length.toJS]));

  @override
  void fwrite(int handle, int position, List<int> data) => _call<JSAny?>(
    'fwrite',
    [handle.toJS, position.toJS, latin1Of(data).toJS],
  );

  @override
  int fsize(int handle) => _i('fsize', [handle.toJS]);

  @override
  void ftruncate(int handle, int length) =>
      _call<JSAny?>('ftrunc', [handle.toJS, length.toJS]);

  @override
  void fsync(int handle) => _call<JSAny?>('fsync', [handle.toJS]);

  @override
  void fclose(int handle) => _call<JSAny?>('fclose', [handle.toJS]);

  @override
  Uint8List dpapi(List<int> data, List<int> entropy, {required bool protect}) =>
      bytesOfLatin1(
        _s('dpapi', [
          latin1Of(data).toJS,
          latin1Of(entropy).toJS,
          protect.toJS,
        ]),
      );

  @override
  HostRun run(
    String exe,
    List<String> args, {
    String? cwd,
    int timeoutMs = 60000,
  }) {
    final m = jsonDecode(
      _s('run', [
        exe.toJS,
        jsonEncode(args).toJS,
        (cwd ?? '').toJS,
        timeoutMs.toJS,
      ]),
    ) as Map;
    return HostRun(
      (m['pid'] as num?)?.toInt() ?? 0,
      (m['code'] as num?)?.toInt() ?? -1,
      '${m['out'] ?? ''}',
      '${m['err'] ?? ''}',
    );
  }

  @override
  int spawn(String exe, List<String> args, {String? cwd}) =>
      _i('spawn', [exe.toJS, jsonEncode(args).toJS, (cwd ?? '').toJS]);

  @override
  bool kill(int pid) => _call<JSBoolean>('kill', [pid.toJS]).toDart;

  @override
  void openUrl(String url) => _call<JSAny?>('openUrl', [url.toJS]);

  @override
  List<String> resolve(String host) => [
    for (final a in jsonDecode(_s('resolve', [host.toJS])) as List) '$a',
  ];

  @override
  void trustPem(String pem) => _call<JSAny?>('trustPem', [pem.toJS]);

  @override
  void exit(int code) => _call<JSAny?>('exit', [code.toJS]);

  @override
  void log(String line) => _call<JSAny?>('log', [line.toJS]);
}

/// In-memory stand-in (no shell): a tiny Windows-like file tree, no processes, no DPAPI
/// secrecy (data is only XOR-tagged so the format round-trips).
final class MemoryHost implements WebHost {
  MemoryHost({Map<String, String>? env})
    : _env =
          env ??
          {
            'LOCALAPPDATA': r'C:\Users\web\AppData\Local',
            'APPDATA': r'C:\Users\web\AppData\Roaming',
            'USERPROFILE': r'C:\Users\web',
            'TEMP': r'C:\Users\web\AppData\Local\Temp',
            'SystemRoot': r'C:\Windows',
          };

  final Map<String, String> _env;
  final Map<String, Uint8List> _files = {};
  final Map<String, int> _mtime = {};
  final Set<String> _dirs = {r'C:'};
  final Map<int, String> _handles = {};
  int _next = 1;
  final List<String> logs = [];
  final List<String> opened = [];
  final List<String> trusted = [];

  static String norm(String p) {
    var s = p.replaceAll('/', r'\');
    while (s.length > 3 && s.endsWith(r'\')) {
      s = s.substring(0, s.length - 1);
    }
    return s.toLowerCase();
  }

  static String parentOf(String p) {
    final i = p.lastIndexOf(r'\');
    return i <= 0 ? p : p.substring(0, i);
  }

  @override
  bool get isShell => false;

  @override
  Map<String, Object?> info() => {
    'os': 'windows',
    'osVersion': '"Windows (web32 memory host)" 6.1 (Build 7601)',
    'env': _env,
    'exe': r'C:\Program Files\Payesh\payesh.exe',
    'pid': 4242,
    'cpus': 2,
    'hostname': 'web32',
    'locale': 'fa_IR',
    'temp': _env['TEMP'],
    'home': _env['USERPROFILE'],
    'app': 'memory',
    'args': <String>[],
  };

  Never _enoent(String p) =>
      throw HostError(2, 'The system cannot find the file specified: $p');

  @override
  HostStat stat(String path) {
    final k = norm(path);
    if (_files.containsKey(k)) {
      return HostStat(HostType.file, _files[k]!.length, _mtime[k] ?? 0);
    }
    if (_dirs.contains(k)) return const HostStat(HostType.directory, 0, 0);
    return const HostStat(HostType.none, 0, 0);
  }

  @override
  Uint8List read(String path, [int start = -1, int end = -1]) {
    final f = _files[norm(path)] ?? _enoent(path);
    final s = start < 0 ? 0 : start.clamp(0, f.length);
    final e = end < 0 ? f.length : end.clamp(s, f.length);
    return Uint8List.fromList(f.sublist(s, e));
  }

  @override
  void write(String path, List<int> data, {bool append = false}) {
    final k = norm(path);
    if (!_dirs.contains(parentOf(k))) _enoent(path);
    final old = append ? _files[k] ?? Uint8List(0) : Uint8List(0);
    _files[k] = Uint8List(old.length + data.length)
      ..setAll(0, old)
      ..setAll(old.length, data);
    _mtime[k] = DateTime.now().millisecondsSinceEpoch;
  }

  @override
  List<(String, HostType)> list(String path) {
    final k = norm(path);
    if (!_dirs.contains(k)) _enoent(path);
    return [
      for (final d in _dirs)
        if (d != k && parentOf(d) == k)
          (d.substring(k.length + 1), HostType.directory),
      for (final f in _files.keys)
        if (parentOf(f) == k) (f.substring(k.length + 1), HostType.file),
    ];
  }

  @override
  void mkdir(String path) {
    var k = norm(path);
    while (!_dirs.contains(k) && k.contains(r'\')) {
      _dirs.add(k);
      k = parentOf(k);
    }
    _dirs.add(k);
  }

  @override
  void remove(String path, {bool recursive = false}) {
    final k = norm(path);
    if (_files.remove(k) != null) return;
    if (!_dirs.contains(k)) _enoent(path);
    final inside = '$k\\';
    final kids =
        _files.keys.any((f) => f.startsWith(inside)) ||
        _dirs.any((d) => d.startsWith(inside));
    if (kids && !recursive) throw HostError(145, 'The directory is not empty.');
    _files.removeWhere((f, _) => f.startsWith(inside));
    _dirs.removeWhere((d) => d == k || d.startsWith(inside));
  }

  @override
  void rename(String from, String to) {
    final a = norm(from), b = norm(to);
    if (_files.containsKey(a)) {
      _files[b] = _files.remove(a)!;
      _mtime[b] = DateTime.now().millisecondsSinceEpoch;
      return;
    }
    if (!_dirs.contains(a)) _enoent(from);
    final moved = {
      for (final e in _files.entries)
        if (e.key.startsWith('$a\\')) e.key: e.value,
    };
    for (final e in moved.entries) {
      _files.remove(e.key);
      _files['$b${e.key.substring(a.length)}'] = e.value;
    }
    final dirs = _dirs.where((d) => d == a || d.startsWith('$a\\')).toList();
    for (final d in dirs) {
      _dirs
        ..remove(d)
        ..add('$b${d.substring(a.length)}');
    }
  }

  @override
  void copy(String from, String to) =>
      write(to, _files[norm(from)] ?? _enoent(from));

  @override
  void setModified(String path, int ms) => _mtime[norm(path)] = ms;

  @override
  int fopen(String path, String mode) {
    final k = norm(path);
    if (mode == 'r' && !_files.containsKey(k)) _enoent(path);
    if (mode == 'w' || !_files.containsKey(k)) write(path, const []);
    _handles[_next] = k;
    return _next++;
  }

  String _h(int h) => _handles[h] ?? (throw const HostError(6, 'bad handle'));

  @override
  Uint8List fread(int handle, int position, int length) {
    final f = _files[_h(handle)]!;
    final s = position.clamp(0, f.length);
    return Uint8List.fromList(f.sublist(s, (s + length).clamp(s, f.length)));
  }

  @override
  void fwrite(int handle, int position, List<int> data) {
    final k = _h(handle);
    var f = _files[k]!;
    final end = position + data.length;
    if (end > f.length) {
      // Row 199: SQLite grows its file page by page — keep spare capacity (a view over a larger
      // buffer) instead of copying the whole database on every appended page.
      final room = f.offsetInBytes == 0 ? f.buffer.lengthInBytes : 0;
      if (end <= room) {
        f = Uint8List.view(f.buffer, 0, end);
      } else {
        final cap = end < 65536 ? 65536 : end + (end >> 1);
        f = Uint8List.view((Uint8List(cap)..setAll(0, f)).buffer, 0, end);
      }
    }
    f.setAll(position, data);
    _files[k] = f;
  }

  @override
  int fsize(int handle) => _files[_h(handle)]!.length;

  @override
  void ftruncate(int handle, int length) {
    final k = _h(handle);
    final f = _files[k]!;
    _files[k] = Uint8List(length)
      ..setAll(0, f.sublist(0, length.clamp(0, f.length)));
  }

  @override
  void fsync(int handle) => _h(handle);

  @override
  void fclose(int handle) => _handles.remove(handle);

  @override
  Uint8List dpapi(List<int> data, List<int> entropy, {required bool protect}) {
    final tag = utf8.encode('MEMDPAPI');
    if (protect) return Uint8List.fromList([...tag, ...data]);
    if (data.length < tag.length) throw const HostError(13, 'bad data');
    return Uint8List.fromList(data.sublist(tag.length));
  }

  @override
  HostRun run(
    String exe,
    List<String> args, {
    String? cwd,
    int timeoutMs = 60000,
  }) => HostRun(0, 1, '', 'no processes in the memory host');

  @override
  int spawn(String exe, List<String> args, {String? cwd}) =>
      throw const HostError(2, 'no processes in the memory host');

  @override
  bool kill(int pid) => false;

  @override
  void openUrl(String url) => opened.add(url);

  @override
  List<String> resolve(String host) =>
      throw HostError(11001, 'No such host is known: $host');

  @override
  void trustPem(String pem) => trusted.add(pem);

  @override
  void exit(int code) => logs.add('exit $code');

  @override
  void log(String line) => logs.add(line);
}

// ── Row 199: the browser edition (app.payeshschool.ir) ─────────────────────────────────────
// The same app in an ordinary browser: no shell, so no processes, no DPAPI and no real disk.
// Files live in memory (like [MemoryHost]) and every change is written to IndexedDB through
// `window.payeshIdb` (web/payesh_idb.js) — a reload keeps the database, the settings and the
// signed-in session. Links open in a new tab.

@JS('payeshIdb')
external _Idb? get _payeshIdb;

extension type _Idb._(JSObject _) implements JSObject {
  external JSPromise<JSArray<JSArray<JSAny?>>> loadAll();
  external JSPromise<JSAny?> commit(
    JSArray<JSAny?> puts,
    JSArray<JSString> dels,
  );
  external JSPromise<JSAny?> persist();
  external set onHide(JSFunction? f);
  external JSPromise<JSArray<JSAny?>?> pickFile(JSString accept);
}

/// Row 199: the browser's «choose file» dialog — (name, bytes), or null when the user closed it
/// (or this page has no `window.payeshIdb`).
Future<(String, Uint8List)?> browserPickFile(String accept) async {
  final idb = _payeshIdb;
  if (idb == null) return null;
  final r = await idb.pickFile(accept.toJS).toDart;
  if (r == null) return null;
  final pair = r.toDart;
  return ((pair[0] as JSString).toDart, (pair[1] as JSUint8Array).toDart);
}

/// [MemoryHost] whose files persist in this browser's IndexedDB.
final class BrowserHost extends MemoryHost {
  BrowserHost._(this._idb) : super();

  final _Idb _idb;

  /// Key of the record holding the directory list (file keys are lower-case Windows paths).
  static const String dirsKey = '\u0001dirs';

  final Set<String> _dirty = {};
  bool _dirsDirty = false;
  Timer? _timer;
  DateTime? _firstDirty;
  Future<void> _flushing = Future<void>.value();

  /// Null when this browser has no IndexedDB helper or it cannot be opened.
  static Future<BrowserHost?> open() async {
    final idb = _payeshIdb;
    if (idb == null) return null;
    final h = BrowserHost._(idb);
    try {
      final rows = (await idb.loadAll().toDart).toDart;
      for (final row in rows) {
        final pair = row.toDart;
        final key = (pair[0] as JSString).toDart;
        final v = pair[1];
        if (key == dirsKey) {
          if (v.isA<JSString>()) {
            for (final d in jsonDecode((v as JSString).toDart) as List) {
              h._dirs.add('$d');
            }
          }
          continue;
        }
        if (v == null || !v.isA<JSObject>()) continue;
        final o = v as JSObject;
        final d = o.getProperty<JSAny?>('d'.toJS);
        if (d == null || !d.isA<JSUint8Array>()) continue;
        h._files[key] = (d as JSUint8Array).toDart;
        h._mtime[key] =
            (o.getProperty<JSAny?>('m'.toJS) as JSNumber?)?.toDartInt ?? 0;
      }
    } on Object catch (e) {
      // unreadable store: start empty rather than not at all (the server still has the data)
      h.logs.add('indexeddb load failed: $e');
    }
    // every parent directory of a stored file exists (older stores, interrupted writes)
    for (final f in h._files.keys.toList()) {
      h.mkdir(MemoryHost.parentOf(f));
    }
    h._dirsDirty = false;
    h._dirty.clear();
    unawaited(idb.persist().toDart.then((_) {}, onError: (Object _) {}));
    idb.onHide = h.flushNow.toJS;
    return h;
  }

  @override
  Map<String, Object?> info() => {
    ...super.info(),
    'osVersion': '"Browser" 10.0',
    'hostname': 'browser',
    'app': 'browser',
  };

  void _touch(String key) {
    _dirty.add(key);
    _schedule();
  }

  void _touchTree(String key) {
    final inside = '$key\\';
    for (final f in _files.keys) {
      if (f == key || f.startsWith(inside)) _dirty.add(f);
    }
    _dirty.add(key);
    _dirsDirty = true;
    _schedule();
  }

  void _schedule() {
    final now = DateTime.now();
    _firstDirty ??= now;
    _timer?.cancel();
    // a short quiet period batches SQLite's page writes; never wait more than 2 s in total
    final waited = now.difference(_firstDirty!);
    final wait = waited > const Duration(seconds: 2)
        ? Duration.zero
        : const Duration(milliseconds: 400);
    _timer = Timer(wait, flushNow);
  }

  /// Writes every pending change to IndexedDB now (also called when the page is hidden).
  void flushNow() {
    _timer?.cancel();
    _timer = null;
    _firstDirty = null;
    if (_dirty.isEmpty && !_dirsDirty) return;
    final keys = _dirty.toList();
    _dirty.clear();
    final dirs = _dirsDirty;
    _dirsDirty = false;
    final puts = <JSAny?>[];
    final dels = <JSString>[];
    for (final k in keys) {
      final f = _files[k];
      if (f == null) {
        dels.add(k.toJS);
        continue;
      }
      final rec = JSObject()
        ..setProperty('d'.toJS, Uint8List.fromList(f).toJS)
        ..setProperty('m'.toJS, (_mtime[k] ?? 0).toJS);
      puts.add(<JSAny?>[k.toJS, rec].toJS);
    }
    if (dirs) {
      puts.add(<JSAny?>[dirsKey.toJS, jsonEncode(_dirs.toList()).toJS].toJS);
    }
    _flushing = _flushing.then((_) async {
      try {
        await _idb.commit(puts.toJS, dels.toJS).toDart;
      } on Object catch (e) {
        // quota or a closed database: keep the changes pending and try again later
        logs.add('indexeddb commit failed: $e');
        _dirty.addAll(keys);
        _dirsDirty = _dirsDirty || dirs;
        _timer ??= Timer(const Duration(seconds: 5), flushNow);
      }
    });
  }

  /// Completes when every change made so far is in IndexedDB (tests, before a reload).
  Future<void> flush() {
    flushNow();
    return _flushing;
  }

  @override
  void write(String path, List<int> data, {bool append = false}) {
    super.write(path, data, append: append);
    _touch(MemoryHost.norm(path));
  }

  @override
  void mkdir(String path) {
    final before = _dirs.length;
    super.mkdir(path);
    if (_dirs.length != before) {
      _dirsDirty = true;
      _schedule();
    }
  }

  @override
  void remove(String path, {bool recursive = false}) {
    final k = MemoryHost.norm(path);
    final inside = '$k\\';
    final gone = [
      for (final f in _files.keys)
        if (f == k || f.startsWith(inside)) f,
    ];
    super.remove(path, recursive: recursive);
    _dirty.addAll(gone);
    _dirsDirty = true;
    _schedule();
  }

  @override
  void rename(String from, String to) {
    final a = MemoryHost.norm(from);
    final inside = '$a\\';
    final old = [
      for (final f in _files.keys)
        if (f == a || f.startsWith(inside)) f,
    ];
    super.rename(from, to);
    _dirty.addAll(old);
    _touchTree(MemoryHost.norm(to));
  }

  @override
  void setModified(String path, int ms) {
    super.setModified(path, ms);
    _touch(MemoryHost.norm(path));
  }

  @override
  int fopen(String path, String mode) {
    final h = super.fopen(path, mode);
    if (mode != 'r') _touch(MemoryHost.norm(path));
    return h;
  }

  @override
  void fwrite(int handle, int position, List<int> data) {
    super.fwrite(handle, position, data);
    _touch(_h(handle));
  }

  @override
  void ftruncate(int handle, int length) {
    super.ftruncate(handle, length);
    _touch(_h(handle));
  }

  @override
  void fsync(int handle) {
    super.fsync(handle);
    _schedule();
  }

  @override
  int spawn(String exe, List<String> args, {String? cwd}) {
    // openExternalUrl on "Windows" starts `rundll32 url.dll,FileProtocolHandler <url>`
    if (exe.toLowerCase().startsWith('rundll32') && args.length >= 2) {
      openUrl(args.last);
      return 0;
    }
    return super.spawn(exe, args, cwd: cwd);
  }

  @override
  void openUrl(String url) {
    super.openUrl(url);
    final u = Uri.tryParse(url);
    if (u == null || !(u.isScheme('https') || u.isScheme('http'))) return;
    globalContext.callMethodVarArgs<JSAny?>('open'.toJS, [
      url.toJS,
      '_blank'.toJS,
      'noopener'.toJS,
    ]);
  }

  @override
  void exit(int code) {
    flushNow();
    super.exit(code);
  }
}
