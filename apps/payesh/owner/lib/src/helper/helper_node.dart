// سرور کمکیِ همین دستگاه (پیش‌فرض روشن) + فرستادن کار با «هرگز متوقف نمی‌شود».
//
// هر چرخه:
//   ۱) هر ۶۰ ثانیه حضور (payesh/helpers/<id>.json) نوشته می‌شود؛
//   ۲) یک ListObjectsV2 روی payesh/jobs/ ⇒ درخواست‌های بی‌نتیجه و بی‌رزروِ زنده؛
//   ۳) رزرو: PUT lease با توکن تصادفی، ۱٫۵ ثانیه صبر، دوباره خواندن ⇒ فقط اگر توکن خودمان
//      مانده باشد کار را انجام می‌دهیم (دو سرور کمکی هم‌زمان ⇒ فقط یکی)؛
//   ۴) اجرا (هم‌زمان حداکثر [slots] کار = نصف هسته‌ها، ۱ تا ۴)، تمدید رزرو هر ۲۰ ثانیه؛
//   ۵) نتیجهٔ مهرشده در payesh/jobs/res/<id>.json.
// فاصلهٔ چرخه‌ها هوشمند است: وقتی کار هست ۳ ثانیه، وقتی نیست ۵ ← ۱۰ ← ۲۰ ← ۳۰ ثانیه.

import 'dart:async';
import 'dart:io';
import 'dart:math';

import '../local/s3_client.dart';
import 'helper_box.dart';
import 'helper_jobs.dart';

typedef Sleeper = Future<void> Function(Duration d);

Future<void> _realSleep(Duration d) => Future<void>.delayed(d);

/// یک کار انجام‌شده (برای نمایش).
final class HelperJobLog {
  const HelperJobLog(this.jobId, this.kind, this.ok, this.at, this.ms);
  final String jobId;
  final String kind;
  final bool ok;
  final DateTime at;
  final int ms;
}

/// نتیجهٔ یک کار فرستاده‌شده.
final class JobOutcome {
  const JobOutcome({
    required this.ok,
    required this.by,
    this.why,
    this.result,
    this.error,
  });

  final bool ok;

  /// `local` یا شناسهٔ سرور کمکی.
  final String by;

  /// چرا محلی انجام شد (no_helper، not_claimed، lease_expired، …).
  final String? why;
  final Map<String, Object?>? result;
  final String? error;

  bool get byHelper => by != 'local';
}

int defaultSlots([int? cores]) =>
    ((cores ?? Platform.numberOfProcessors) ~/ 2).clamp(1, 4);

final class HelperNode {
  HelperNode({
    required this.helperId,
    required this.transport,
    required this.executor,
    DateTime Function()? now,
    Sleeper? sleep,
    String? host,
    this.version = '',
    int? slots,
    Random? random,
    this.acceptWork,
  }) : _now = now ?? DateTime.now,
       _sleep = sleep ?? _realSleep,
       host = host ?? _hostName(),
       slots = slots ?? defaultSlots(),
       _rnd = random ?? Random.secure();

  final String helperId;
  final S3Transport Function() transport;
  final JobExecutor executor;

  /// false ⇒ مالک «پردازش کمکی» را خاموش کرده: صف کارها خوانده نمی‌شود (فقط حضور).
  final bool Function()? acceptWork;
  final String host;
  final String version;
  final int slots;
  final DateTime Function() _now;
  final Sleeper _sleep;
  final Random _rnd;

  static String _hostName() {
    try {
      return Platform.localHostname;
    } on Object {
      return '';
    }
  }

  S3Settings? _s3;
  bool _paused = false;
  bool _running = false;
  Timer? _timer;
  DateTime? _lastPresence;
  DateTime? _lastGc;
  int _idleStep = 0;
  int done = 0;
  int failed = 0;
  String? lastError;
  DateTime? lastPoll;
  final Set<String> _active = {};
  final Set<String> _foreign = {};
  final List<HelperJobLog> recent = [];
  final _changes = StreamController<void>.broadcast();

  /// هر تغییر وضعیت (برای رابط کاربری).
  Stream<void> get changes => _changes.stream;
  bool get paused => _paused;
  bool get configured => _s3 != null;
  bool get running => _running;
  int get activeJobs => _active.length;

  void _notify() {
    if (!_changes.isClosed) _changes.add(null);
  }

  /// تنظیم یا عوض کردن صندوقچه (null ⇒ سرور کمکی بیکار).
  void configure(S3Settings? s3) {
    final changed = s3 == null || _s3 == null || !s3.sameTarget(_s3!);
    _s3 = s3;
    if (changed) {
      _lastPresence = null;
      _foreign.clear();
    }
    _notify();
  }

