; ═══════════════════════════════════════════════════════════════════
;  Row 126 — Windows installer for the NATIVE owner panel (Flutter)
;  Packages ONLY the Flutter release bundle (apps/payesh/owner/build/windows/x64/
;  runner/Release): payesh_owner.exe + flutter_windows.dll + data\, plus the
;  app-local MSVC runtime copied in by CI. No WebView2, no node.exe, no web UI —
;  tools/native-independence-gate.mjs runs on the INSTALLED directory in CI.
;
;  It REPLACES the retired WebView2 owner shell in place: same AppId and folder as
;  apps/owner-panel/installer/payesh-owner.iss, so Windows treats it as an upgrade.
;  [InstallDelete] removes PayeshOwner.exe and the WebView2 DLLs and the WebView2
;  profile; the remembered server address (%LOCALAPPDATA%\PayeshOwner\origin.txt)
;  is kept and read by the native app.
;  Build (repo root):
;    ISCC.exe /DAppVersion=1.0.0 apps\payesh\owner\windows\installer\payesh-owner-native.iss
;  Output: native-out\payesh-owner-setup.exe
;  Signing: never here. CI signs only with the optional owner Authenticode secrets.
; ═══════════════════════════════════════════════════════════════════
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Payesh Owner Panel"
#define AppPublisher "Payesh Local"
#define AppExeName "payesh_owner.exe"
#define Bundle "apps\payesh\owner\build\windows\x64\runner\Release"

#if !FileExists(AddBackslash(SourcePath) + "..\..\..\..\..\" + Bundle + "\" + AppExeName)
  #error payesh_owner.exe not built — run: flutter build windows --release (in apps\payesh\owner)
#endif
#if FileExists(AddBackslash(SourcePath) + "..\..\..\..\..\" + Bundle + "\WebView2Loader.dll")
  #error WebView2Loader.dll in the native owner bundle — refused
#endif
#if FileExists(AddBackslash(SourcePath) + "..\..\..\..\..\" + Bundle + "\node.exe")
  #error node.exe in the native owner bundle — refused
#endif

[Setup]
AppId={{20AE76FD-560D-41ED-B6F5-7F66F3308129}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/rezaa2544/payesh.local
AppCopyright=(c) 1405 {#AppPublisher} — MIT License
AppComments=Payesh platform owner panel — native app (no WebView, no Node.js)
SourceDir=..\..\..\..\..
DefaultDirName={localappdata}\Programs\PayeshOwner
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
ShowLanguageDialog=no
Uninstallable=yes
OutputDir=native-out
OutputBaseFilename=payesh-owner-setup
SetupIconFile=apps\payesh\owner\windows\runner\resources\app_icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayName={#AppName} (native)
UninstallDisplayIcon={app}\{#AppExeName}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Payesh owner panel native installer
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Options:"; Flags: unchecked

[InstallDelete]
; the retired WebView2 shell (ADR-62) — never left next to the native app
Type: files; Name: "{app}\PayeshOwner.exe"
Type: files; Name: "{app}\Microsoft.Web.WebView2.Core.dll"
Type: files; Name: "{app}\Microsoft.Web.WebView2.WinForms.dll"
Type: files; Name: "{app}\WebView2Loader.dll"
Type: filesandordirs; Name: "{localappdata}\PayeshOwner\WebView2"
; old shortcuts that pointed at PayeshOwner.exe
Type: files; Name: "{autoprograms}\پنل مالک پایش.lnk"
Type: files; Name: "{autodesktop}\پنل مالک پایش.lnk"

[Files]
Source: "{#Bundle}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Start Payesh Owner Panel"; Flags: nowait postinstall skipifsilent
