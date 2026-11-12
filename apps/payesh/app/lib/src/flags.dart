/// Old vs new client (row 74). The "old client" is the existing web client (PWA in the browser);
/// the native app never embeds it (no WebView — native gate, row 63). Pages move to native in
/// waves; a wave is shown natively only when the build enables it AND the user has not chosen
/// the old client on this device.
library;

/// Which client a school/device uses.
enum ClientChoice { legacy, native }

/// Migration waves in their fixed order (row 74).
enum NativeWave { login, attendance, grades, notices, parents }

final class ClientFlags {
  const ClientFlags({
    required this.client,
    required this.waves,
    this.webUrl = '',
  });

  /// Parses build-time values. Fail-safe: an unknown client value means the OLD client, unknown
  /// wave names are ignored, and a wave is only on when every earlier wave is on (waves after
  /// login need the native login).
  factory ClientFlags.parse({
    String client = 'native',
    String waves = 'login,attendance,grades,notices',
    String webUrl = '',
  }) {
    final c = switch (client.trim().toLowerCase()) {
      'native' => ClientChoice.native,
      _ => ClientChoice.legacy,
    };
    final named = waves
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .where((w) => w.isNotEmpty)
        .toSet();
    final on = <NativeWave>{};
    for (final w in NativeWave.values) {
      if (!named.contains(w.name)) break;
      on.add(w);
    }
    return ClientFlags(client: c, waves: on, webUrl: webUrl.trim());
  }

  /// `--dart-define=PAYESH_CLIENT=native|legacy`, `--dart-define=PAYESH_NATIVE_WAVES=login,…`,
  /// `--dart-define=PAYESH_WEB_URL=https://…` (address of the old web client).
  factory ClientFlags.fromEnvironment() => ClientFlags.parse(
    client: const String.fromEnvironment(
      'PAYESH_CLIENT',
      defaultValue: 'native',
    ),
    waves: const String.fromEnvironment(
      'PAYESH_NATIVE_WAVES',
      defaultValue: 'login,attendance,grades,notices',
    ),
    webUrl: const String.fromEnvironment('PAYESH_WEB_URL'),
  );

  final ClientChoice client;
  final Set<NativeWave> waves;
  final String webUrl;

  /// The build ships this wave natively (independent of the user's choice).
  bool ships(NativeWave w) => waves.contains(w);

  /// This wave is shown natively right now.
  bool uses(NativeWave w) => client == ClientChoice.native && ships(w);

  /// Applies the choice stored on the device. Switching to the old client is always allowed;
  /// switching to native only when the build ships the login wave (never an unreleased wave).
  ClientFlags withChoice(String? stored) {
    final c = switch (stored) {
      'legacy' => ClientChoice.legacy,
      'native' when ships(NativeWave.login) => ClientChoice.native,
      _ => client,
    };
    return ClientFlags(client: c, waves: waves, webUrl: webUrl);
  }
}
