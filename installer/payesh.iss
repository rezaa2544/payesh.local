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

; ── نگهبان: میان‌بر برنامه به Payesh.exe اشاره می‌کند، پس باید واقعاً ساخته شده باشد
#if !FileExists(AddBackslash(SourcePath) + "..\.build\win\desktop\Payesh.exe")
  #error Payesh.exe ساخته نشده — اول desktop/build.ps1 را اجرا کنید
#endif
#if !FileExists(AddBackslash(SourcePath) + "..\.build\win\desktop\WebView2Loader.dll")
  #error WebView2Loader.dll کنار برنامه نیست — build.ps1 ناقص اجرا شده
#endif
; بدون Node، سرور مدرسه بالا نمی‌آید و کاربر صفحهٔ «اتصال برقرار نشد» می‌بیند
#if !FileExists(AddBackslash(SourcePath) + "..\.build\win\runtime\node.exe")
  #error runtime\node.exe در بسته نیست — نصب بدون Node ناقص است
#endif

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
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=نصب‌کنندهٔ پایش-لوکال
SetupLogging=yes
SetupIconFile=install\windows\payesh.ico
UninstallDisplayIcon={app}\payesh.ico
SourceDir=..
UsePreviousAppDir=yes
CloseApplications=yes
RestartApplications=no
ChangesAssociations=no

[Code]
{ ─────────────────────────────────────────────────────────────────
  نصب روی نسخهٔ در حال اجرا: سرور مدرسه (runtime\node.exe) و پنجرهٔ
  برنامه (desktop\Payesh.exe) فایل‌ها را قفل می‌کنند و ویندوز خطای
  «DeleteFile failed; code 5 — Access is denied» می‌دهد. قبل از کپی،
  هر پردازه‌ای که از پوشهٔ نصب اجرا شده باشد را می‌بندیم.
  ───────────────────────────────────────────────────────────────── }

procedure RunHidden(const Exe, Params: String);
var
  Code: Integer;
begin
  Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure StopPayeshProcesses();
var
  Ps, App, Script: String;
