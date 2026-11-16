// ردیف ۱۶۵ — «حالت اتصال» (زیرساخت، ستون راست، زیر «مدل پردازش»).
//
// مالک خودش انتخاب می‌کند گوشی‌ها و رایانه‌هایی که بیرون از شبکهٔ مدرسه‌اند از چه راهی به همان یک
// دیتابیس برسند. انتخاب در فهرست «فقط نشانی» دیتابیس نوشته می‌شود
// (`payesh/pub/school-servers.json` → `connect:{mode,at}`)؛ هر سرور پایش ظرف یک دقیقه آن را
// می‌خواند و تونل‌ها را مطابقش روشن/خاموش می‌کند (server/tunnel.js). نشانی‌های عمومی که هر
// سرور الان دارد همین‌جا با چراغ وضعیت دیده و آزموده می‌شوند. هیچ کار دستی دیگری لازم نیست:
// برنامه‌ها نشانی‌ها را خودشان از همان فهرست برمی‌دارند.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../local/central_server.dart';
import '../local/local_platform.dart';
import '../local/s3_client.dart';

const Map<String, String> connectModeTitles = {
  'auto': 'خودکار (پیشنهادی)',
  'cloudflare': 'تونل رایگان Cloudflare',
  'tailscale': 'Tailscale Funnel',
  'central': 'فقط سرور مرکزی',
  'lan': 'فقط شبکهٔ داخلی مدرسه',
};

const Map<String, String> connectModeDetails = {
  'auto':
      'سرور مرکزی (اگر تعریف شده) + نشانی عمومی خودکار هر سرور مدرسه: اگر Tailscale آماده بود همان، '
      'وگرنه تونل رایگان Cloudflare. بدون حساب و بدون تأیید.',
  'cloudflare':
      'هر سرور مدرسه یک نشانی https رایگان از Cloudflare می‌گیرد (بدون حساب). نشانی با هر بار روشن '
      'شدن عوض می‌شود ولی برنامه‌ها خودشان پیدایش می‌کنند.',
  'tailscale': 'نشانی ثابت ‎*.ts.net‎ روی همان رایانه؛ یک بار تأیید صاحب حساب Tailscale لازم دارد.',
  'central':
      'هیچ تونلی روی رایانه‌های مدرسه روشن نمی‌شود؛ بیرون از مدرسه فقط از راه سرور مرکزی '
      '(«تعریف سرور»، ستون چپ).',
  'lan': 'هیچ نشانی عمومی اعلام نمی‌شود؛ فقط دستگاه‌هایی که در شبکهٔ همان مدرسه‌اند وصل می‌شوند.',
};

const Map<String, IconData> _modeIcons = {
  'auto': Icons.auto_mode,
  'cloudflare': Icons.cloud_outlined,
  'tailscale': Icons.hub_outlined,
  'central': Icons.dns_outlined,
  'lan': Icons.lan_outlined,
};

const Map<String, String> _kindTitles = {
  'cloudflare': 'Cloudflare',
  'tailscale': 'Tailscale',
  'custom': 'نشانی دستی',
};

class ConnectModesCard extends StatefulWidget {
  const ConnectModesCard({
    super.key,
    required this.secure,
    required this.transportFactory,
    this.now,
    this.check = defaultEndpointCheck,
    this.autoLoad = true,
    this.margin = EdgeInsets.zero,
  });

  final SecureStore secure;
  final S3Transport Function() transportFactory;
  final DateTime Function()? now;
  final Future<CheckOutcome> Function(Map<String, Object?> e) check;
  final bool autoLoad;
  final EdgeInsetsGeometry margin;

  @override
  State<ConnectModesCard> createState() => _ConnectModesCardState();
}

