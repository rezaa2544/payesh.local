' ═══════════════════════════════════════════════════════════════════
'  اجرای «برنامه» پایش روی ویندوز
'  ───────────────────────────────────────────────────────────────────
'  این فایل فقط یک کار می‌کند: پنجرهٔ واقعی برنامه (desktop\Payesh.exe)
'  را باز می‌کند. خودِ آن برنامه سرور را بالا می‌آورد، منتظر آماده شدنش
'  می‌ماند و صفحه را نشان می‌دهد.
'
'  ⚠️ هیچ مرورگری (Edge/Chrome/مرورگر پیش‌فرض) باز نمی‌شود. شکایت کاربر
'     دقیقاً همین بود: «چرا صفحهٔ خطای مرورگر می‌آید؟ باید برنامهٔ مستقل
'     باشد». پس این اسکریپت هیچ مسیر «--app» یا باز کردن آدرس ندارد؛ اگر
'     برنامهٔ ویندوز نصب نباشد، پیام روشن می‌دهد و بس.
' ═══════════════════════════════════════════════════════════════════
Option Explicit

Dim fso, sh, dir, exePath, i, spots, found, msg

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' مسیرهای ممکن برای برنامهٔ ویندوز، به‌ترتیب
spots = Array( _
    dir & "\desktop\Payesh.exe", _
    dir & "\Payesh.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Payesh-لوکال\desktop\Payesh.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Payesh-لوکال\desktop\Payesh.exe", _
    "C:\Payesh\desktop\Payesh.exe" _
)

found = ""
For i = 0 To UBound(spots)
    If found = "" Then
        If fso.FileExists(spots(i)) Then found = spots(i)
    End If
Next

If found <> "" Then
    On Error Resume Next
    sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(found))
    sh.Run """" & found & """", 1, False
    If Err.Number = 0 Then
        WScript.Quit 0
    End If
    Err.Clear
    On Error GoTo 0
End If

' برنامهٔ ویندوز نیست: فقط پیام روشن — هیچ مرورگری باز نمی‌شود
msg = "برنامهٔ ویندوزِ پایش در این نصب پیدا نشد." & vbCrLf & vbCrLf & _
      "برای اینکه پایش مثل هر برنامهٔ معمولی (پنجرهٔ مستقل، بدون مرورگر) باز شود، " & _
      "نصب‌کنندهٔ رسمی را اجرا کنید:" & vbCrLf & vbCrLf & _
      "  payesh-setup.exe" & vbCrLf & vbCrLf & _
      "همین فایل در همان پوشه‌ای است که این برنامه را از آن باز کردید " & _
      "(یا از صفحهٔ نصب، بخش ویندوز، دانلودش کنید)." & vbCrLf & vbCrLf & _
      "داده‌های مدرسه در پوشهٔ data دست‌نخورده می‌ماند."
MsgBox msg, vbExclamation, "پایش"
WScript.Quit 1
