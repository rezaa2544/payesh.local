import 'package:payesh_core/io.dart';

/// Row 163 — a school server installed on THIS computer, started by the app when it is not
/// running (nothing for the user to do or type).
///
/// Why: the old school window (desktop\Payesh.exe of installer/payesh.iss) started the school
/// server itself; the native app only looked for it. Since the school moved to the native app
/// nobody started that server any more, so the login could never reach it — while the owner
/// panel (which talks to the database directly) showed the database as connected.
///
/// Order (Windows only):
///  1. the Payesh Data Service (install/windows/data-service, now part of the Windows installer):
///     its boot task `PayeshDataService` is asked to run;
///  2. the school system of installer/payesh.iss: `server\start.js` with its own node, the same
///     command, data folder and port its window used (`PORT=8080`, `PAYESH_DATA`).
/// The server's own supervisor lock (server/start.js) keeps a second copy from starting.
final class LocalSchoolServer {
  LocalSchoolServer({
    Map<String, String>? env,
    bool Function(String path)? exists,
    Future<ProcessResult> Function(String exe, List<String> args)? run,
    Future<void> Function(
      String exe,
      List<String> args,
      String cwd,
      Map<String, String> env,
    )?
    spawn,
    bool? windows,
  }) : _env = env ?? Platform.environment,
       _exists = exists ?? ((p) => File(p).existsSync()),
       _run = run ?? ((e, a) => Process.run(e, a)),
       _spawn = spawn ?? _spawnDetached,
       _windows = windows ?? Platform.isWindows;

  final Map<String, String> _env;
  final bool Function(String path) _exists;
  final Future<ProcessResult> Function(String exe, List<String> args) _run;
  final Future<void> Function(
    String exe,
    List<String> args,
    String cwd,
    Map<String, String> env,
  )
  _spawn;
  final bool _windows;

  static Future<void> _spawnDetached(
    String exe,
    List<String> args,
    String cwd,
    Map<String, String> env,
  ) async {
    await Process.start(
      exe,
      args,
      workingDirectory: cwd,
      environment: env,
      mode: ProcessStartMode.detached,
    );
  }

  String get _pf => _env['ProgramFiles'] ?? r'C:\Program Files';
  String get _pf86 => _env['ProgramFiles(x86)'] ?? r'C:\Program Files (x86)';

  /// Folder of the Payesh Data Service, or null.
  String? get dataService {
    final d = '$_pf\\PayeshDataService';
    return _exists('$d\\server\\start.js') ? d : null;
  }

  /// Folder of the school system (installer/payesh.iss), or null.
  String? get schoolSystem {
    for (final d in [
      '$_pf\\Payesh',
      '$_pf\\Payesh-لوکال',
      '$_pf86\\Payesh-لوکال',
      r'C:\Payesh',
    ]) {
      if (_exists('$d\\server\\start.js')) return d;
    }
    return null;
  }

  /// The data folder the school window used (desktop/PayeshApp.cs `ResolveDataDir`).
  String dataDir() {
    final env = _env['PAYESH_DATA'];
    if (env != null && env.isNotEmpty) return env;
    final common = '${_env['ProgramData'] ?? r'C:\ProgramData'}\\Payesh\\data';
    if (_exists('$common\\payesh.sqlite')) return common;
    final local = _env['LOCALAPPDATA'];
    if (local != null && _exists('$local\\Payesh\\data\\payesh.sqlite')) {
      return '$local\\Payesh\\data';
    }
    return common;
  }

  /// Starts a school server installed here; true when one was asked to start.
  Future<bool> start() async {
    if (!_windows) return false;
    if (dataService != null) {
      try {
        final r = await _run('schtasks.exe', [
          '/Run',
          '/TN',
          'PayeshDataService',
        ]);
        if (r.exitCode == 0) return true;
      } on Object {
        // fall through to the school system
      }
    }
    final dir = schoolSystem ?? dataService;
    if (dir == null) return false;
    final node = [
      '$dir\\runtime\\node.exe',
      '$dir\\node.exe',
      '$_pf\\nodejs\\node.exe',
    ].firstWhere(_exists, orElse: () => '');
    if (node.isEmpty) return false;
    final service = dir == dataService && schoolSystem == null;
    try {
      await _spawn(
        node,
        [
          '--experimental-sqlite',
          '--disable-warning=ExperimentalWarning',
          'server\\start.js',
        ],
        dir,
        {
          'PORT': '8080',
          'PAYESH_DATA': dataDir(),
          if (service) 'PAYESH_HEADLESS': '1',
          if (!service) 'PAYESH_TUNNEL_AUTO': '1',
        },
      );
      return true;
    } on Object {
      return false;
    }
  }
}
