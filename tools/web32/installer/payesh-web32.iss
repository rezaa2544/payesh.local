; ═══════════════════════════════════════════════════════════════════
;  Row 169 (D-50) — installer of the 32-bit Windows edition (web32)
;  The school app (Edition=app) or the owner panel (Edition=owner) for 32-bit Windows 7 SP1,
;  8, 8.1 and 10: the same Flutter code as the 64-bit build compiled to JavaScript, in a
;  32-bit Chromium 109 (CEF) program — tools/web32/shell. Per-user, no UAC, own AppId and
;  own folder (never touches the 64-bit installation). Runs on 64-bit Windows too.
;  Build (repo root, after .github/workflows/win32-edition.yml assembled the bundle):
;    ISCC.exe /DEdition=app /DAppVersion=0.2.1 /DBundle=web32-out\app tools\web32\installer\payesh-web32.iss
;  Output: web32-out\payesh-native32-setup.exe | web32-out\payesh-owner32-setup.exe
; ═══════════════════════════════════════════════════════════════════
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Edition
  #error /DEdition=app or /DEdition=owner
#endif
#ifndef Bundle
  #error /DBundle=<assembled web32 folder>
#endif
#if Edition == "owner"
  #define AppName "Payesh Owner Panel"
  #define AppExeName "payesh_owner.exe"
  #define AppGuid "{{DB294FA8-5FEA-4E9F-AE39-F960A3CF7499}"
  #define Folder "PayeshOwner32"
  #define OutName "payesh-owner32-setup"
#else
  #define AppName "Payesh"
  #define AppExeName "payesh_app.exe"
  #define AppGuid "{{1D3C5D12-9689-4D21-989B-259DBE531A74}"
  #define Folder "PayeshNative32"
  #define OutName "payesh-native32-setup"
#endif
#define AppPublisher "Payesh Local"

#if !FileExists(AddBackslash(SourcePath) + "..\..\..\" + Bundle + "\" + AppExeName)
  #error the web32 program is missing from the bundle
#endif
#if !FileExists(AddBackslash(SourcePath) + "..\..\..\" + Bundle + "\libcef.dll")
  #error libcef.dll is missing from the bundle
#endif
#if !FileExists(AddBackslash(SourcePath) + "..\..\..\" + Bundle + "\web\main.dart.js")
  #error the Flutter web build is missing from the bundle
#endif
#if FileExists(AddBackslash(SourcePath) + "..\..\..\" + Bundle + "\node.exe")
  #error node.exe in the bundle — refused
#endif

[Setup]
AppId={#AppGuid}
AppName={#AppName} (32-bit)
AppVersion={#AppVersion}
AppVerName={#AppName} (32-bit) {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/rezaa2544/payesh.local
AppCopyright=(c) 1405 {#AppPublisher} — MIT License
AppComments=Payesh — 32-bit Windows edition (same Flutter app, Chromium 109 host; D-50)
SourceDir=..\..\..
DefaultDirName={localappdata}\Programs\{#Folder}
DefaultGroupName={#AppName} (32-bit)
DisableProgramGroupPage=yes
DisableDirPage=yes
ShowLanguageDialog=no
Uninstallable=yes
OutputDir=web32-out
OutputBaseFilename={#OutName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
; 32-bit program: installs on 32-bit AND 64-bit Windows (no ArchitecturesAllowed limit).
MinVersion=6.1sp1
UninstallDisplayName={#AppName} (32-bit)
UninstallDisplayIcon={app}\{#AppExeName}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Payesh 32-bit Windows edition installer
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "{#Bundle}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; An update may drop files (e.g. an older web build's assets): start from a clean web folder.
Type: filesandordirs; Name: "{app}\web"

[Icons]
; own names: on a PC that also has the 64-bit app, "Payesh" / "Payesh Owner Panel" belong to it
Name: "{autoprograms}\{#AppName} (32-bit)"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName} (32-bit)"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent
