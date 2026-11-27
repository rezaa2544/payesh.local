// 32-bit Windows edition: SQLite3MC as WebAssembly on the shell's files (row 169, D-50).
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:math';
import 'dart:typed_data';

import 'package:payesh_core/web_host.dart';
import 'package:sqlite3/common.dart';
import 'package:sqlite3/wasm.dart' show WasmSqlite3;

export 'package:sqlite3/common.dart';

/// Same name as the native `Database` type.
typedef Database = CommonDatabase;

CommonSqlite3? _sqlite3;

/// The loaded WebAssembly SQLite (after [prepareWebSqlite]).
CommonSqlite3 get sqlite3 =>
    _sqlite3 ?? (throw StateError('prepareWebSqlite() was not called'));

/// Loads `sqlite3mc.wasm` (shipped next to the app) and registers [HostFileSystem], so
/// `sqlite3.open(r'C:\…\payesh.db')` opens the real file.
/// [wasmBytes] instead of the URL is for the conformance check (tool/web32_sqlite_check).
Future<void> prepareWebSqlite({
  String wasmUrl = 'sqlite3mc.wasm',
  Uint8List? wasmBytes,
}) async {
  if (_sqlite3 != null) return;
  final s = wasmBytes != null
      ? await WasmSqlite3.load(wasmBytes)
      : await WasmSqlite3.loadFromUrlString(resolveAgainstDocument(wasmUrl));
  s.registerVirtualFileSystem(HostFileSystem(), makeDefault: true);
  _sqlite3 = _CipherSqlite3(s);
}

/// Row 199: a relative [url] resolved like the page's own scripts — against the document's
/// `<base href>` (the browser edition lives in a per-build folder, `/v/<build>/`), not the
/// page address, which is what `Uri.base` gives. Outside a page (node checks) it is unchanged.
String resolveAgainstDocument(String url) {
  final doc = globalContext.getProperty<JSAny?>('document'.toJS);
  if (doc == null || !doc.isA<JSObject>()) return url;
  final base = (doc as JSObject).getProperty<JSAny?>('baseURI'.toJS);
  if (base == null || !base.isA<JSString>()) return url;
  return Uri.parse((base as JSString).toDart).resolve(url).toString();
}

/// SQLite3MC encrypts only through its own VFS layer: opening with the VFS name
/// `multipleciphers-<real vfs>` makes SQLite3MC create that layer over [HostFileSystem]
/// (sqlite3mcCheckVfs). Without it `PRAGMA hexkey` fails ("Encryption is not supported by
/// the VFS") — and the app fails closed instead of writing plaintext.
final class _CipherSqlite3 implements CommonSqlite3 {
  _CipherSqlite3(this._inner);
  final CommonSqlite3 _inner;

  static const String cipherVfs = 'multipleciphers-payesh-host';

  @override
  Version get version => _inner.version;

  @override
  CommonDatabase open(
    String filename, {
    String? vfs,
    OpenMode mode = OpenMode.readWriteCreate,
    bool uri = false,
    bool? mutex,
  }) => _inner.open(
    filename,
    vfs: vfs ?? cipherVfs,
    mode: mode,
    uri: uri,
    mutex: mutex,
  );

  @override
  CommonDatabase openInMemory({String? vfs}) => _inner.openInMemory(vfs: vfs);

  @override
  String? get tempDirectory => _inner.tempDirectory;

  @override
  set tempDirectory(String? value) => _inner.tempDirectory = value;

  @override
  void registerVirtualFileSystem(
    VirtualFileSystem vfs, {
    bool makeDefault = false,
  }) => _inner.registerVirtualFileSystem(vfs, makeDefault: makeDefault);

  @override
  void unregisterVirtualFileSystem(VirtualFileSystem vfs) =>
      _inner.unregisterVirtualFileSystem(vfs);
}

/// SQLite VFS over the shell's synchronous file handles (`payeshHost.fopen/fread/…`).
final class HostFileSystem extends BaseVirtualFileSystem {
  HostFileSystem({WebHost? host, super.name = 'payesh-host'})
    : _hostOverride = host;

  final WebHost? _hostOverride;
  WebHost get host => _hostOverride ?? WebHost.instance;

  @override
  int xAccess(String path, int flags) =>
      host.stat(path).type == HostType.file ? 1 : 0;

  @override
  void xDelete(String path, int syncDir) {
    try {
      host.remove(path);
    } on HostError catch (e) {
      if (e.code != 2 && e.code != 3) {
        throw const VfsException(SqlExtendedError.SQLITE_IOERR_DELETE);
      }
    }
  }

  @override
  String xFullPathName(String path) => path;

  @override
  XOpenResult xOpen(Sqlite3Filename path, int flags) {
    final name =
        path.path ??
        '${host.info()['temp'] ?? r'C:\Windows\Temp'}\\payesh-sqlite-'
            '${Random().nextInt(1 << 30).toRadixString(36)}';
    final exists = host.stat(name).type == HostType.file;
    final create = flags & SqlFlag.SQLITE_OPEN_CREATE != 0;
    final readOnly = flags & SqlFlag.SQLITE_OPEN_READONLY != 0;
    if (!exists && !create) throw const VfsException(SqlError.SQLITE_CANTOPEN);
    final int handle;
    try {
      handle = host.fopen(name, readOnly ? 'r' : 'rw');
    } on HostError {
      throw const VfsException(SqlError.SQLITE_CANTOPEN);
    }
    return (
      outFlags: 0,
      file: _HostFile(
        this,
        name,
        handle,
        flags & SqlFlag.SQLITE_OPEN_DELETEONCLOSE != 0,
      ),
    );
  }

  @override
  void xSleep(Duration duration) {}
}

final class _HostFile extends BaseVfsFile {
  _HostFile(this.vfs, this.path, this.handle, this.deleteOnClose);
  final HostFileSystem vfs;
  final String path;
  final int handle;
  final bool deleteOnClose;
  int _lock = SqlFileLockingLevels.SQLITE_LOCK_NONE;

  WebHost get _h => vfs.host;

  T _io<T>(int code, T Function() f) {
    try {
      return f();
    } on HostError {
      throw VfsException(code);
    }
  }

  @override
  int readInto(Uint8List buffer, int offset) =>
      _io(SqlExtendedError.SQLITE_IOERR_READ, () {
        final b = _h.fread(handle, offset, buffer.length);
        buffer.setRange(0, b.length, b);
        return b.length;
      });

  @override
  void xWrite(Uint8List buffer, int fileOffset) => _io(
    SqlExtendedError.SQLITE_IOERR_WRITE,
    () => _h.fwrite(handle, fileOffset, buffer),
  );

  @override
  void xTruncate(int size) => _io(
    SqlExtendedError.SQLITE_IOERR_TRUNCATE,
    () => _h.ftruncate(handle, size),
  );

  @override
  void xSync(int flags) =>
      _io(SqlExtendedError.SQLITE_IOERR_FSYNC, () => _h.fsync(handle));

  @override
  int xFileSize() =>
      _io(SqlExtendedError.SQLITE_IOERR_FSTAT, () => _h.fsize(handle));

  @override
  void xClose() {
    _io(SqlExtendedError.SQLITE_IOERR_CLOSE, () => _h.fclose(handle));
    if (deleteOnClose) vfs.xDelete(path, 0);
  }

  @override
  void xLock(int mode) => _lock = mode;

  @override
  void xUnlock(int mode) => _lock = mode;

  @override
  int xCheckReservedLock() =>
      _lock >= SqlFileLockingLevels.SQLITE_LOCK_RESERVED ? 1 : 0;
}
