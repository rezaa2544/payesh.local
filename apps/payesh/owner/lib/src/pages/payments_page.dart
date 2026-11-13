// «پرداخت‌ها» — صفحهٔ جدا در گروه «مالی و اشتراک» (ردیف ۱۵۱؛ بخش آن در ردیف ۱۴۹ ساخته شد).
import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../schools/payments_section.dart';
import '../widgets.dart';

class PaymentsPage extends StatelessWidget {
  const PaymentsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final scope = OwnerScope.of(context);
    final reg = scope.schools;
    if (reg == null) {
      return const Center(
        key: Key('payments-none'),
        child: Text('فهرست مدارس و اشتراک‌ها هنوز در دسترس نیست.'),
      );
    }
    return ListView(
      key: const Key('payments-page'),
      padding: const EdgeInsets.all(PayeshTokens.space4),
      children: [
        PaymentsSection(
          registry: reg,
          flash: scope.flash,
          canManage: scope.caps.renew,
        ),
      ],
    );
  }
}
