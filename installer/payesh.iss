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

; ── استانداردهای مایکروسافت ─────────────────────────────────────────
;  • شناسنامهٔ کامل (نام، شرکت، نسخه، حق نشر، نشانی) — بدون آن ویندوز
;    نصب‌کننده را «ناشناس» می‌بیند و «ویژگی‌های فایل» خالی است.
;  • PrivilegesRequiredOverridesAllowed: اگر کاربر دسترسی مدیر ندارد،
;    می‌تواند «فقط برای من» نصب کند و هیچ پنجرهٔ دسترسیِ مدیر نبیند.
;  • اگر روزی گواهی امضای کد (Authenticode) داشتیم، با /DSignedBuild
;    همین فایل خودکار امضا می‌شود و هشدار «ناشر ناشناس» برداشته می‌شود.
#ifdef SignedBuild
SignTool=payesh
SignedUninstaller=yes
#endif

[Setup]
AppId={{7C4E2A51-9F3B-4E7A-9C21-5B8A1D3E6F02}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/rezaa2544/payesh.local
AppSupportURL=https://github.com/rezaa2544/payesh.local
AppUpdatesURL=https://github.com/rezaa2544/payesh.local/releases
AppCopyright=© 1404 {#AppPublisher} — MIT License
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
; اجازهٔ نصب «فقط برای من» بدون دسترسی مدیر (بدون پنجرهٔ UAC)
PrivilegesRequiredOverridesAllowed=dialog
; در به‌روزرسانی، همان حالت نصب قبلی حفظ می‌شود و دوباره پرسیده نمی‌شود
UsePreviousPrivileges=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
VersionInfoProductTextVersion={#AppVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoCopyright=© 1404 {#AppPublisher} — MIT License
VersionInfoDescription=نصب‌کنندهٔ پایش-لوکال — سامانهٔ مدیریت مدرسه
SetupLogging=yes
SetupIconFile=install\windows\payesh.ico
UninstallDisplayIcon={app}\payesh.ico
SourceDir=..
UsePreviousAppDir=yes
CloseApplications=yes
RestartApplications=no
ChangesAssociations=no
ChangesEnvironment=no

[Code]
{ ─────────────────────────────────────────────────────────────────
  نصب روی نسخهٔ در حال اجرا: سرور مدرسه (runtime\node.exe) و پنجرهٔ
  برنامه (desktop\Payesh.exe) فایل‌ها را قفل می‌کنند و ویندوز خطای
  «DeleteFile failed; code 5 — Access is denied» می‌دهد. قبل از کپی،
  هر پردازه‌ای که از پوشهٔ نصب اجرا شده باشد را می‌بندیم.
  ───────────────────────────────────────────────────────────────── }

// آیا موتور نمایش (WebView2 Runtime) روی این ویندوز هست؟
// برنامه هیچ مرورگری باز نمی‌کند؛ اگر این جزء نباشد، برنامه پیام فارسی
// می‌دهد و نصب‌کننده همان‌جا نصبش می‌کند.
// (در بخش [Code] کامنت با // است؛ ; فقط در بخش‌های .iss کامنت است)
function WebView2Installed(): Boolean;
var
  v: String;
begin
  Result := False;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') then Result := True;
  if (not Result) and RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') then Result := True;
  if (not Result) and RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') then Result := True;
  if not Result then
    Result := FileExists(ExpandConstant('{programfiles(x86)}\Microsoft\EdgeWebView\Application\msedgewebview2.exe'));
end;

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


{ اجازهٔ نوشتن روی پوشه‌های کد برای همهٔ کاربران — لازمهٔ «به‌روزرسانی خودکار» بدون خطای دسترسی }
procedure FixUpdatePermissions();
var
  Code: Integer;
  Args: String;
begin
  { در نصب «فقط برای من» پوشه مالِ خودِ کاربر است و اجازه‌دادن لازم نیست }
  if not IsAdminInstallMode then Exit;
  Args :=
    '"' + ExpandConstant('{app}\client') + '" ' +
    '"' + ExpandConstant('{app}\server') + '" ' +
    '"' + ExpandConstant('{app}\releases') + '" ' +
    '/grant *S-1-5-32-545:(OI)(CI)M /T /C /Q';
  Exec(ExpandConstant('{sys}\icacls.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, Code);
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
  if CurStep = ssPostInstall then
    FixUpdatePermissions();
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
Name: "firewall"; Description: "باز کردن درگاه ۸۰۸۰ برای شبکهٔ مدرسه (نیاز به دسترسی مدیر)"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "desktopicon"; Description: "ساخت آیکون روی دسکتاپ"; GroupDescription: "گزینه‌ها:"; Flags: checkedonce
Name: "tailscale"; Description: "نصب Tailscale برای دسترسی از هر اینترنتی (رایگان، بدون دامنه)"; GroupDescription: "دسترسی از راه دور:"; Flags: checkedonce
Name: "clientmode"; Description: "این رایانه فقط کاربر است و به سیستم مدرسه وصل می‌شود (نه سرور)"; GroupDescription: "نوع نصب:"; Flags: unchecked

[Files]
Source: ".build\win\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; اجراکنندهٔ «برنامه» و آیکون در ریشهٔ نصب
Source: ".build\win\install\windows\payesh-app.vbs"; DestDir: "{app}"; DestName: "payesh-app.vbs"; Flags: ignoreversion
Source: ".build\win\install\windows\payesh.ico"; DestDir: "{app}"; DestName: "payesh.ico"; Flags: ignoreversion

[Dirs]
Name: "{app}\data"; Permissions: users-modify
; پوشه‌های کد باید نوشتنی باشند تا «به‌روزرسانی درجا» بدون خطای دسترسی انجام شود
Name: "{app}\client"; Permissions: users-modify
Name: "{app}\server"; Permissions: users-modify
Name: "{app}\releases"; Permissions: users-modify

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
; اجرای خودکار هنگام روشن‌شدن ویندوز — جای درستش با نوع نصب تعیین می‌شود
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PayeshLocal"; ValueData: """{app}\desktop\Payesh.exe"" --server --tray"; Flags: uninsdeletevalue; Tasks: autostart; Check: IsAdminInstallMode
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PayeshLocal"; ValueData: """{app}\desktop\Payesh.exe"" --server --tray"; Flags: uninsdeletevalue; Tasks: autostart; Check: not IsAdminInstallMode

[Run]
; اجازهٔ نوشتن برای همهٔ کاربران روی پوشه‌های کد (نسخه‌های قبلی این اجازه را نداشتند)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Payesh Local"""; Flags: runhidden; Tasks: firewall; Check: IsAdminInstallMode
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Payesh Local"" dir=in action=allow protocol=TCP localport=8080,8090-8093 profile=any"; Flags: runhidden; Tasks: firewall; Check: IsAdminInstallMode
Filename: "{cmd}"; Parameters: "/c winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements"; Flags: runhidden waituntilterminated; Tasks: tailscale; StatusMsg: "نصب Tailscale برای دسترسی از هر اینترنتی…"; Check: IsAdminInstallMode
; موتور نمایش برنامه (پنجرهٔ واقعی) — نصب رسمی و بی‌صدا، بدون باز کردن مرورگر
Filename: "{app}\runtime\MicrosoftEdgeWebView2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "نصب موتور نمایش برنامه…"; Flags: runhidden waituntilterminated skipifdoesntexist; Check: not WebView2Installed
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