begin
  App := ExpandConstant('{app}');
  Ps := ExpandConstant('{tmp}\payesh-stop.ps1');
  Script :=
    '$app = ''' + App + '''' + #13#10 +
    '$me = $PID' + #13#10 +
    'function KillIt($list) { foreach ($p in $list) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} } }' + #13#10 +
    'KillIt (Get-CimInstance Win32_Process | Where-Object {' + #13#10 +
    '  $_.ProcessId -ne $me -and (' + #13#10 +
    '    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, ''OrdinalIgnoreCase'')) -or' + #13#10 +
    '    ($_.CommandLine -and $_.CommandLine.IndexOf($app, ''OrdinalIgnoreCase'') -ge 0)' + #13#10 +
    '  )' + #13#10 +
    '})' + #13#10 +
    'Start-Sleep -Milliseconds 900' + #13#10 +
    'KillIt (Get-CimInstance Win32_Process | Where-Object {' + #13#10 +
    '  ($_.Name -eq ''node.exe'' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, ''OrdinalIgnoreCase'')) -or' + #13#10 +
    '  ($_.Name -eq ''Payesh.exe'')' + #13#10 +
    '})' + #13#10;
  SaveStringToFile(Ps, Script, False);
  RunHidden(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + Ps + '"');
  Sleep(400);
  DeleteFile(Ps);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopPayeshProcesses();
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    StopPayeshProcesses();
end;

function InitializeUninstall(): Boolean;
begin
  StopPayeshProcesses();
  Result := True;
end;

[Languages]
Name: "fa"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "اجرای خودکار هنگام روشن شدن ویندوز"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "firewall"; Description: "باز کردن درگاه ۸۰۸۰ برای شبکهٔ مدرسه"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "desktopicon"; Description: "ساخت آیکون روی دسکتاپ"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "tailscale"; Description: "نصب Tailscale برای دسترسی از هر اینترنتی (رایگان، بدون دامنه)"; GroupDescription: "دسترسی از راه دور:"; Flags: checkedonce
Name: "cloudflared"; Description: "آوردن cloudflared به‌عنوان پشتیبان تونل (اگر Tailscale نصب/وارد نشده باشد)"; GroupDescription: "دسترسی از راه دور:"; Flags: checkedonce
Name: "clientmode"; Description: "این رایانه فقط کاربر است و به سیستم مدرسه وصل می‌شود (نه سرور)"; GroupDescription: "نوع نصب:"; Flags: unchecked

[Files]
Source: ".build\win\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; اجراکنندهٔ «برنامه» و آیکون در ریشهٔ نصب
Source: ".build\win\install\windows\payesh-app.vbs"; DestDir: "{app}"; DestName: "payesh-app.vbs"; Flags: ignoreversion
Source: ".build\win\install\windows\payesh.ico"; DestDir: "{app}"; DestName: "payesh.ico"; Flags: ignoreversion

[Dirs]
Name: "{app}\data"; Permissions: users-modify

[INI]
; نقش این نصب: سرور مدرسه (پیش‌فرض) یا فقط کاربر
Filename: "{app}\payesh.ini"; Section: "payesh"; Key: "role"; String: "client"; Tasks: clientmode

[Icons]
; پنجرهٔ واقعی برنامه (WebView2) — نه تب مرورگر
Name: "{group}\{#AppName}"; Filename: "{app}\desktop\Payesh.exe"; WorkingDir: "{app}"; IconFilename: "{app}\payesh.ico"; Comment: "سامانهٔ مدیریت مدرسه"
Name: "{group}\پایش — اتصال به سرور مدرسه"; Filename: "{app}\desktop\Payesh.exe"; Parameters: "--client"; WorkingDir: "{app}"; IconFilename: "{app}\payesh.ico"
Name: "{group}\پایش — اجرا به‌عنوان سرور (این رایانه)"; Filename: "{app}\desktop\Payesh.exe"; Parameters: "--server"; WorkingDir: "{app}"; IconFilename: "{app}\payesh.ico"; Comment: "این رایانه هم سامانه را بالا می‌آورد (سرور پشتیبان)"
Name: "{group}\اجرای سرور با پنجرهٔ خط فرمان"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\حذف {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\desktop\Payesh.exe"; WorkingDir: "{app}"; IconFilename: "{app}\payesh.ico"; Tasks: desktopicon

[Registry]
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PayeshLocal"; ValueData: """{app}\desktop\Payesh.exe"" --server --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; cloudflared پشتیبان: اگر دانلود نشد، برنامه فقط از Tailscale/شبکه استفاده می‌کند (بی‌خطر)
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$ErrorActionPreference='SilentlyContinue'; New-Item -ItemType Directory -Force -Path '{app}\bin' | Out-Null; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '{app}\bin\cloudflared.exe' -UseBasicParsing"""; Flags: runhidden nowait; Tasks: cloudflared
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Payesh Local"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Payesh Local"" dir=in action=allow protocol=TCP localport=8080 profile=any"; Flags: runhidden; Tasks: firewall
Filename: "{cmd}"; Parameters: "/c winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements"; Flags: runhidden waituntilterminated; Tasks: tailscale; StatusMsg: "نصب Tailscale برای دسترسی از هر اینترنتی…"
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-hidden.vbs"""; Flags: nowait runhidden; StatusMsg: "راه‌اندازی سامانه…"
Filename: "{app}\desktop\Payesh.exe"; Description: "باز کردن برنامهٔ پایش"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*server\index.js*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"""; Flags: runhidden; RunOnceId: "StopPayesh"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Payesh Local"""; Flags: runhidden; RunOnceId: "FirewallRule"

[UninstallDelete]
; فقط چیزهایی که خودمان ساخته‌ایم؛ داده‌ها (data) دست‌نخورده می‌ماند
Type: files; Name: "{app}\start-hidden.vbs"
Type: filesandordirs; Name: "{app}\desktop"
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\payesh.ini"
Type: filesandordirs; Name: "{app}\runtime"
