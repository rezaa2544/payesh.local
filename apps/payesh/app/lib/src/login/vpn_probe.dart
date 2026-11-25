import 'package:payesh_core/io.dart';

/// Row 186 — is a VPN up on this device? Android gives every VPN (VpnService) its own
/// interface — `tun0` (Lantern, v2rayNG, OpenVPN, Psiphon…), `ppp0` (L2TP/PPTP) or `wg0`
/// (WireGuard kernel mode) — next to `wlan0`/`rmnet*`. Nothing is sent; only the interface names
/// are read. `clat*` (464XLAT on IPv6-only mobile networks) is not a VPN.
Future<bool> vpnInterfaceUp() async {
  try {
    final list = await NetworkInterface.list(
      includeLoopback: false,
      type: InternetAddressType.any,
    );
    return list.any((i) => looksLikeVpnInterface(i.name));
  } on Object {
    return false;
  }
}

/// Whether an interface name is a VPN's (see [vpnInterfaceUp]).
bool looksLikeVpnInterface(String name) =>
    RegExp(r'^(tun|tap|ppp|wg|ipsec)\d*$').hasMatch(name.toLowerCase());
