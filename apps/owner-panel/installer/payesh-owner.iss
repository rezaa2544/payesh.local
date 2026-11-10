; ═══════════════════════════════════════════════════════════════════
;  نصب‌کنندهٔ پنل مالک پایش — ADR‑62
;  جدا از installer/payesh.iss (اپ مدرسه): AppId، پوشهٔ نصب، نام میان‌بر
;  و فایل اجرایی همه متفاوت‌اند. نصب «فقط برای کاربر جاری»، بدون UAC.
;  ساخت (ریشهٔ مخزن):
;    ISCC.exe /DAppVersion=0.9.2 apps\owner-panel\installer\payesh-owner.iss
;  خروجی: releases\owner\payesh-owner-setup.exe
;  امضا: این فایل خودش امضا نمی‌کند؛ workflow فقط با Secret مالک
;  (PAYESH_OWNER_WIN_PFX_B64/PASS) خروجی را امضا و Authenticode را تأیید می‌کند.
; ═══════════════════════════════════════════════════════════════════
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "پنل مالک پایش"
#define AppPublisher "Payesh Local"
#define AppExeName "PayeshOwner.exe"

#if !FileExists(AddBackslash(SourcePath) + "..\..\..\.build\owner\desktop\PayeshOwner.exe")
  #error PayeshOwner.exe ساخته نشده — اول apps\owner-panel\desktop\build.ps1
#endif
#if !FileExists(AddBackslash(SourcePath) + "..\..\..\.build\owner\desktop\WebView2Loader.dll")
  #error WebView2Loader.dll کنار PayeshOwner.exe نیست
#endif

[Setup]
AppId={{20AE76FD-560D-41ED-B6F5-7F66F3308129}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/rezaa2544/payesh.local
AppCopyright=© 1405 {#AppPublisher} — MIT License
AppComments=ابزار مدیریتی مالک پلتفرم — فقط برای مالک
SourceDir=..\..\..
DefaultDirName={localappdata}\Programs\PayeshOwner
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
ShowLanguageDialog=no
Uninstallable=yes
OutputDir=releases\owner
OutputBaseFilename=payesh-owner-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}
SetupIconFile=apps\owner-panel\desktop\payesh-owner.ico
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=نصب‌کنندهٔ پنل مالک پایش
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "fa"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "ساخت آیکون روی دسکتاپ"; GroupDescription: "گزینه‌ها:"; Flags: unchecked

[Files]
Source: ".build\owner\desktop\PayeshOwner.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: ".build\owner\desktop\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: ".build\owner\desktop\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: ".build\owner\desktop\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Comment: "پنل مالک پلتفرم پایش"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "اجرای پنل مالک"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\PayeshOwner\WebView2"
