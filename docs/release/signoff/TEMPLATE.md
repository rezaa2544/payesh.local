# Native release signoff (row 95). Copy this file to `native-vX.Y.Z.md`

tag: native-vX.Y.Z
rc_sha: <the full 40-character sha of the commit whose RC build you tested>
owner: <name>
date: YYYY-MM-DD
result: FAIL

Change `result` to `PASS` only when every box below is ticked.

- [ ] **M1** Real Android phone: model ___, Android ___, APK sha256 ___
- [ ] **M2** Android signing: apksigner v2/v3 true, cert sha256 ___ = owner key, not debug
- [ ] **M3** Real Windows PC: Windows build ___, bundle sha256 ___
- [ ] **M4** Windows Authenticode: signtool verify /pa OK, signer ___, timestamp ___
- [ ] **M5** Android update → rollback: versionCode ___ → ___ → ___, data kept: ___
- [ ] **M6** Windows update → rollback: version ___ → ___ → ___, data kept: ___

Notes:
