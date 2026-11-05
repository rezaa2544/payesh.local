; ═══════════════════════════════════════════════════════════════════
;  نصب‌کنندهٔ استاندارد ویندوز — پایش-لوکال
;  ساخته می‌شود با Inno Setup 6:   ISCC.exe /DAppVersion=0.3.2 installer\payesh.iss
;  خروجی: releases\payesh-setup.exe  (نام ثابت = لینک دانلود همیشگی)
; ═══════════════════════════════════════════════════════════════════
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "پایش-لوکال"
#define AppPublisher "Payesh Local"
#define AppExeName "start.bat"

[Setup]
AppId={{7C4E2A51-9F3B-4E7A-9C21-5B8A1D3E6F02}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppComments=سامانهٔ مدیریت مدرسه — اجرا روی همین سیستم، دسترسی از هر اینترنتی
DefaultDirName={autopf}\Payesh
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
ShowLanguageDialog=no
Uninstallable=yes
OutputDir=releases
OutputBaseFilename=payesh-setup
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayName={#AppName}
UninstallDisplayIcon={sys}\SHELL32.dll,14
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=نصب‌کنندهٔ پایش-لوکال
SetupLogging=yes
SetupIconFile=install\windows\payesh.ico
UninstallDisplayIcon={app}\payesh.ico
SourceDir=..
UsePreviousAppDir=yes
CloseApplications=no
RestartApplications=no
ChangesAssociations=no

[Languages]
Name: "fa"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "اجرای خودکار هنگام روشن شدن ویندوز"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "firewall"; Description: "باز کردن درگاه ۸۰۸۰ برای شبکهٔ مدرسه"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "desktopicon"; Description: "ساخت آیکون روی دسکتاپ"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "tailscale"; Description: "نصب Tailscale برای دسترسی از هر اینترنتی (رایگان، بدون دامنه)"; GroupDescription: "دسترسی از راه دور:"; Flags: checkedonce

[Files]
Source: ".build\win\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; اجراکنندهٔ «برنامه» و آیکون در ریشهٔ نصب
Source: ".build\win\install\windows\payesh-app.vbs"; DestDir: "{app}"; DestName: "payesh-app.vbs"; Flags: ignoreversion
Source: ".build\win\install\windows\payesh.ico"; DestDir: "{app}"; DestName: "payesh.ico"; Flags: ignoreversion

[Dirs]
Name: "{app}\data"; Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\payesh-app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\payesh.ico"
Name: "{group}\پایش در حالت مرورگر"; Filename: "{sys}\explorer.exe"; Parameters: "http://localhost:8080/"; IconFilename: "{app}\payesh.ico"
Name: "{group}\اجرای پایش با پنجرهٔ خط فرمان"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\حذف {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\payesh-app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\payesh.ico"; Tasks: desktopicon

[Registry]
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PayeshLocal"; ValueData: "wscript.exe ""{app}\start-hidden.vbs"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Payesh Local"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Payesh Local"" dir=in action=allow protocol=TCP localport=8080 profile=any"; Flags: runhidden; Tasks: firewall
Filename: "{cmd}"; Parameters: "/c winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements"; Flags: runhidden waituntilterminated; Tasks: tailscale; StatusMsg: "نصب Tailscale برای دسترسی از هر اینترنتی…"
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-hidden.vbs"""; Flags: nowait runhidden; StatusMsg: "راه‌اندازی سامانه…"
Filename: "{sys}\wscript.exe"; Parameters: """{app}\payesh-app.vbs"""; Description: "باز کردن برنامهٔ پایش"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*server\index.js*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"""; Flags: runhidden; RunOnceId: "StopPayesh"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Payesh Local"""; Flags: runhidden; RunOnceId: "FirewallRule"

[UninstallDelete]
; فقط چیزهایی که خودمان ساخته‌ایم؛ داده‌ها (data) دست‌نخورده می‌ماند
Type: files; Name: "{app}\start-hidden.vbs"
Type: filesandordirs; Name: "{app}\runtime"
