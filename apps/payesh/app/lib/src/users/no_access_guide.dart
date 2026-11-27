// Row 197 (Q06 / F41) — «دسترسی ندارید»: what a staff member sees when the manager chose
// «هیچ» for them. Before this the person only saw «اطلاعیه‌ها / سیستم» with no word about why;
// now the page says who opens access and where, and what the post normally gets.
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';

import '../login/session_controller.dart' show webRoleFa;
import '../pulse/web.dart';

/// Roles that see the guide when nothing is open for them (the counselor always has its
/// referral queue, so it never lands on an empty menu).
const Set<String> noAccessGuideRoles = {'staff', 'office', 'guard'};

class NoAccessGuide extends StatelessWidget {
  const NoAccessGuide({super.key, required this.role});
  final String role;

  @override
  Widget build(BuildContext context) {
    final post = webRoleFa[role] ?? role;
    final defaults = [
      for (final k in roleDefaultAccess[role] ?? const <String>[])
        if (staffAccessArea(k) case final a?) a.label,
    ];
    return WebPageBody(
      children: [
        WebPageHead(title: 'دسترسی ندارید', sub: 'سمت شما: $post'),
        WebCard(
          key: const Key('noaccess-guide'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const WebBanner(
                kind: WebBannerKind.warn,
                text: 'مدیر مدرسه هنوز هیچ کاری را برای شما باز نکرده است؛ برای همین در منو فقط «اطلاعیه‌ها» و «سیستم» را می‌بینید.',
                textKey: Key('noaccess-why'),
              ),
              const Text(
                'از مدیر یا معاون بخواهید: «کاربران» ← نام شما ← «ویرایش» ← بخش «سطح دسترسی» و کارهایی را که انجام می‌دهید تیک بزند. بعد از ذخیره، منوی شما بدون خروج و ورود دوباره به‌روز می‌شود.',
                key: Key('noaccess-how'),
              ),
              if (defaults.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(
                  'آنچه معمولاً برای «$post» باز است: ${defaults.join('، ')}.',
                  key: const Key('noaccess-default'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
