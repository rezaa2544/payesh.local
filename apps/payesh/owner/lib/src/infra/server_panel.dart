// ردیف ۱۶۴ — «تعریف سرور» (زیرساخت، ستون چپ).
//
// یک دیتابیس برای کل سامانه؛ دادهٔ هر مدرسه در بخش جدای خودش. برنامه‌های کاربران کلید دیتابیس
// ندارند (امنیت همهٔ مدارس)، پس از راه یک «سرور با نشانی عمومی» به آن می‌رسند:
//   ۱) سرور مرکزی که مالک اینجا تعریف می‌کند (https، مثلاً سرور ابری با دامنه) — اولویت اول؛
//   ۲) تا وقتی تعریف نشده: سرور پایش روی رایانهٔ مدرسه خودش نشانی عمومی می‌گیرد — مطابق «حالت
//      اتصال» ستون راست (ردیف ۱۶۵: تونل رایگان Cloudflare بدون حساب، یا Tailscale Funnel) — و
//      همان اعلام می‌شود (server/tunnel.js).
// هر دو در فهرست «فقط نشانی» دیتابیس اعلام می‌شوند و برنامه‌ها خودکار پیدایشان می‌کنند.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../local/central_server.dart';
import '../local/cloud_control.dart';
import '../local/local_platform.dart';
import '../local/s3_client.dart';
import '../local/settings_page.dart';
import 'infra_policy.dart';

class ServerDefinitionPanel extends StatefulWidget {
  const ServerDefinitionPanel({
    super.key,
    required this.secure,
    required this.transportFactory,
    this.policy,
    this.openUrl,
    this.now,
    this.check = defaultEndpointCheck,
    this.autoLoad = true,
  });

  final SecureStore secure;
  final S3Transport Function() transportFactory;

  /// سیاست مشترک زیرساخت؛ نشانی سرور مرکزی همان `external` مسیر بار (حالت سوم معماری) است.
  final InfraPolicyStore? policy;
  final Future<void> Function(Uri url)? openUrl;
  final DateTime Function()? now;
  final Future<CheckOutcome> Function(Map<String, Object?> e) check;
  final bool autoLoad;

  @override
  State<ServerDefinitionPanel> createState() => _ServerDefinitionPanelState();
}