  /// توقف موقت / ادامه (حضور با paused=true اعلام می‌شود تا کسی کار نفرستد).
  Future<void> setPaused(bool v) async {
    _paused = v;
    _lastPresence = null;
    _notify();
    if (_s3 != null) {
      try {
        await _writePresence(_s3!);
      } on Object {
        // چرخهٔ بعد
      }
    }
  }

  void start() {
    if (_running) return;
    _running = true;
    _schedule(const Duration(seconds: 3));
  }

  void stop() {
    _running = false;
    _timer?.cancel();
    _timer = null;
  }

  Future<void> dispose() async {
    stop();
    await _changes.close();
  }

  void _schedule(Duration d) {
    _timer?.cancel();
    if (!_running) return;
    _timer = Timer(d, () async {
      final next = await tick();
      _schedule(next);
    });
  }

  Duration _idle() {
    const steps = [5, 10, 20, 30];
    final d = Duration(seconds: steps[min(_idleStep, steps.length - 1)]);
    if (_idleStep < steps.length - 1) _idleStep++;
    return d;
  }

  /// یک چرخه؛ فاصلهٔ چرخهٔ بعد را برمی‌گرداند.
  Future<Duration> tick() async {
    final s3 = _s3;
    if (s3 == null) return const Duration(seconds: 30);
    final now = _now();
    lastPoll = now;
    try {
      if (_lastPresence == null ||
          now.difference(_lastPresence!) >= presenceEvery) {
        await _writePresence(s3);
      }
      if (_paused) return const Duration(seconds: 30);
      if (!(acceptWork?.call() ?? true)) return const Duration(seconds: 30);
      if (_lastGc == null || now.difference(_lastGc!) >= gcJobAge) {
        _lastGc = now;
        unawaited(executor.gc(s3).then((_) {}, onError: (_) {}));
      }
      if (_active.length >= slots) return const Duration(seconds: 3);
      final found = await _pollOnce(s3);
      lastError = null;
      _notify();
      if (found) {
        _idleStep = 0;
        return const Duration(seconds: 3);
      }
      return _idle();
    } on S3Failure catch (e) {
      lastError = e.messageFa;
      _notify();
      return const Duration(seconds: 30);
    } on Object catch (e) {
      lastError = '$e';
      _notify();
      return const Duration(seconds: 30);
    }
  }

  Future<void> _writePresence(S3Settings s3) async {
    final now = _now();
    final t = transport();
    try {
      await s3PutJson(
        s3,
        t,
        '$helperRoot${HelperDirs.helpers}$helperId.json',
        await sealHelper(
          s3.secretKey,
          HelperKinds.presence,
          now.millisecondsSinceEpoch,
          HelperPresence(
            helperId: helperId,
            host: host,
            version: version,
            slots: slots,
            paused: _paused,
            kinds: jobKinds,
            at: now,
            done: done,
            failed: failed,
          ).toPlain(),
        ),
      );
      _lastPresence = now;
    } finally {
      t.close();
    }
  }

  /// true اگر کاری پیدا شد (حتی اگر رزرو به دیگری رسید).
  Future<bool> _pollOnce(S3Settings s3) async {
    final t = transport();
    final List<S3Object> objs;
    try {
      (objs, _) = await s3ListObjects(s3, t, '${helperRoot}jobs/', maxPages: 1);
    } finally {
      t.close();
    }
    final req = <String>[], lease = <String, DateTime?>{}, res = <String>{};
    for (final o in objs) {
      final rel = o.key.substring('${helperRoot}jobs/'.length);
      final id = nameOfKey(o.key);
      if (!jobIdRe.hasMatch(id)) continue;
      if (rel.startsWith('req/')) req.add(id);
      if (rel.startsWith('lease/')) lease[id] = o.modified;
      if (rel.startsWith('res/')) res.add(id);
    }
    req.sort();
    final now = _now();
    var found = false;
    for (final id in req) {
      if (_active.length >= slots) break;
      if (res.contains(id) || _active.contains(id) || _foreign.contains(id)) {
        continue;
      }
      if (now.millisecondsSinceEpoch - jobIdMillis(id) >
          jobDeadline.inMilliseconds) {
        continue; // کهنه: برای gc
      }
      if (lease.containsKey(id)) {
        final m = lease[id];
        // رزرو زنده (تمدید هر ۲۰ ثانیه) ⇒ دست نمی‌زنیم
        if (m == null || now.difference(m) <= leaseFor) continue;
      }
      found = true;
      await _tryClaim(s3, id);
    }
    return found;
  }

  Future<void> _tryClaim(S3Settings s3, String id) async {
    final t = transport();
    Map<String, Object?>? reqPlain;
    final token = randomHex(8, _rnd);
    try {
      final text = await s3GetText(
        s3,
        t,
        '$helperRoot${HelperDirs.req}$id.json',
      );
      if (text == null) return;
      reqPlain = await openHelper(s3.secretKey, HelperKinds.request, text);
      if (reqPlain == null || reqPlain['job_id'] != id) {
        _foreign.add(id); // کلید دیگر یا دستکاری‌شده: دیگر نمی‌خوانیم
        return;
      }
      await _putLease(s3, t, id, token);
      await _sleep(claimSettle + Duration(milliseconds: _rnd.nextInt(400)));
      final back = await s3GetText(
        s3,
        t,
        '$helperRoot${HelperDirs.lease}$id.json',
      );
      final lp = back == null
          ? null
          : await openHelper(s3.secretKey, HelperKinds.lease, back);
      if (lp == null || lp['token'] != token || lp['helper_id'] != helperId) {
        return; // دیگری برداشت
      }
    } finally {
      t.close();
    }
    _active.add(id);
    _notify();
    unawaited(_runClaimed(s3, id, token, reqPlain));
  }

  Future<void> _putLease(
    S3Settings s3,
    S3Transport t,
    String id,
    String token,
  ) async {
    final now = _now();
    await s3PutJson(
      s3,
      t,
      '$helperRoot${HelperDirs.lease}$id.json',
      await sealHelper(
        s3.secretKey,
        HelperKinds.lease,
        now.millisecondsSinceEpoch,
        {
          'v': 1,
          'job_id': id,
          'helper_id': helperId,
          'token': token,
          'until': now.add(leaseFor).millisecondsSinceEpoch,
        },
      ),
    );
  }

  Future<void> _runClaimed(
    S3Settings s3,
    String id,
    String token,
    Map<String, Object?> req,
  ) async {
    final started = _now();
    final kind = '${req['kind']}';
    Timer? renew;
    renew = Timer.periodic(leaseRenewEvery, (_) async {
      final t = transport();
      try {
        await _putLease(s3, t, id, token);
      } on Object {
        // بار بعد
      } finally {
        t.close();
      }
    });
    Map<String, Object?>? result;
    String? error;
    try {
      result = await executor.run(s3, kind, req['params']);
    } on JobRejected catch (e) {
      error = e.code;
    } on S3Failure {
      error = 's3';
    } on Object {
      error = 'failed';
    } finally {
      renew.cancel();
    }
    final finished = _now();
    final t = transport();
    try {
      final resKey = '$helperRoot${HelperDirs.res}$id.json';
      if (await s3GetText(s3, t, resKey) == null) {
        await s3PutJson(
          s3,
          t,
          resKey,
          await sealHelper(
            s3.secretKey,
            HelperKinds.result,
            finished.millisecondsSinceEpoch,
            {
              'v': 1,
              'job_id': id,
              'helper_id': helperId,
              'ok': error == null,
              'result': result,
              'error': error,
              'started_at': started.millisecondsSinceEpoch,
              'finished_at': finished.millisecondsSinceEpoch,
            },
          ),
        );
      }
      if (error == null) {
        done++;
      } else {
        failed++;
      }
    } on Object {
      failed++;
    } finally {
      t.close();
      _active.remove(id);
      recent.insert(
        0,
        HelperJobLog(
          id,
          kind,
          error == null,
          finished,
          finished.difference(started).inMilliseconds,
        ),
      );
      if (recent.length > 20) recent.removeLast();
      _notify();
    }
  }
}

/// حضور همهٔ سرورهای کمکی (تازه‌ترین اول).
Future<List<HelperPresence>> readHelpers(S3Settings s3, S3Transport t) async {
  final (objs, _) = await s3ListObjects(
    s3,
    t,
    '$helperRoot${HelperDirs.helpers}',
    maxPages: 2,
  );
  final out = <HelperPresence>[];
  for (final o in objs) {
    final id = nameOfKey(o.key);
    if (!helperIdRe.hasMatch(id)) continue;
    final text = await s3GetText(s3, t, o.key);
    if (text == null) continue;
    final p = await openHelper(s3.secretKey, HelperKinds.presence, text);
    if (p == null) continue;
    final h = HelperPresence.fromPlain(id, p);
    if (h != null) out.add(h);
  }
  out.sort((a, b) => b.at.compareTo(a.at));
  return out;
}

/// آیا کار به سرور کمکی نیاز دارد؟ null = بله؛ وگرنه دلیلِ انجام روی همین دستگاه
/// (همان `helperNeed` در server/helper-jobs.js).
String? helperNeed(String kind, {required bool helpersOn, required bool busy}) {
  if (!helpersOn) return 'helpers_disabled';
  // دید «از بیرون» فقط از سیستم دیگر به دست می‌آید
  if (kind == 'endpoint.check') return null;
  // همین دستگاه جا دارد ⇒ بدون تأخیر صف
  return busy ? null : 'not_needed';
}

/// فرستادن یک کار: مسیر عادی همین دستگاه است؛ سرور کمکیِ دیگر فقط هنگام نیاز
/// ([helperNeed]: این دستگاه شلوغ است یا کار دید بیرونی می‌خواهد). هرگز متوقف نمی‌شود.
Future<JobOutcome> submitJob({
  required S3Settings s3,
  required S3Transport Function() transport,
  required JobExecutor executor,
  required String kind,
  Map<String, Object?> params = const {},
  String? selfHelperId,
  String from = 'owner-panel',
  DateTime Function()? now,
  Sleeper? sleep,
  Duration pollEvery = const Duration(seconds: 2),
  Random? random,
  bool helpersOn = true,
  bool Function()? busy,
  bool Function(String helperId)? helperAllowed,
}) async {
  final clock = now ?? DateTime.now;
  final wait = sleep ?? _realSleep;
  final p = validJobParams(kind, params);
  Future<JobOutcome> local(String why) async {
    try {
      return JobOutcome(
        ok: true,
        by: 'local',
        why: why,
        result: await executor.run(s3, kind, p),
      );
    } on JobRejected catch (e) {
      return JobOutcome(ok: false, by: 'local', why: why, error: e.code);
    }
  }

  final skip = helperNeed(
    kind,
    helpersOn: helpersOn,
    busy: busy?.call() ?? false,
  );
  if (skip != null) return local(skip);

  final t = transport();
  try {
    List<HelperPresence> online;
    try {
      final at = clock();
      online = (await readHelpers(s3, t))
          .where(
            (h) =>
                h.onlineAt(at) &&
                h.kinds.contains(kind) &&
                h.helperId != selfHelperId &&
                (helperAllowed?.call(h.helperId) ?? true),
          )
          .toList();
    } on S3Failure {
      return await local('bucket_unreachable');
    }
    if (online.isEmpty) return await local('no_helper');

    final t0 = clock();
    final id = newJobId(t0, random);
    final reqKey = '$helperRoot${HelperDirs.req}$id.json';
    final leaseKey = '$helperRoot${HelperDirs.lease}$id.json';
    final resKey = '$helperRoot${HelperDirs.res}$id.json';
    Future<void> cleanup() async {
      for (final k in [reqKey, leaseKey, resKey]) {
        try {
          await s3Delete(s3, t, k);
        } on Object {
          // gc
        }
      }
    }

    try {
      await s3PutJson(
        s3,
        t,
        reqKey,
        await sealHelper(
          s3.secretKey,
          HelperKinds.request,
          t0.millisecondsSinceEpoch,
          {
            'v': 1,
            'job_id': id,
            'kind': kind,
            'params': p,
            'from': from,
            'created_at': t0.millisecondsSinceEpoch,
            'deadline_at': t0.add(jobDeadline).millisecondsSinceEpoch,
          },
        ),
      );
    } on S3Failure {
      return await local('bucket_unreachable');
    }
    String? claimedBy;
    for (;;) {
      await wait(pollEvery);
      final at = clock();
      Map<String, Object?>? res;
      try {
        final text = await s3GetText(s3, t, resKey);
        if (text != null) {
          res = await openHelper(s3.secretKey, HelperKinds.result, text);
        }
      } on S3Failure {
        // موقتی
      }
      if (res != null && res['job_id'] == id) {
        await cleanup();
        final by = '${res['helper_id']}';
        if (res['ok'] == true) {
          final r = res['result'];
          return JobOutcome(
            ok: true,
            by: by,
            result: r is Map ? r.cast<String, Object?>() : const {},
          );
        }
        final err = '${res['error']}';
        if (err == 'bad_params' || err == 'unknown_kind') {
          return JobOutcome(ok: false, by: by, error: err);
        }
        return await local('helper_failed');
      }
      Map<String, Object?>? lease;
      try {
        final text = await s3GetText(s3, t, leaseKey);
        if (text != null) {
          lease = await openHelper(s3.secretKey, HelperKinds.lease, text);
        }
      } on S3Failure {
        // موقتی
      }
      if (lease != null && lease['job_id'] == id) {
        claimedBy = '${lease['helper_id']}';
        final until = lease['until'];
        if (until is! int || until < at.millisecondsSinceEpoch) {
          await cleanup();
          return await local('lease_expired');
        }
      } else if (claimedBy == null && at.difference(t0) >= claimWait) {
        await cleanup();
        return await local('not_claimed');
      } else if (claimedBy != null) {
        await cleanup();
        return await local('lease_lost');
      }
      if (at.difference(t0) >= jobDeadline) {
        await cleanup();
        return await local('deadline');
      }
    }
  } finally {
    t.close();
  }
}
