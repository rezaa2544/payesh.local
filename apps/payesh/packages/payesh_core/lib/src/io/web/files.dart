// dart:io's File / Directory / FileStat / RandomAccessFile on the 32-bit Windows edition
// (row 169, D-50), installed with IOOverrides: every `File(path)` in the app talks to the
// shell's synchronous file functions — real files at the same Windows paths as the 64-bit
// build (e.g. %LOCALAPPDATA%\…).
import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;
import 'dart:math';
import 'dart:typed_data';

import 'host.dart';

io.FileSystemException _fsError(HostError e, String op, String path) {
  final os = io.OSError(e.message, e.code);
  if (e.code == 2 || e.code == 3) {
    return io.PathNotFoundException(path, os, op);
  }
  if (e.code == 183 || e.code == 80) {
    return io.PathExistsException(path, os, op);
  }
  if (e.code == 5) return io.PathAccessException(path, os, op);
  return io.FileSystemException(op, path, os);
}

T _guard<T>(String op, String path, T Function() f) {
  try {
    return f();
  } on HostError catch (e) {
    throw _fsError(e, op, path);
  }
}

WebHost get _host => WebHost.instance;

bool _isAbs(String p) =>
    RegExp(r'^[A-Za-z]:[\\/]').hasMatch(p) ||
    p.startsWith(r'\\') ||
    p.startsWith('/');

