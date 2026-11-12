import 'package:payesh_sync/payesh_sync.dart';

/// Gateway transport is the default (row 74): the pinned Gateway (`PAYESH_GATEWAY_URL` +
/// `PAYESH_GATEWAY_PINS`, row 75) is also the Directory and the single-cell fallback; an
/// optional `PAYESH_DIRECTORY_URL` points at a separate Directory. Without a valid Gateway
/// config the login answers "not configured" instead of guessing an address.
/// The build's Gateway config, or null when missing/invalid (never a guessed address).
GatewayConfig? gatewayConfigFromEnvironment({
  String url = const String.fromEnvironment('PAYESH_GATEWAY_URL'),
  String pins = const String.fromEnvironment('PAYESH_GATEWAY_PINS'),
}) {
  try {
    return GatewayConfig.fromEnvironment(url: url, pins: pins);
  } on PinConfigException {
    return null;
  } on FormatException {
    return null;
  }
}

SchoolAccessApi schoolAccessFromEnvironment({
  String url = const String.fromEnvironment('PAYESH_GATEWAY_URL'),
  String pins = const String.fromEnvironment('PAYESH_GATEWAY_PINS'),
  String directory = const String.fromEnvironment('PAYESH_DIRECTORY_URL'),
}) {
  final GatewayConfig? gw;
  try {
    gw = GatewayConfig.fromEnvironment(url: url, pins: pins);
  } on PinConfigException {
    return const UnconfiguredSchoolAccess();
  } on FormatException {
    return const UnconfiguredSchoolAccess();
  }
  if (gw == null) return const UnconfiguredSchoolAccess();
  final dir = Uri.tryParse(directory);
  return SchoolAccessClient(
    directory: directory.isEmpty || dir == null || dir.scheme != 'https'
        ? gw.baseUri
        : dir,
    fallbackCell: gw.baseUri,
    client: createPinnedHttpClient(gw),
  );
}