class _ConnectModesCardState extends State<ConnectModesCard> {
  String _mode = 'auto';
  Uri? _central;
  List<ListedServer> _servers = const [];
  final Map<String, CheckOutcome?> _checks = {};
  bool _loaded = false;
  bool _busy = false;
  String? _error;
  String? _message;
  bool _ok = true;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      unawaited(_load());
      // وضعیت نشانی‌ها زنده بماند (نشانی تونل ممکن است عوض شود)
      _timer = Timer.periodic(
        const Duration(minutes: 1),
        (_) => unawaited(_load(quiet: true)),
      );
    } else {
      _loaded = true;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<S3Settings?> _db() async {
    final s = await S3Settings.load(widget.secure);
    return s == null || s.bucket.isEmpty ? null : s;
  }

  Future<void> _load({bool quiet = false}) async {
    final s = await _db();
    if (s == null) {
      if (mounted) {
        setState(() {
          _loaded = true;
          _error = 'اول «تعریف دیتابیس» (ستون چپ) را کامل و ذخیره کنید.';
        });
      }
      return;
    }
    final t = widget.transportFactory();
    try {
      final list = await readServersList(s, t, now: widget.now);
      if (!mounted) return;
      setState(() {
        _mode = list.connectMode;
        _central = list.central;
        _servers = list.servers;
        _loaded = true;
        _error = null;
      });
      await _testAll();
    } on S3Failure catch (e) {
      if (mounted && !quiet) {
        setState(() {
          _loaded = true;
          _error = 'خواندن از دیتابیس ممکن نشد: ${e.messageFa}';
        });
      }
    } finally {
      t.close();
    }
  }

  Future<void> _testAll() async {
    final urls = {
      if (_central != null) _central.toString(),
      for (final s in _servers) ...s.publicUrls,
    };
    await Future.wait([
      for (final u in urls)
        widget.check({'url': '$u/healthz'}).then((r) {
          if (mounted) setState(() => _checks[u] = r);
        }),
    ]);
  }

  Future<void> _setMode(String m) async {
    if (m == _mode || _busy) return;
    final s = await _db();
    if (s == null) {
      _say('اول «تعریف دیتابیس» (ستون چپ) را کامل و ذخیره کنید.', false);
      return;
    }
    final before = _mode;
    setState(() {
      _busy = true;
      _mode = m;
    });
    final t = widget.transportFactory();
    try {
      await publishConnectMode(s, t, m, now: widget.now);
      _say(
        'ذخیره شد: «${connectModeTitles[m]}». سرورهای پایش ظرف یک دقیقه اعمال می‌کنند و '
        'برنامه‌ها نشانی تازه را خودشان برمی‌دارند.',
        true,
      );
    } on S3Failure catch (e) {
      if (mounted) setState(() => _mode = before);
      _say('ثبت در دیتابیس ممکن نشد: ${e.messageFa}', false);
    } finally {
      t.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  void _say(String m, bool ok) {
    if (mounted) {
      setState(() {
        _message = m;
        _ok = ok;
      });
    }
  }

  Widget _modeTile(BuildContext context, String m) {
    final tk = context.tokens;
    final sel = _mode == m;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: sel ? tk.soft : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(tk.cardRadius - 6),
          side: BorderSide(color: sel ? tk.primary : tk.line),
        ),
        child: InkWell(
          key: Key('connect-mode-$m'),
          borderRadius: BorderRadius.circular(tk.cardRadius - 6),
          onTap: _busy || sel || _error != null
              ? null
              : () => unawaited(_setMode(m)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  sel ? Icons.radio_button_checked : Icons.radio_button_off,
                  color: sel ? tk.primary : tk.muted,
                  size: 20,
                ),
                const SizedBox(width: 10),
                Icon(_modeIcons[m], size: 20, color: sel ? tk.primary : tk.ink),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        connectModeTitles[m]!,
                        style: TextStyle(
                          fontWeight: sel ? FontWeight.w700 : FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        connectModeDetails[m]!,
                        style: TextStyle(color: tk.muted, fontSize: 12.5),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _urlRow(BuildContext context, String url, String label) {
    final tk = context.tokens;
    final r = _checks[url];
    final tone = r == null
        ? PayeshTone.neutral
        : r.ok
        ? PayeshTone.success
        : PayeshTone.danger;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          StatusBadge(
            r == null
                ? 'در حال آزمایش'
                : r.ok
                ? 'در دسترس · ${faNumber(r.latencyMs ?? 0)} م‌ث'
                : 'جواب نداد',
            key: Key('connect-url-state-$url'),
            tone: tone,
            icon: r == null
                ? Icons.more_horiz
                : r.ok
                ? Icons.check_circle_outline
                : Icons.error_outline,
          ),
          const SizedBox(width: 8),
          Text(label, style: TextStyle(color: tk.muted)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              url,
              key: Key('connect-url-$url'),
              textDirection: TextDirection.ltr,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.left,
            ),
          ),
        ],
      ),
    );
  }

  Widget _status(BuildContext context) {
    final tk = context.tokens;
    final publicServers = _servers.where((s) => s.publicUrls.isNotEmpty);
    final reachable = _checks.values.any((c) => c?.ok ?? false);
    final String head;
    final Color color;
    if (_mode == 'lan') {
      head = 'فقط شبکهٔ داخلی؛ بیرون از مدرسه وصل نمی‌شود (انتخاب شما).';
      color = tk.muted;
    } else if (reachable) {
      head = 'از هر اینترنتی وصل می‌شود.';
      color = tk.success;
    } else if (_central == null && publicServers.isEmpty) {
      head = _servers.isEmpty ? 'هنوز هیچ سرور پایشی خودش را اعلام نکرده است.' : 'هنوز نشانی عمومی‌ای اعلام نشده؛ سرورها ظرف چند دقیقه پس از اعمال حالت، نشانی می‌گیرند.';
      color = tk.warning;
    } else {
      head = 'در حال آزمایش نشانی‌ها…';
      color = tk.muted;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          head,
          key: const Key('connect-status'),
          style: TextStyle(color: color, fontWeight: FontWeight.w600),
        ),
        if (_central != null)
          _urlRow(context, _central.toString(), 'سرور مرکزی'),
        for (final s in _servers)
          for (final u in s.publicUrls)
            _urlRow(
              context,
              u,
              '${_kindTitles[publicUrlKind(u)]}'
              '${s.school == null ? '' : ' · ${s.school}'}',
            ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return Card(
      key: const Key('connect-card'),
      margin: widget.margin,
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(Icons.public, color: tk.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'حالت اتصال',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  key: const Key('connect-refresh'),
                  tooltip: 'تازه کردن و آزمایش دوباره',
                  onPressed: _busy ? null : () => unawaited(_load()),
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            Text(
              'کاربران بیرون از شبکهٔ مدرسه (گوشی با اینترنت همراه، خانه، …) از چه راهی به همان یک '
              'دیتابیس برسند. انتخاب شما خودکار به همهٔ سرورها و برنامه‌ها اعلام می‌شود.',
              style: TextStyle(color: tk.muted),
            ),
            const SizedBox(height: 12),
            if (!_loaded)
              const LinearProgressIndicator()
            else ...[
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    _error!,
                    key: const Key('connect-error'),
                    style: TextStyle(color: tk.danger),
                  ),
                ),
              for (final m in connectModes) _modeTile(context, m),
              if (_busy) const LinearProgressIndicator(),
              if (_message != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4, bottom: 8),
                  child: Text(
                    _message!,
                    key: const Key('connect-msg'),
                    style: TextStyle(color: _ok ? tk.success : tk.danger),
                  ),
                ),
              if (_error == null) ...[
                const Divider(height: 24),
                _status(context),
              ],
            ],
          ],
        ),
      ),
    );
  }
}
