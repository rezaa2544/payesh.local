' اجرای بی‌پنجرهٔ پایش-لوکال — از هر جای نصب‌شده کار می‌کند
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
node = dir & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node"
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.Run """" & node & """ --experimental-sqlite --disable-warning=ExperimentalWarning """ & dir & "\server\index.js"" >> """ & dir & "\data\server.log"" 2>&1", 0, False
