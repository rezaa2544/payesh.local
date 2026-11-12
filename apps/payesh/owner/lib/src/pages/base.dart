import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';

import '../widgets.dart';

/// Shared load / mutate cycle of every page (the web `LOADERS` + `afterMutation`).
abstract class OwnerPageState<T extends StatefulWidget> extends State<T> {
  bool loading = true;
  bool _started = false;

  OwnerScope get scope => OwnerScope.of(context);
  OwnerApi get api => scope.api;
  OwnerCaps get caps => scope.caps;

  /// Fetch everything the page shows (results kept in fields).
  Future<void> load();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      reload();
    }
  }

  Future<void> reload() async {
    if (mounted) setState(() => loading = true);
    await load();
    if (mounted) setState(() => loading = false);
  }

  /// Runs a mutation, shows the server's verdict, then reloads the page.
  Future<ApiResult> mutate(Future<ApiResult> call, String okText) async {
    final r = await call;
    if (!mounted) return r;
    scope.flash(r.ok, r.ok ? okText : r.message);
    await reload();
    return r;
  }

  /// Standard body for one list result: loading / error / empty / [build].
  Widget listBox(
    ApiResult? r,
    String key, {
    required String loadingText,
    required String emptyText,
    required Widget Function(List<Map<String, Object?>> rows) build,
  }) {
    if (loading || r == null) return StateBox.loading(loadingText);
    if (!r.ok) return StateBox.error(r.message);
    final rows = r.list(key);
    if (rows.isEmpty) return StateBox.empty(emptyText);
    return build(rows);
  }
}
