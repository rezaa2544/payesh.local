import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:payesh_owner/src/local/s3_client.dart';

/// صندوقچهٔ S3 در حافظه که چند «دستگاه» هم‌زمان از آن استفاده می‌کنند:
/// GET/PUT/DELETE شیء و ListObjectsV2 (prefix، max-keys، continuation-token، LastModified).
final class FakeBucket {
  FakeBucket(this.now, {this.bucket = 'payesh-madrese'});
  final DateTime Function() now;
  final String bucket;
  final objects = <String, Uint8List>{};
  final modified = <String, DateTime>{};
  final log = <String>[];
  int lists = 0;
  bool down = false;

  void putText(String key, String text, {DateTime? at}) {
    objects[key] = Uint8List.fromList(utf8.encode(text));
    modified[key] = at ?? now();
  }

  String? text(String key) {
    final b = objects[key];
    return b == null ? null : utf8.decode(b);
  }

  Iterable<String> keysUnder(String prefix) =>
      objects.keys.where((k) => k.startsWith(prefix));

  S3Transport transport() => _FakeBucketTransport(this);
}

final class _FakeBucketTransport implements S3Transport {
  _FakeBucketTransport(this.b);
  final FakeBucket b;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    if (b.down) {
      return const S3Response(503, '<Error><Code>SlowDown</Code></Error>');
    }
    final segs = url.pathSegments;
    if (segs.isEmpty || segs.first != b.bucket) {
      return const S3Response(404, '<Error><Code>NoSuchBucket</Code></Error>');
    }
    final key = segs.skip(1).join('/');
    b.log.add('$method /$key${url.hasQuery ? '?${url.query}' : ''}');
    if (method == 'GET' &&
        key.isEmpty &&
        url.queryParameters['list-type'] == '2') {
      b.lists++;
      final prefix = url.queryParameters['prefix'] ?? '';
      final max = int.parse(url.queryParameters['max-keys'] ?? '1000');
      final after = url.queryParameters['continuation-token'];
      final all = b.objects.keys.where((k) => k.startsWith(prefix)).toList()
        ..sort();
      final start = after == null
          ? 0
          : all.indexWhere((k) => k.compareTo(after) > 0);
      final page = start < 0 ? <String>[] : all.skip(start).take(max).toList();
      final truncated = start >= 0 && start + page.length < all.length;
      final x = StringBuffer('<ListBucketResult>');
      for (final k in page) {
        x.write(
          '<Contents><Key>${k.replaceAll('&', '&amp;')}</Key>'
          '<LastModified>${b.modified[k]!.toUtc().toIso8601String()}</LastModified>'
          '<Size>${b.objects[k]!.length}</Size>'
          '<ETag>&quot;${md5.convert(b.objects[k]!)}&quot;</ETag></Contents>',
        );
      }
      x.write('<IsTruncated>$truncated</IsTruncated>');
      if (truncated) {
        x.write('<NextContinuationToken>${page.last}</NextContinuationToken>');
      }
      x.write('</ListBucketResult>');
      return S3Response(200, x.toString());
    }
    switch (method) {
      case 'GET':
        final o = b.objects[key];
        if (o == null) {
          return const S3Response(404, '<Error><Code>NoSuchKey</Code></Error>');
        }
        return S3Response(
          200,
          utf8.decode(o, allowMalformed: true),
          rawBytes: o,
        );
      case 'PUT':
        b.objects[key] = Uint8List.fromList(body ?? const []);
        b.modified[key] = b.now();
        return const S3Response(200, '');
      case 'DELETE':
        b.objects.remove(key);
        b.modified.remove(key);
        return const S3Response(204, '');
    }
    return const S3Response(400, '<Error><Code>Bad</Code></Error>');
  }

  @override
  void close() {}
}
