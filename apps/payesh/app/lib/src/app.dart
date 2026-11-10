import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:payesh_core/payesh_core.dart';

/// Root widget of the native Payesh client (ADR-43). Persian, right-to-left, Material 3.
/// The full design system (tokens, Jalali, bundled font, dark theme) arrives with row 73.
class PayeshApp extends StatelessWidget {
  const PayeshApp({super.key});

  static const Locale fa = Locale('fa', 'IR');

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'پایش',
      debugShowCheckedModeBanner: false,
      locale: fa,
      supportedLocales: const [fa],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F766E)),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('پایش')),
      body: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('نسخهٔ بومی پایش', key: Key('home-title')),
            SizedBox(height: 8),
            Text(PayeshApi.syncContract, key: Key('home-contract')),
          ],
        ),
      ),
    );
  }
}
