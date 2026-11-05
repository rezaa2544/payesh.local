' ═══════════════════════════════════════════════════════════════════
'  اجرای «برنامهٔ» پایش روی ویندوز
'  • اگر سامانه بالا نباشد، خودش آن را (بی‌پنجره) راه می‌اندازد
'  • بعد پنجرهٔ برنامه را باز می‌کند (بدون نوار آدرس و تب مرورگر)
'  • اگر مرورگرِ مناسب نبود، با مرورگر پیش‌فرض باز می‌کند
' ═══════════════════════════════════════════════════════════════════
Option Explicit

Dim fso, sh, dir, url, health, logFile, i, ok, exe, args, profile
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:8080/"
health = url & "api/health"
logFile = dir & "\data\server.log"

Function IsUp()
    Dim http
    IsUp = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then Err.Clear : Exit Function
    http.setTimeouts 400, 400, 900, 900
    http.Open "GET", health, False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then IsUp = True
    Err.Clear
    On Error GoTo 0
End Function

' ── ۱) سامانه روشن است؟ ─────────────────────────────────────────────
If Not IsUp() Then
    On Error Resume Next
    sh.Run "wscript.exe """ & dir & "\start-hidden.vbs""", 0, False
    On Error GoTo 0
    For i = 1 To 60
        If IsUp() Then Exit For
        WScript.Sleep 500
    Next
End If

If Not IsUp() Then
    MsgBox "سامانهٔ پایش بالا نیامد." & vbCrLf & vbCrLf & _
           "علت احتمالی: Node.js یا فایل‌های برنامه کامل نصب نشده‌اند." & vbCrLf & _
           "جزئیات در این فایل ثبت می‌شود:" & vbCrLf & logFile & vbCrLf & vbCrLf & _
           "می‌توانید install.bat را دوباره اجرا کنید.", vbExclamation, "پایش"
    sh.Run """" & dir & "\start.bat""", 1, False
    WScript.Quit 1
End If

' ── ۲) پنجرهٔ برنامه ────────────────────────────────────────────────
profile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Payesh\app"
exe = ""
Dim candidates(3)
candidates(0) = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
candidates(1) = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
candidates(2) = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
candidates(3) = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe"
For i = 0 To 3
    If exe = "" And fso.FileExists(candidates(i)) Then exe = candidates(i)
Next

If exe <> "" Then
    args = "--app=" & url & " --window-size=1280,900 --window-position=80,40" & _
           " --user-data-dir=""" & profile & """ --no-first-run --no-default-browser-check"
    sh.Run """" & exe & """ " & args, 1, False
Else
    sh.Run url, 1, False
End If