class _ServerDefinitionPanelState extends State<ServerDefinitionPanel> {
  late final TextEditingController _url = TextEditingController(
    text: widget.policy?.value.external ?? '',
  );
  String? _message;
  bool _ok = true;
  bool _busy = false;
  Uri? _central;
  List<ListedServer> _servers = const [];
  List<Follower> _followers = const [];
  bool _loaded = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      unawaited(_load());
    } else {
      _loaded = true;
    }
  }

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<S3Settings?> _db() async {
    final s = await S3Settings.load(widget.secure);
    return s == null || s.bucket.isEmpty ? null : s;
  }

  Future<void> _load() async {
    final s = await _db();
    if (s == null) {
      if (mounted) {
        setState(() {
          _loaded = true;
          _loadError = 'اول «تعریف دیتابیس» را کامل و ذخیره کنید.';
        });
      }
      return;
    }
    final t = widget.transportFactory();
    try {
      final list = await readServersList(s, t, now: widget.now);
      final f = await readFollowers(s, t, now: widget.now);
      if (!mounted) return;
      setState(() {
        _central = list.central;
        _servers = list.servers;
        _followers = f;
        _loaded = true;
        _loadError = null;
        if (_url.text.trim().isEmpty && list.central != null) {
          _url.text = list.central.toString();
        }
      });
    } on S3Failure catch (e) {
      if (mounted) {
        setState(() {
          _loaded = true;
          _loadError = 'خواندن از دیتابیس ممکن نشد: ${e.messageFa}';
        });
      }
    } finally {
      t.close();
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

  Future<void> _save({bool clear = false}) async {
    final raw = clear ? '' : _url.text.trim();
    final url = raw.isEmpty ? null : normalizeCentral(raw);
    if (raw.isNotEmpty && url == null) {
      _say(
        'نشانی درست نیست. فقط https://نام‌سرور[:درگاه] بدون مسیر — مثل https://server.example.ir',
        false,
      );
      return;
    }
    final s = await _db();
    if (s == null) {
      _say('اول «تعریف دیتابیس» را کامل و ذخیره کنید.', false);
      return;
    }
    setState(() => _busy = true);
    final t = widget.transportFactory();
    try {
      await widget.policy?.setExternal(url?.toString() ?? '');
      await publishCentral(s, t, url, now: widget.now);
      if (clear) _url.clear();
      _say(
        url == null
            ? 'سرور مرکزی حذف شد. برنامه‌ها از نشانی عمومی سرور پایش مدرسه (تونل) وصل می‌شوند.'
            : 'ذخیره شد و به همهٔ برنامه‌ها اعلام شد؛ از این به بعد همه از هر اینترنتی از راه $url به دیتابیس وصل می‌شوند.',
        true,
      );
    } on S3Failure catch (e) {
      _say('اعلام در دیتابیس ممکن نشد: ${e.messageFa}', false);
    } finally {
      t.close();
      if (mounted) setState(() => _busy = false);
    }
    await _load();
  }

  Future<void> _test() async {
    final url = normalizeCentral(_url.text);
    if (url == null) {
      _say('اول نشانی https سرور را بنویسید.', false);
      return;
    }
    setState(() => _busy = true);
    final r = await widget.check({'url': '$url/healthz'});
    if (mounted) setState(() => _busy = false);
    _say(
      r.ok
          ? 'سرور جواب داد (${faNumber(r.latencyMs ?? 0)} میلی‌ثانیه).'
          : 'سرور جواب نداد (${r.errorCode ?? r.statusCode ?? 'نامعلوم'}).',
      r.ok,
    );
  }

  Widget _reachRow(BuildContext context) {
    final tk = context.tokens;
    final publicServers = _servers
        .where((s) => s.publicUrls.isNotEmpty)
        .toList();
    final String text;
    final Color color;
    if (_central != null) {
      text = 'برنامه‌ها اول از راه سرور مرکزی $_central وصل می‌شوند.';
      color = tk.success;
    } else if (publicServers.isNotEmpty) {
      text =
          'از هر اینترنت در دسترس است: ${publicServers.expand((s) => s.publicUrls).join('، ')}';
      color = tk.success;
    } else if (_servers.isNotEmpty) {
      text =
          'هنوز هیچ نشانی عمومی‌ای نیست؛ فقط در شبکهٔ داخلی همان مدرسه وصل می‌شود. '
          'سرور مرکزی را تعریف کنید یا «حالت اتصال» (ستون راست) را ببینید.';
      color = tk.danger;
    } else {
      text = 'هنوز هیچ سرور پایشی خودش را اعلام نکرده است.';
      color = tk.muted;
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        text,
        key: const Key('server-reach'),
        style: TextStyle(color: color),
      ),
    );
  }

  Widget _followerTile(BuildContext context, Follower f) {
    final tk = context.tokens;
    final link = f.tunnelEnableUrl;
    final String line;
    if (f.publicUrl != null) {
      line = 'نشانی عمومی: ${f.publicUrl}';
    } else if (link != null) {
      line = 'تونل رایگان منتظر تأیید یک‌بارهٔ شما در حساب Tailscale است؛ بعد از تأیید خودکار روشن می‌شود.';
    } else {
      line = 'فقط شبکهٔ داخلی (نشانی عمومی ندارد)';
    }
    return ListTile(
      key: Key('server-follower-${f.id}'),
      contentPadding: EdgeInsets.zero,
      dense: true,
      leading: Icon(
        f.publicUrl != null ? Icons.public : Icons.lan_outlined,
        color: f.publicUrl != null ? tk.success : tk.muted,
      ),
      title: Text(
        'سرور پایش: ${f.host}${f.version == null ? '' : ' · نسخهٔ ${f.version}'}',
      ),
      subtitle: Text(line),
      trailing: link == null || widget.openUrl == null
          ? null
          : FilledButton.tonal(
              key: Key('server-tunnel-approve-${f.id}'),
              onPressed: () => unawaited(widget.openUrl!(Uri.parse(link))),
              child: const Text('تأیید تونل رایگان'),
            ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return SettingsSection(
      key: const Key('server-panel'),
      title: 'تعریف سرور',
      subtitle:
          'همهٔ برنامه‌ها (مدیر، معلم، دانش‌آموز و اولیا) از هر جا و با هر اینترنتی از راه این سرور '
          'به همان یک دیتابیس پایش وصل می‌شوند؛ دادهٔ هر مدرسه در بخش جدای خودش در همین دیتابیس است. '
          'نشانی باید https باشد (مثلاً سرور ابری با دامنه). تا وقتی تعریف نشده، سرور پایش روی رایانهٔ '
          'مدرسه با تونل رایگان نشانی عمومی می‌گیرد. هر دو خودکار به همهٔ برنامه‌ها اعلام می‌شوند.',
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: FieldBox(
            width: kFieldWide,
            child: TextField(
              key: const Key('server-url'),
              controller: _url,
              enabled: !_busy,
              textDirection: TextDirection.ltr,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'نشانی سرور مرکزی',
                hintText: 'https://server.example.ir',
              ),
              onSubmitted: (_) => unawaited(_save()),
            ),
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton(
              key: const Key('server-save'),
              onPressed: _busy ? null : () => unawaited(_save()),
              child: const Text('ذخیره و اعلام به همهٔ برنامه‌ها'),
            ),
            OutlinedButton(
              key: const Key('server-test'),
              onPressed: _busy ? null : () => unawaited(_test()),
              child: const Text('آزمایش اتصال'),
            ),
            if (_central != null)
              TextButton(
                key: const Key('server-clear'),
                onPressed: _busy ? null : () => unawaited(_save(clear: true)),
                child: const Text('حذف سرور مرکزی'),
              ),
            IconButton(
              key: const Key('server-refresh'),
              tooltip: 'تازه کردن',
              onPressed: _busy ? null : () => unawaited(_load()),
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (_message != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              _message!,
              key: const Key('server-msg'),
              style: TextStyle(color: _ok ? tk.success : tk.danger),
            ),
          ),
        if (!_loaded)
          const LinearProgressIndicator()
        else if (_loadError != null)
          Text(
            _loadError!,
            key: const Key('server-load-error'),
            style: TextStyle(color: tk.danger),
          )
        else ...[
          _reachRow(context),
          for (final f in _followers) _followerTile(context, f),
        ],
      ],
    );
  }
}
