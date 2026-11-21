// dart:io's Platform / Process / exit / pid for the 32-bit Windows edition (row 169, D-50).
// They answer from the shell (tools/web32/shell), so the edition behaves like the Windows
// build: same paths, same environment, same helper processes.
import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import 'host.dart';

Map<String, Object?> get _info => WebHost.instance.info();

/// Same static API as dart:io's `Platform`.
abstract final class Platform {
  static String get operatingSystem => '${_info['os'] ?? 'windows'}';
  static String get operatingSystemVersion => '${_info['osVersion'] ?? ''}';
  static bool get isWindows => operatingSystem == 'windows';
  static bool get isAndroid => false;
  static bool get isLinux => false;
  static bool get isMacOS => false;
  static bool get isIOS => false;
  static bool get isFuchsia => false;
  static String get pathSeparator => isWindows ? r'\' : '/';
  static String get lineTerminator => isWindows ? '\r\n' : '\n';
  static int get numberOfProcessors => (_info['cpus'] as num?)?.toInt() ?? 1;
  static String get localHostname => '${_info['hostname'] ?? 'localhost'}';
  static String get localeName => '${_info['locale'] ?? 'fa_IR'}';
  static String get resolvedExecutable => '${_info['exe'] ?? ''}';
  static String get executable => resolvedExecutable;
  static List<String> get executableArguments => const [];
  static String get version => 'web32';
  static Uri get script => Uri.file(resolvedExecutable, windows: isWindows);
  static Map<String, String> get environment => _env ??= Map.unmodifiable(
    (_info['env'] as Map? ?? const {}).map((k, v) => MapEntry('$k', '$v')),
  );
  static Map<String, String>? _env;
}

/// The process id of the shell.
int get pid => (_info['pid'] as num?)?.toInt() ?? 0;

/// Closes the edition (the shell quits with [code]).
Never exit(int code) {
  WebHost.instance.exit(code);
  throw StateError('exit($code)');
}

String _decode(String s, Encoding? enc) => s;

/// Same static API as dart:io's `Process` (the subset Payesh uses).
abstract final class Process {
  static Future<io.ProcessResult> run(
    String executable,
    List<String> arguments, {
    String? workingDirectory,
    Map<String, String>? environment,
    bool includeParentEnvironment = true,
    bool runInShell = false,
    Encoding? stdoutEncoding = io.systemEncoding,
    Encoding? stderrEncoding = io.systemEncoding,
  }) async => runSync(
    executable,
    arguments,
    workingDirectory: workingDirectory,
    runInShell: runInShell,
    stdoutEncoding: stdoutEncoding,
    stderrEncoding: stderrEncoding,
  );

  static io.ProcessResult runSync(
    String executable,
    List<String> arguments, {
    String? workingDirectory,
    Map<String, String>? environment,
    bool includeParentEnvironment = true,
    bool runInShell = false,
    Encoding? stdoutEncoding = io.systemEncoding,
    Encoding? stderrEncoding = io.systemEncoding,
  }) {
    final (exe, args) = runInShell
        ? ('cmd.exe', ['/c', executable, ...arguments])
        : (executable, arguments);
    final HostRun r;
    try {
      r = WebHost.instance.run(exe, args, cwd: workingDirectory);
    } on HostError catch (e) {
      throw io.ProcessException(executable, arguments, e.message, e.code);
    }
    return io.ProcessResult(
      r.pid,
      r.code,
      _decode(r.out, stdoutEncoding),
      _decode(r.err, stderrEncoding),
    );
  }

  static Future<io.Process> start(
    String executable,
    List<String> arguments, {
    String? workingDirectory,
    Map<String, String>? environment,
    bool includeParentEnvironment = true,
    bool runInShell = false,
    io.ProcessStartMode mode = io.ProcessStartMode.normal,
  }) async {
    final (exe, args) = runInShell
        ? ('cmd.exe', ['/c', executable, ...arguments])
        : (executable, arguments);
    if (mode == io.ProcessStartMode.detached ||
        mode == io.ProcessStartMode.detachedWithStdio) {
      try {
        return _WebProcess.detached(
          WebHost.instance.spawn(exe, args, cwd: workingDirectory),
        );
      } on HostError catch (e) {
        throw io.ProcessException(executable, arguments, e.message, e.code);
      }
    }
    final r = runSync(
      executable,
      arguments,
      workingDirectory: workingDirectory,
      runInShell: runInShell,
    );
    return _WebProcess.finished(r);
  }

  static bool killPid(
    int pid, [
    io.ProcessSignal signal = io.ProcessSignal.sigterm,
  ]) => WebHost.instance.kill(pid);
}

/// A process the shell started (detached) or already ran to the end.
final class _WebProcess implements io.Process {
  _WebProcess.detached(this.pid)
    : exitCode = Completer<int>().future,
      stdout = const Stream.empty(),
      stderr = const Stream.empty();

  _WebProcess.finished(io.ProcessResult r)
    : pid = r.pid,
      exitCode = Future.value(r.exitCode),
      stdout = Stream.value(utf8.encode('${r.stdout}')),
      stderr = Stream.value(utf8.encode('${r.stderr}'));

  @override
  final int pid;
  @override
  final Future<int> exitCode;
  @override
  final Stream<List<int>> stdout;
  @override
  final Stream<List<int>> stderr;
  @override
  io.IOSink get stdin => throw UnsupportedError('stdin of a web32 process');
  @override
  bool kill([io.ProcessSignal signal = io.ProcessSignal.sigterm]) =>
      WebHost.instance.kill(pid);
}
