// Shared outbox vectors (docs/cloud/contracts/conformance/outbox-v1.json) on the Dart outbox.
// The same file runs against client/outbox-web.js in tests/conformance-outbox-71.js.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

const vectorsPath =
    '../../../../docs/cloud/contracts/conformance/outbox-v1.json';

Map<String, Object?> pick(Map<String, Object?> o, Iterable<String> keys) => {
  for (final k in keys) k: o[k],
};

Map<String, Object?> opJson(OutboxOp o) => {
  'k': o.k,
  'state': o.state.name,
  'attempts': o.attempts,
  'next_at': o.nextAt,
  'last_error': o.lastError,
  'lease_until': o.leaseUntil,
};

void main() {
  final doc =
      jsonDecode(File(vectorsPath).readAsStringSync()) as Map<String, Object?>;
  final cases = (doc['cases']! as List<Object?>).cast<Map<String, Object?>>();

  test('vector file identity', () {
    expect(doc['id'], 'outbox-v1');
    expect(cases, isNotEmpty);
  });

  for (final c in cases) {
    test(c['name'], () async {
      final ob = SqliteOutbox.inMemory(
        config: OutboxConfig.fromJson(
          (c['config']! as Map).cast<String, Object?>(),
        ),
      );
      addTearDown(ob.database.close);
      final steps = (c['steps']! as List<Object?>).cast<Map<String, Object?>>();
      for (var i = 0; i < steps.length; i++) {
        final s = steps[i];
        final at = 'step $i ${s['op']}';
        final expected = (s['expect'] as Map?)?.cast<String, Object?>();
        switch (s['op']) {
          case 'enqueue':
            final r = ob.enqueue((s['input']! as Map).cast<String, Object?>());
            final got = {
              'ok': r.ok,
              'duplicate': r.duplicate,
              'error': r.error?.wire,
            };
            expect(pick(got, expected!.keys), expected, reason: at);
          case 'list':
            expect(
              ob.list().map((o) => o.k).toList(),
              s['expect_keys'],
              reason: at,
            );
          case 'claim':
            final got = ob.claim(
              (s['limit']! as num).toInt(),
              (s['now']! as num).toInt(),
            );
            expect(got.map((o) => o.k).toList(), s['expect_keys'], reason: at);
          case 'fail':
            final r = ob.fail(
              s['k']! as String,
              error: s['error'] as String?,
              now: (s['now']! as num).toInt(),
            );
            final got = {
              'ok': r.ok,
              'state': r.state?.name,
              'attempts': r.attempts,
              'next_at': r.nextAt,
            };
            expect(pick(got, expected!.keys), expected, reason: at);
          case 'ack':
            ob.ack(s['k']! as String);
          case 'retry':
            ob.retry(s['k']! as String);
          case 'recover':
            expect(
              {'recovered': ob.recover((s['now']! as num).toInt())},
              expected,
              reason: at,
            );
          case 'stats':
            final st = ob.stats();
            final got = {
              'total': st.total,
              'pending': st.pending,
              'inflight': st.inflight,
              'blocked': st.blocked,
              'active': st.active,
              'full': st.full,
            };
            expect(pick(got, expected!.keys), expected, reason: at);
          case 'get':
            final o = ob.get(s['k']! as String);
            expect(o, isNotNull, reason: at);
            expect(pick(opJson(o!), expected!.keys), expected, reason: at);
          case 'drain':
            final script = [
              ...(s['script']! as List<Object?>).cast<Map<String, Object?>>(),
            ];
            final sent = <List<Object?>>[];
            final res = await ob.drain((wire) async {
              sent.add(wire.map((w) => w['uid']).toList());
              final ans = script.isEmpty
                  ? const <String, Object?>{}
                  : script.removeAt(0);
              if (ans['throw'] != null) throw Exception(ans['throw']);
              List<Map<String, Object?>> m(String k) => [
                for (final u in (ans[k] as List<Object?>? ?? const []))
                  {'uid': u},
              ];
              return PushVerdicts.fromJson({
                'applied': m('applied'),
                'rejected': m('rejected'),
                'conflicts': m('conflicts'),
              });
            }, now: (s['now']! as num).toInt());
            final got = {
              'batches': res.batches,
              'claimed': res.claimed,
              'applied': res.applied,
              'rejected': res.rejected,
              'conflicts': res.conflicts,
              'failed': res.failed,
              'stopped': res.stopped,
            };
            expect(pick(got, expected!.keys), expected, reason: at);
            if (s['expect_sent'] != null) {
              expect(sent, s['expect_sent'], reason: '$at sent');
            }
          case 'wire':
            expect(ob.get(s['k']! as String)!.toWire(), expected, reason: at);
          default:
            fail('unknown op ${s['op']}');
        }
      }
    });
  }
}
