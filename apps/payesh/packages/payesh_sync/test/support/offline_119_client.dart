// Row 119 — a separate "app" process for the restart scenario: opens the durable outbox file,
// queues [n] ops (idempotent on k), prints READY and starts sending through the Gateway URL.
// The test SIGKILLs this process while the request is on the wire, then reopens the same file.
import 'dart:io';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:sqlite3/sqlite3.dart';

Future<void> main(List<String> args) async {
  final file = args[0];
  final url = args[1];
  final token = args[2];
  final n = int.parse(args[3]);
  final base = int.parse(args[4]);
  final ob = SqliteOutbox(
    sqlite3.open(file),
    config: const OutboxConfig(leaseMs: 1500, jitter: 0),
  );
  for (var i = 0; i < n; i++) {
    ob.enqueue({
      'k': 'o119-restart-${base + i}',
      'collection': 'announcements',
      'type': 'put',
      'id': base + i,
      'data': {'title': 'restart ${base + i}'},
    });
  }
  stdout.writeln('READY ${ob.stats().pending}');
  await stdout.flush();
  final t = GatewayTransport(
    baseUri: Uri.parse(url),
    token: () => token,
    deviceId: 'dev-1',
    timeout: const Duration(seconds: 60),
  );
  final r = await ob.drain(t.push);
  stdout.writeln(
    'DRAINED applied=${r.applied}',
  ); // not reached when killed mid-send
  t.close();
}