String _parent(String p) {
  final s = p.replaceAll(RegExp(r'[\\/]+$'), '');
  final i = max(s.lastIndexOf(r'\'), s.lastIndexOf('/'));
  if (i < 0) return '.';
  if (i == 2 && s[1] == ':') return s.substring(0, 3);
  if (i == 0) return s.substring(0, 1);
  return s.substring(0, i);
}

String _join(String a, String b) =>
    a.endsWith(r'\') || a.endsWith('/') ? '$a$b' : '$a\\$b';

String _cwd = '';

String _currentDir() {
  if (_cwd.isEmpty) {
    final exe = '${_host.info()['exe'] ?? ''}';
    _cwd = exe.isEmpty ? r'C:\' : _parent(exe);
  }
  return _cwd;
}

String _absolute(String p) => _isAbs(p) ? p : _join(_currentDir(), p);

io.FileSystemEntityType _entityType(HostType t) => switch (t) {
  HostType.file => io.FileSystemEntityType.file,
  HostType.directory => io.FileSystemEntityType.directory,
  HostType.link => io.FileSystemEntityType.link,
  HostType.none => io.FileSystemEntityType.notFound,
};

final class _WebStat implements io.FileStat {
  _WebStat(HostStat s)
    : type = _entityType(s.type),
      size = s.type == HostType.none ? -1 : s.size,
      modified = DateTime.fromMillisecondsSinceEpoch(s.modifiedMs);
  @override
  final io.FileSystemEntityType type;
  @override
  final int size;
  @override
  final DateTime modified;
  @override
  DateTime get changed => modified;
  @override
  DateTime get accessed => modified;
  @override
  int get mode => 0;
  @override
  String modeString() => '---------';
}

io.FileStat _statSync(String path) =>
    _WebStat(_guard('stat', path, () => _host.stat(_absolute(path))));

io.FileSystemEntity _entity(String path, HostType t) =>
    t == HostType.directory ? WebDirectory(path) : WebFile(path);

abstract base class _Entity {
  _Entity(this.path);
  final String path;

  bool get isAbsolute => _isAbs(path);
  HostStat _stat() => _guard('stat', path, () => _host.stat(_absolute(path)));
  io.FileStat statSync() => _WebStat(_stat());
  Future<io.FileStat> stat() async => statSync();
  io.Directory get parent => WebDirectory(_parent(path));
  String resolveSymbolicLinksSync() => _absolute(path);
  Future<String> resolveSymbolicLinks() async => resolveSymbolicLinksSync();
  Stream<io.FileSystemEvent> watch({
    int events = io.FileSystemEvent.all,
    bool recursive = false,
  }) => throw UnsupportedError('watch on web32');

  @override
  String toString() =>
      "${runtimeType == WebFile ? 'File' : 'Directory'}: '$path'";
}

/// [io.File] on the shell's files.
final class WebFile extends _Entity implements io.File {
  WebFile(super.path);

  String get _abs => _absolute(path);

  @override
  io.File get absolute => WebFile(_abs);

  @override
  Uri get uri => Uri.file(_abs, windows: true);

  @override
  bool existsSync() => _stat().type == HostType.file;
  @override
  Future<bool> exists() async => existsSync();

  @override
  void createSync({bool recursive = false, bool exclusive = false}) =>
      _guard('Cannot create file', path, () {
        final exists = existsSync();
        if (exists && exclusive) {
          throw const HostError(80, 'The file exists.');
        }
        if (recursive) _host.mkdir(_parent(_abs));
        if (!exists) _host.write(_abs, const []);
      });
  @override
  Future<io.File> create({
    bool recursive = false,
    bool exclusive = false,
  }) async {
    createSync(recursive: recursive, exclusive: exclusive);
    return this;
  }

  @override
  io.File renameSync(String newPath) => _guard('Cannot rename file', path, () {
    _host.rename(_abs, _absolute(newPath));
    return WebFile(newPath);
  });
  @override
  Future<io.File> rename(String newPath) async => renameSync(newPath);

  @override
  io.File copySync(String newPath) => _guard('Cannot copy file', path, () {
    _host.copy(_abs, _absolute(newPath));
    return WebFile(newPath);
  });
  @override
  Future<io.File> copy(String newPath) async => copySync(newPath);

  @override
  void deleteSync({bool recursive = false}) => _guard(
    'Cannot delete file',
    path,
    () {
      if (_host.stat(_abs).type == HostType.none) {
        throw const HostError(2, 'The system cannot find the file specified.');
      }
      _host.remove(_abs, recursive: recursive);
    },
  );
  @override
  Future<io.FileSystemEntity> delete({bool recursive = false}) async {
    deleteSync(recursive: recursive);
    return this;
  }

  HostStat _fileStat(String op) {
    final s = _stat();
    if (s.type != HostType.file) {
      throw _fsError(
        const HostError(2, 'The system cannot find the file specified.'),
        op,
        path,
      );
    }
    return s;
  }

  @override
  int lengthSync() => _fileStat('Cannot retrieve length of file').size;
  @override
  Future<int> length() async => lengthSync();

  @override
  DateTime lastModifiedSync() => DateTime.fromMillisecondsSinceEpoch(
    _fileStat('Cannot retrieve modification time').modifiedMs,
  );
  @override
  Future<DateTime> lastModified() async => lastModifiedSync();
  @override
  DateTime lastAccessedSync() => lastModifiedSync();
  @override
  Future<DateTime> lastAccessed() async => lastModifiedSync();

  @override
  void setLastModifiedSync(DateTime time) => _guard(
    'Failed to set file modification time',
    path,
    () => _host.setModified(_abs, time.millisecondsSinceEpoch),
  );
  @override
  Future<void> setLastModified(DateTime time) async =>
      setLastModifiedSync(time);
  @override
  void setLastAccessedSync(DateTime time) {}
  @override
  Future<void> setLastAccessed(DateTime time) async {}

  @override
  io.RandomAccessFile openSync({io.FileMode mode = io.FileMode.read}) {
    final m = mode == io.FileMode.read
        ? 'r'
        : (mode == io.FileMode.append || mode == io.FileMode.writeOnlyAppend)
        ? 'a'
        : 'w';
    final h = _guard('Cannot open file', path, () => _host.fopen(_abs, m));
    final raf = _WebRaf(path, h);
    if (m == 'a') raf._pos = raf.lengthSync();
    return raf;
  }

  @override
  Future<io.RandomAccessFile> open({
    io.FileMode mode = io.FileMode.read,
  }) async => openSync(mode: mode);

  @override
  Stream<List<int>> openRead([int? start, int? end]) async* {
    final len = lengthSync();
    var at = start ?? 0;
    final stop = end == null ? len : min(end, len);
    const chunk = 1 << 16;
    while (at < stop) {
      final n = min(chunk, stop - at);
      yield _guard(
        'Cannot read file',
        path,
        () => _host.read(_abs, at, at + n),
      );
      at += n;
    }
  }

  @override
  io.IOSink openWrite({
    io.FileMode mode = io.FileMode.write,
    Encoding encoding = utf8,
  }) {
    final append =
        mode == io.FileMode.append || mode == io.FileMode.writeOnlyAppend;
    if (!append) {
      _guard('Cannot open file', path, () => _host.write(_abs, const []));
    }
    return _WebFileSink(this, encoding);
  }

  @override
  Uint8List readAsBytesSync() =>
      _guard('Cannot open file', path, () => _host.read(_abs));
  @override
  Future<Uint8List> readAsBytes() async => readAsBytesSync();

  @override
  String readAsStringSync({Encoding encoding = utf8}) =>
      encoding.decode(readAsBytesSync());
  @override
  Future<String> readAsString({Encoding encoding = utf8}) async =>
      readAsStringSync(encoding: encoding);

  @override
  List<String> readAsLinesSync({Encoding encoding = utf8}) =>
      const LineSplitter().convert(readAsStringSync(encoding: encoding));
  @override
  Future<List<String>> readAsLines({Encoding encoding = utf8}) async =>
      readAsLinesSync(encoding: encoding);

  @override
  void writeAsBytesSync(
    List<int> bytes, {
    io.FileMode mode = io.FileMode.write,
    bool flush = false,
  }) => _guard(
    'Cannot write file',
    path,
    () => _host.write(
      _abs,
      bytes,
      append: mode == io.FileMode.append || mode == io.FileMode.writeOnlyAppend,
    ),
  );
  @override
  Future<io.File> writeAsBytes(
    List<int> bytes, {
    io.FileMode mode = io.FileMode.write,
    bool flush = false,
  }) async {
    writeAsBytesSync(bytes, mode: mode, flush: flush);
    return this;
  }

  @override
  void writeAsStringSync(
    String contents, {
    io.FileMode mode = io.FileMode.write,
    Encoding encoding = utf8,
    bool flush = false,
  }) => writeAsBytesSync(encoding.encode(contents), mode: mode, flush: flush);
  @override
  Future<io.File> writeAsString(
    String contents, {
    io.FileMode mode = io.FileMode.write,
    Encoding encoding = utf8,
    bool flush = false,
  }) async {
    writeAsStringSync(contents, mode: mode, encoding: encoding, flush: flush);
    return this;
  }
}

/// [io.Directory] on the shell's files.
final class WebDirectory extends _Entity implements io.Directory {
  WebDirectory(super.path);

  String get _abs => _absolute(path);

  @override
  io.Directory get absolute => WebDirectory(_abs);

  @override
  Uri get uri => Uri.directory(_abs, windows: true);

  @override
  bool existsSync() => _stat().type == HostType.directory;
  @override
  Future<bool> exists() async => existsSync();

  @override
  void createSync({bool recursive = false}) =>
      _guard('Creation failed', path, () => _host.mkdir(_abs));
  @override
  Future<io.Directory> create({bool recursive = false}) async {
    createSync(recursive: recursive);
    return this;
  }

  static final Random _rnd = Random();

  @override
  io.Directory createTempSync([String? prefix]) {
    final name =
        '${prefix ?? ''}${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}'
        '${_rnd.nextInt(1 << 30).toRadixString(36)}';
    final d = WebDirectory(_join(path, name));
    d.createSync();
    return d;
  }

  @override
  Future<io.Directory> createTemp([String? prefix]) async =>
      createTempSync(prefix);

  @override
  void deleteSync({bool recursive = false}) => _guard(
    'Deletion failed',
    path,
    () {
      if (_host.stat(_abs).type == HostType.none) {
        throw const HostError(3, 'The system cannot find the path specified.');
      }
      _host.remove(_abs, recursive: recursive);
    },
  );
  @override
  Future<io.FileSystemEntity> delete({bool recursive = false}) async {
    deleteSync(recursive: recursive);
    return this;
  }

  @override
  io.Directory renameSync(String newPath) => _guard('Rename failed', path, () {
    _host.rename(_abs, _absolute(newPath));
    return WebDirectory(newPath);
  });
  @override
  Future<io.Directory> rename(String newPath) async => renameSync(newPath);

  @override
  List<io.FileSystemEntity> listSync({
    bool recursive = false,
    bool followLinks = true,
  }) {
    final out = <io.FileSystemEntity>[];
    void walk(String dir) {
      final items = _guard(
        'Directory listing failed',
        dir,
        () => _host.list(_absolute(dir)),
      );
      for (final (name, t) in items) {
        final p = _join(dir, name);
        out.add(_entity(p, t));
        if (recursive && t == HostType.directory) walk(p);
      }
    }

    walk(path);
    return out;
  }

  @override
  Stream<io.FileSystemEntity> list({
    bool recursive = false,
    bool followLinks = true,
  }) async* {
    for (final e in listSync(recursive: recursive, followLinks: followLinks)) {
      yield e;
    }
  }
}

final class _WebRaf implements io.RandomAccessFile {
  _WebRaf(this.path, this._h);
  @override
  final String path;
  final int _h;
  int _pos = 0;
  bool _closed = false;

  T _g<T>(String op, T Function() f) {
    if (_closed) {
      throw io.FileSystemException('File closed', path);
    }
    return _guard(op, path, f);
  }

  @override
  void closeSync() {
    if (_closed) return;
    _g('close', () => _host.fclose(_h));
    _closed = true;
  }

  @override
  Future<void> close() async => closeSync();

  @override
  Uint8List readSync(int count) => _g('read', () {
    final b = _host.fread(_h, _pos, count);
    _pos += b.length;
    return b;
  });
  @override
  Future<Uint8List> read(int count) async => readSync(count);

  @override
  int readByteSync() {
    final b = readSync(1);
    return b.isEmpty ? -1 : b[0];
  }

  @override
  Future<int> readByte() async => readByteSync();

  @override
  int readIntoSync(List<int> buffer, [int start = 0, int? end]) {
    final b = readSync((end ?? buffer.length) - start);
    buffer.setRange(start, start + b.length, b);
    return b.length;
  }

  @override
  Future<int> readInto(List<int> buffer, [int start = 0, int? end]) async =>
      readIntoSync(buffer, start, end);

  @override
  void writeFromSync(List<int> buffer, [int start = 0, int? end]) =>
      _g('write', () {
        final data = buffer.sublist(start, end);
        _host.fwrite(_h, _pos, data);
        _pos += data.length;
      });
  @override
  Future<io.RandomAccessFile> writeFrom(
    List<int> buffer, [
    int start = 0,
    int? end,
  ]) async {
    writeFromSync(buffer, start, end);
    return this;
  }

  @override
  int writeByteSync(int value) {
    writeFromSync([value]);
    return 1;
  }

  @override
  Future<io.RandomAccessFile> writeByte(int value) async {
    writeByteSync(value);
    return this;
  }

  @override
  void writeStringSync(String string, {Encoding encoding = utf8}) =>
      writeFromSync(encoding.encode(string));
  @override
  Future<io.RandomAccessFile> writeString(
    String string, {
    Encoding encoding = utf8,
  }) async {
    writeStringSync(string, encoding: encoding);
    return this;
  }

  @override
  int positionSync() => _pos;
  @override
  Future<int> position() async => _pos;
  @override
  void setPositionSync(int position) => _pos = position;
  @override
  Future<io.RandomAccessFile> setPosition(int position) async {
    _pos = position;
    return this;
  }

  @override
  void truncateSync(int length) =>
      _g('truncate', () => _host.ftruncate(_h, length));
  @override
  Future<io.RandomAccessFile> truncate(int length) async {
    truncateSync(length);
    return this;
  }

  @override
  int lengthSync() => _g('length', () => _host.fsize(_h));
  @override
  Future<int> length() async => lengthSync();

  @override
  void flushSync() => _g('flush', () => _host.fsync(_h));
  @override
  Future<io.RandomAccessFile> flush() async {
    flushSync();
    return this;
  }

  @override
  void lockSync([
    io.FileLock mode = io.FileLock.exclusive,
    int start = 0,
    int end = -1,
  ]) {}
  @override
  Future<io.RandomAccessFile> lock([
    io.FileLock mode = io.FileLock.exclusive,
    int start = 0,
    int end = -1,
  ]) async => this;
  @override
  void unlockSync([int start = 0, int end = -1]) {}
  @override
  Future<io.RandomAccessFile> unlock([int start = 0, int end = -1]) async =>
      this;
}

final class _WebFileSink implements io.IOSink {
  _WebFileSink(this._file, this.encoding);
  final WebFile _file;
  @override
  Encoding encoding;
  final Completer<void> _done = Completer();

  @override
  void add(List<int> data) =>
      _file.writeAsBytesSync(data, mode: io.FileMode.append);
  @override
  void addError(Object error, [StackTrace? stackTrace]) {
    if (!_done.isCompleted) _done.completeError(error, stackTrace);
  }

  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(add);
  @override
  Future<void> close() async {
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<void> get done => _done.future;
  @override
  Future<void> flush() async {}
  @override
  void write(Object? object) => add(encoding.encode('$object'));
  @override
  void writeAll(Iterable<Object?> objects, [String sep = '']) =>
      write(objects.join(sep));
  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));
  @override
  void writeln([Object? object = '']) => write('$object\n');
}

/// `stdout`/`stderr` → the shell's log (and the browser console).
final class _LogStdout implements io.Stdout {
  _LogStdout(this.name);
  final String name;
  final StringBuffer _line = StringBuffer();
  @override
  Encoding encoding = utf8;

  void _emit(String s) {
    for (final ch in s.split('')) {
      if (ch == '\n') {
        final l = _line.toString();
        _line.clear();
        try {
          _host.log('[$name] $l');
        } on Object {
          // logging must never break the app
        }
      } else {
        _line.write(ch);
      }
    }
  }

  @override
  void write(Object? object) => _emit('$object');
  @override
  void writeln([Object? object = '']) => _emit('$object\n');
  @override
  void writeAll(Iterable<Object?> objects, [String sep = '']) =>
      _emit(objects.join(sep));
  @override
  void writeCharCode(int charCode) => _emit(String.fromCharCode(charCode));
  @override
  void add(List<int> data) => _emit(encoding.decode(data));
  @override
  void addError(Object error, [StackTrace? stackTrace]) => _emit('$error\n');
  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(add);
  @override
  Future<void> close() async {}
  @override
  Future<void> get done async {}
  @override
  Future<void> flush() async {}
  @override
  bool get hasTerminal => false;
  @override
  int get terminalColumns => 80;
  @override
  int get terminalLines => 25;
  @override
  bool get supportsAnsiEscapes => false;
  @override
  io.IOSink get nonBlocking => this;
  @override
  String get lineTerminator => '\n';
  @override
  set lineTerminator(String value) {}
}

/// Installs the edition's dart:io behaviour (files, temp dir, stdout, no raw sockets).
final class WebIOOverrides extends io.IOOverrides {
  // The shell's log lives as long as the app; nothing to close.
  // ignore: close_sinks
  final io.Stdout _out = _LogStdout('out');
  // ignore: close_sinks
  final io.Stdout _err = _LogStdout('err');

  @override
  io.Directory createDirectory(String path) => WebDirectory(path);
  @override
  io.File createFile(String path) => WebFile(path);
  @override
  io.Directory getCurrentDirectory() => WebDirectory(_currentDir());
  @override
  void setCurrentDirectory(String path) => _cwd = _absolute(path);
  @override
  io.Directory getSystemTempDirectory() {
    final i = _host.info();
    final t = '${i['temp'] ?? ''}';
    return WebDirectory(t.isEmpty ? _absolute('temp') : t);
  }

  @override
  Future<io.FileStat> stat(String path) async => _statSync(path);
  @override
  io.FileStat statSync(String path) => _statSync(path);
  @override
  Future<bool> fseIdentical(String path1, String path2) async =>
      fseIdenticalSync(path1, path2);
  @override
  bool fseIdenticalSync(String path1, String path2) =>
      _absolute(path1).toLowerCase() == _absolute(path2).toLowerCase();
  @override
  Future<io.FileSystemEntityType> fseGetType(
    String path,
    bool followLinks,
  ) async => fseGetTypeSync(path, followLinks);
  @override
  io.FileSystemEntityType fseGetTypeSync(String path, bool followLinks) =>
      _statSync(path).type;
  @override
  bool fsWatchIsSupported() => false;
  @override
  io.Link createLink(String path) => throw UnsupportedError('links on web32');

  @override
  Future<io.Socket> socketConnect(
    dynamic host,
    int port, {
    dynamic sourceAddress,
    int sourcePort = 0,
    Duration? timeout,
  }) async => throw io.SocketException(
    'raw sockets are not available on web32',
    port: port,
  );

  @override
  Future<io.ConnectionTask<io.Socket>> socketStartConnect(
    dynamic host,
    int port, {
    dynamic sourceAddress,
    int sourcePort = 0,
  }) async => throw io.SocketException(
    'raw sockets are not available on web32',
    port: port,
  );

  @override
  Future<io.ServerSocket> serverSocketBind(
    dynamic address,
    int port, {
    int backlog = 0,
    bool v6Only = false,
    bool shared = false,
  }) async => throw io.SocketException(
    'servers are not available on web32',
    port: port,
  );

  @override
  io.Stdout get stdout => _out;
  @override
  io.Stdout get stderr => _err;
}
