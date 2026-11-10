# Row 73 — Native design system (`apps/payesh/packages/payesh_ui`)

Status: implemented under ADR‑43 / D‑43. Evidence: CI `native-client` (job `dart`, step
"payesh_ui goldens + RTL/Jalali/a11y", job `engine-web-conformance`) and
`docs/cloud/reports/evidence/native-73-75-ci.txt`.

| Acceptance item | Where | Test |
|---|---|---|
| Design tokens (one source) | `lib/src/tokens.dart` — colours = `client/styles.css` light/dark variables; spacing, radius, 48 dp target, breakpoints, font | `a11y_contrast_test.dart` |
| Light + dark themes | `lib/src/theme.dart` `PayeshUi.light/dark`; `PayeshMaterialApp` follows the system (`ThemeMode.system`) | `widgets_test.dart`, app `widget_test.dart`, goldens `*_dark.png` |
| Full RTL | `PayeshUi.locale = fa-IR` + Global Material/Widgets/Cupertino localisations → `TextDirection.rtl`; rail on the right, leading icons on the right | `widgets_test.dart` "full RTL", Windows rail `right == 1280` |
| Jalali (ISO stored, Jalali shown) | `lib/src/jalali.dart` `JalaliDate.fromIso/toIso/parse/format`, `jalaliText`, `JalaliDateText` | `jalali_test.dart` (every day 1900‥2150, contiguity, leap years), `jalali_conformance_test.dart` |
| Parity with the web client | `docs/cloud/contracts/conformance/jalali-v1.json` is **generated from** `client/app.js` + `client/import.js` and re-checked by `node tests/conformance-jalali-73.js` | same file on both sides (3 650 dates, 1 015 Jalali→ISO incl. rejections, digits) |
| Persian digits | `faDigits`, `latinDigits` (Persian + Arabic‑Indic input), `faNumber` (٬ separator) | vectors + `jalali_test.dart` |
| Bundled font with licence | `fonts/Vazirmatn-{Regular,Medium,Bold}.ttf` v33.003, `fonts/OFL.txt` (SIL OFL 1.1), `fonts/SHA256SUMS`, `fonts/README.md` | `font_license_test.dart` |
| Golden tests in CI | `test/golden_test.dart` → `test/goldens/{android,windows}_{light,dark}.png`, `android_light_text2x.png`, rendered with the real Vazirmatn | CI step fails on any skip; ≤0.5 % anti‑aliasing tolerance |
| Accessibility | WCAG AA contrast for every text/surface/tone pair (light + dark), `meetsGuideline` tap target / labelled targets / text contrast, semantics labels (dates read with weekday, stat tiles, badges, headers), text scale ×1.3 and ×2 with no overflow | `a11y_contrast_test.dart`, `widgets_test.dart` |
| Windows / Android compatibility | `AdaptiveScaffold`: bottom `NavigationBar` < 600 dp, `NavigationRail` 600‥840, extended rail ≥ 840 (Windows window); compact density on desktop, standard on Android; 48 dp hit area kept on both | `widgets_test.dart`, goldens |

## Web bug found and fixed while generating vectors

`client/app.js` `toJalali` computed `jy += floor((days-1)/365)` also for `days = 0`, which
shows **1 Farvardin one year too early** on 68 Nowruz days between 1900 and 2150 (e.g.
2024‑03‑20 → `1402/1/1` instead of `1403/1/1`; next occurrence 2028‑03‑20). The standard
jalaali form (`if (days > 365) { … }`) is restored; `tests/conformance-jalali-73.js` now
round‑trips **every** day 1900‥2150 on the web side, so the bug cannot return. The native
port uses the corrected algorithm; the vectors are produced by the corrected web code.

## Deliberate token deviation

Light `muted` is `#5F6F86` in the native app (web `#64748b` gives 4.40:1 on `--bg`, below AA
4.5:1). Dark accents are lightened versions of the web colours for the same reason. Both are
enforced by `a11y_contrast_test.dart`.
