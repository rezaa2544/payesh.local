import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Always-visible sync state (row 74 AC, offline-first). Text + icon + tone — colour is never the
/// only signal. Tapping asks for a new attempt.
class SyncBadge extends StatelessWidget {
  const SyncBadge({super.key, required this.status, this.onRetry});

  final ValueListenable<SyncStatus> status;
  final VoidCallback? onRetry;

  static (PayeshTone, IconData) look(SyncPhase p) => switch (p) {
    SyncPhase.idle => (PayeshTone.success, Icons.cloud_done_outlined),
    SyncPhase.syncing => (PayeshTone.info, Icons.sync),
    SyncPhase.queued => (PayeshTone.info, Icons.cloud_upload_outlined),
    SyncPhase.offline => (PayeshTone.warning, Icons.cloud_off_outlined),
    SyncPhase.attention => (PayeshTone.danger, Icons.error_outline),
  };

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SyncStatus>(
      valueListenable: status,
      builder: (context, s, _) {
        final (tone, icon) = look(s.phase);
        final err = s.lastError;
        return Tooltip(
          message: err ?? s.labelFa,
          child: InkWell(
            key: const Key('sync-badge'),
            borderRadius: BorderRadius.circular(999),
            onTap: onRetry,
            child: Semantics(
              button: onRetry != null,
              label: 'وضعیت همگام‌سازی: ${s.labelFa}',
              excludeSemantics: true,
              child: StatusBadge(
                s.labelFa,
                key: Key('sync-${s.phase.name}'),
                tone: tone,
                icon: icon,
              ),
            ),
          ),
        );
      },
    );
  }
}
