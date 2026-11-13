# Frozen school WebView build — negative control only (row 129)

**Not for distribution.** This folder holds the last school Android WebView APK (`payesh-local.apk`)
that was published on the `continuous` release before row 129 removed every WebView build from
Release and from the download page.

- It is used only by `native-client.yml` (job `gate-controls`): the native-independence gate must
  **reject** it (`--expect-fail`). If the gate ever accepts it, the gate is broken and CI turns red.
- The Windows WebView control is `payesh-local-windows-0.9.2.zip` (sha-pinned, moved here from
  `releases/` because every version bump prunes the old release zips).
- Integrity: `sha256sum -c SHA256SUMS` runs before every use.
- Registered in [`docs/cloud/125-installables.json`](../../docs/cloud/125-installables.json) as
  `school-webview-fixtures` (declared `webview`, status `fixture`, never published).

The school app that is published now is the native Flutter app (`native-continuous`, row 129).
