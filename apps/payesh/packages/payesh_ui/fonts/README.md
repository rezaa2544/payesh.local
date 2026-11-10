# Bundled font — Vazirmatn v33.003

| | |
|---|---|
| Source | https://github.com/rastikerdar/vazirmatn/releases/tag/v33.003 (`vazirmatn-v33.003.zip`, sha256 `0a9afd41967e6f57096a56a181a23f81a2b999b62f1f2a4e4b26736580854fdb`) |
| Files | `fonts/ttf/Vazirmatn-{Regular,Medium,Bold}.ttf` from that archive, unmodified (hashes in `SHA256SUMS`) |
| Licence | SIL Open Font License 1.1 — full text in `OFL.txt` (copied from the same tag). Bundling in an application is permitted; the font is not sold by itself; the Reserved Font Name is not used for a modified version (none is made). |
| Why | Same family as the web client (`client/styles.css` → `"Vazirmatn"` first); the native app ships it so text renders identically on Android and Windows without a system font or any network fetch. |

`test/font_license_test.dart` fails if a TTF is changed without updating `SHA256SUMS`, or if `OFL.txt` is missing.
