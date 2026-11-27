import 'dart:async';
import 'dart:convert';

import 'package:payesh_core/io.dart';

import 'lan_access.dart';
import 'le_trust.dart';

/// Row 163 — where the school server is, with NOTHING typed on the login screen.
///
/// The app never holds a key of the database (D‑23): every read and write goes through the
/// school server, which itself follows the owner's database (server/cloud-control.js). The only
/// thing the app has to learn is the server's address, and it no longer asks the user for it.
/// Each school server keeps a tiny, address-only list in that same database
/// (`<prefix>pub/school-servers.json`, written with `x-amz-acl: public-read` by
/// server/discovery.js): school name, private LAN addresses, an optional https public address.
/// No key, no user, no data — everything else in the database stays private (403).
///
/// The URL of that list is metadata, not a secret (D‑23 allows endpoint/bucket/prefix in the
/// client); a build can point elsewhere with `--dart-define=PAYESH_SERVERS_URL=…`.
abstract interface class SchoolDirectoryApi {
  /// Addresses to try, best first (LAN of the freshest server first, then its public address).
  Future<List<Uri>> candidates();

  /// Row 165 — every address of ONE server (its `instance`, e.g. from the saved `lan-<instance>`
  /// school code): LAN first, then its public addresses (Cloudflare / Tailscale / custom). A
  /// signed-in phone that left the school network re-finds the SAME server with this (its device
  /// token only works there). Empty when the list does not name that server.
  Future<List<Uri>> addressesOf(String instance);
}

/// One server row of the list.
final class SchoolServerEntry {
  const SchoolServerEntry({
    required this.instance,
    required this.lan,
    required this.at,
    this.school,
    this.publicUrl,
    this.publicUrls = const [],
  });
  final String instance;
  final String? school;
  final List<Uri> lan;
  final Uri? publicUrl;

  /// Row 165 — all public addresses of this server, best first (`public_urls`; [publicUrl] is the
  /// first). Https only, no path.
  final List<Uri> publicUrls;
  final DateTime at;

  /// Parses one row; null when it is not usable (no instance, no time, no address).
  static SchoolServerEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['instance'];
    final at = DateTime.tryParse('${raw['at'] ?? ''}');
    if (id is! String || id.isEmpty || at == null) return null;
    final lan = <Uri>[
      for (final u in (raw['lan'] is List ? raw['lan'] as List : const []))
        if (u is String) ?LanServerRules.parse(u),
    ];
    Uri? https(Object? p) {
      if (p is! String) return null;
      final u = Uri.tryParse(p);
      if (u == null ||
          u.scheme != 'https' ||
          u.host.isEmpty ||
          u.userInfo.isNotEmpty) {
        return null;
      }
      return Uri(scheme: 'https', host: u.host.toLowerCase(), port: u.port);
    }

    final pubs = <Uri>[];
    for (final p in [
      ...(raw['public_urls'] is List ? raw['public_urls'] as List : const []),
      raw['public_url'],
    ]) {
      final u = https(p);
      if (u != null && !pubs.contains(u) && pubs.length < 4) pubs.add(u);
    }
    final pub = pubs.isEmpty ? null : pubs.first;
    if (lan.isEmpty && pub == null) return null;
    final s = raw['school'];
    return SchoolServerEntry(
      instance: id,
      school: s is String && s.isNotEmpty ? s : null,
      lan: lan,
      publicUrl: pub,
      publicUrls: pubs,
      at: at,
    );
  }
}

/// Reads the address-only list with one plain GET (no signature, no key).
final class SchoolDirectoryClient implements SchoolDirectoryApi {
  SchoolDirectoryClient({
    Uri? url,
    Uri? domain,
    bool useDomain = true,
    Uri? mirror,
    Uri? central,
    HttpClient? client,
    this.timeout = const Duration(seconds: 10),
    this.maxAge = const Duration(days: 10),
    DateTime Function()? now,
  }) : url = url ?? defaultUrl,
       domainUrl = useDomain ? (domain ?? defaultDomainUrl) : null,
       // row 171: the GitHub copy and the project's central server ride along with the domain
       mirrorUrl = useDomain ? (mirror ?? defaultMirrorUrl) : mirror,
       fallbackCentral = useDomain ? (central ?? defaultCentral) : central,
       _client = client ?? trustedHttpClient(),
       _now = now ?? DateTime.now;

  /// Row 170 — the same list through the project domain, read FIRST: when the database moves,
  /// only the domain (ArvanCloud) is pointed at the new place and every installed app follows.
  static final Uri defaultDomainUrl = Uri.parse(
    'https://payeshschool.ir/payesh/pub/school-servers.json',
  );

  /// The domain copy of the list (null = not used).
  final Uri? domainUrl;

  /// Row 171 — a copy of the list OUTSIDE Iran's networks (the public repository, refreshed by
  /// .github/workflows/directory-mirror.yml from the central server). Read when neither the
  /// domain nor the database copy answers — e.g. a phone abroad, where the database is not
  /// reachable and the domain is not set up yet.
  static final Uri defaultMirrorUrl = Uri.parse(
    'https://raw.githubusercontent.com/rezaa2544/payesh.local/directory/school-servers.json',
  );

  /// Null = no mirror.
  final Uri? mirrorUrl;

  /// Row 171 — the project's always-on central server (deploy/serv00): one address, on the
  /// project domain, reachable from any network; it hosts schools and answers which server hosts
  /// the others. Tried when the list names no central server of its own.
  static final Uri defaultCentral = Uri.parse('https://app.payeshschool.ir');

  /// Null = no built-in central server.
  final Uri? fallbackCentral;

  /// The list in the owner's database. Set by the release build
  /// (`--dart-define=PAYESH_SERVERS_URL=…`, .github/workflows/native-client.yml): the client code
  /// itself names no storage host (D‑36 guard, test/data_path_test.dart). Null when the build
  /// has none — then only the remembered server and this computer are tried.
  static Uri? get defaultUrl {
    const raw = String.fromEnvironment('PAYESH_SERVERS_URL');
    final u = Uri.tryParse(raw);
    return raw.isEmpty || u == null || u.scheme != 'https' ? null : u;
  }

  /// Null when this build names no list (see [defaultUrl]).
  final Uri? url;
  final Duration timeout;

  /// Rows not refreshed for this long are skipped (that server is gone).
  final Duration maxAge;
  final HttpClient _client;
  final DateTime Function() _now;

  /// Row 164 — the central server the owner defined in the owner panel (Infrastructure → Server),
  /// read from the list's top-level `central` by the last [entries] call. Https only, no path.
  Uri? get central => _central;
  Uri? _central;

  /// Parses the list's `central` object (`{url, at}`); null when absent or not plain https.
  static Uri? centralOf(Object? raw) {
    if (raw is! Map || raw['url'] is! String) return null;
    final u = Uri.tryParse(raw['url'] as String);
    if (u == null ||
        u.scheme != 'https' ||
        u.host.isEmpty ||
        u.userInfo.isNotEmpty) {
      return null;
    }
    return Uri(scheme: 'https', host: u.host.toLowerCase(), port: u.port);
  }

  /// The usable rows, freshest first.
  Future<List<SchoolServerEntry>> entries() async {
    _central = null;
    // row 170: the domain first, then the address baked into the build; row 171: then the copy
    // outside Iran (GitHub)
    // Row 199: a source whose list is valid but has no usable row (the domain's placeholder
    // `servers: []`, or only stale rows) no longer hides the next source — the first non-empty
    // list wins; an empty one is the answer only when every source is empty.
    List<SchoolServerEntry>? empty;
    Uri? emptyCentral;
    for (final u in [?domainUrl, ?url, ?mirrorUrl]) {
      try {
        final r = await _read(u);
        if (r == null) continue;
        if (r.isNotEmpty) return r;
        if (empty == null) {
          empty = r;
          emptyCentral = _central;
        }
      } on Object {
        // not reachable: the next source
      }
    }
    _central = emptyCentral;
    return empty ?? const [];
  }

  /// One source; null = no valid list there.
  Future<List<SchoolServerEntry>?> _read(Uri u) async {
    final req = await _client.getUrl(u).timeout(timeout);
    req.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    final res = await req.close().timeout(timeout);
    final body = await res.transform(utf8.decoder).join().timeout(timeout);
    if (res.statusCode != 200) return null;
    final Object? j;
    try {
      j = jsonDecode(body);
    } on FormatException {
      return null;
    }
    if (j is! Map || j['kind'] != 'payesh-school-servers') return null;
    _central = centralOf(j['central']);
    final now = _now();
    final out = <SchoolServerEntry>[
      for (final r in (j['servers'] is List ? j['servers'] as List : const []))
        if (SchoolServerEntry.fromJson(r) case final e?)
          if (now.difference(e.at) < maxAge) e,
    ]..sort((a, b) => b.at.compareTo(a.at));
    return out;
  }

  @override
  Future<List<Uri>> candidates() async {
    final list = await entries();
    final out = candidatesOf(list, central: _central ?? fallbackCentral);
    // row 171: the built-in central server is always somewhere in the list (last when the list
    // has its own central): a fresh install with no list at all still has one address to try
    final c = fallbackCentral;
    if (c != null && !out.contains(c)) out.add(c);
    return out;
  }

  /// The owner's central server first (reachable from any internet), then LAN addresses of every
  /// server (fast, inside the school), then the servers' own public addresses.
  static List<Uri> candidatesOf(List<SchoolServerEntry> list, {Uri? central}) {
    final seen = <String>{};
    final out = <Uri>[];
    void add(Uri u) {
      if (seen.add(u.toString())) out.add(u);
    }

    if (central != null) add(central);

    for (final e in list) {
      e.lan.forEach(add);
    }
    for (final e in list) {
      e.publicUrls.forEach(add);
    }
    return out;
  }

  @override
  Future<List<Uri>> addressesOf(String instance) async =>
      addressesIn(await entries(), instance);

  /// LAN then public addresses of the row whose `instance` is [instance].
  static List<Uri> addressesIn(List<SchoolServerEntry> list, String instance) {
    final want = instance.trim().toLowerCase();
    if (want.isEmpty) return const [];
    for (final e in list) {
      if (e.instance.toLowerCase() == want) return [...e.lan, ...e.publicUrls];
    }
    return const [];
  }
}

/// Probes [servers] all at once and returns the first one that answers as a Payesh school server
/// (`/api/health` → `payesh-local`), or null when none does. Order breaks ties only.
Future<LanServerInfo?> firstAnswering(
  LanAccessApi api,
  List<Uri> servers,
) async {
  if (servers.isEmpty) return null;
  final done = Completer<LanServerInfo?>();
  var left = servers.length;
  for (final s in servers) {
    unawaited(
      api
          .probe(s)
          .then<void>(
            (info) {
              if (!done.isCompleted) done.complete(info);
            },
            onError: (Object _) {
              left--;
              if (left == 0 && !done.isCompleted) done.complete(null);
            },
          ),
    );
  }
  return done.future;
}
