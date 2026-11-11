; ═══════════════════════════════════════════════════════════════════
;  Row 77 — Windows installer for the NATIVE Payesh client (Flutter, ADR-43)
;  Packages ONLY the Flutter release bundle (apps/payesh/app/build/windows/x64/
;  runner/Release): payesh_app.exe + flutter_windows.dll + plugin DLLs + data\,
;  plus the app-local MSVC runtime DLLs copied in by CI. No node.exe, no WebView2,
;  no web UI — tools/native-independence-gate.mjs (row 63) runs on the INSTALLED
;  directory in CI (.github/workflows/native-client.yml, job windows).
;  Separate from installer/payesh.iss (legacy school app) and the owner panel:
;  own AppId, own folder, per-user install without UAC.
;  Build (repo root):
;    ISCC.exe /DAppVersion=0.1.0 apps\payesh\app\windows\installer\payesh-native.iss
;  Output: native-out\payesh-native-setup.exe
;  Signing: this script never signs. CI signs with Authenticode ONLY when the
;  optional secrets PAYESH_WIN_PFX_B64 / PAYESH_WIN_PFX_PASS exist (owner).
; ═══════════════════════════════════════════════════════════════════
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Payesh"
#define AppPublisher "Payesh Local"
#define AppExeName "payesh_app.exe"
#define Bundle "apps\payesh\app\build\windows\x64\runner\Release"

#if !FileExists(AddBackslash(SourcePath) + "..\..\..\..\..\" + Bundle + "\" + AppExeName)
  #error payesh_app.exe not built — run: flutter build windows --release (in apps\payesh\app)
#endif
#if FileExists(AddBackslash(SourcePath) + "..\..\..\..\..\" + Bundle + "\WebView2Loader.dll")
  #error WebView2Loader.dll in the native bundle — refused (row 63)
#endif
#if FileExists(AddBackslash(SourcePath) + "..\..\..\..\..\" + Bundle + "\node.exe")
  #error node.exe in the native bundle — refused (row 63)
#endif

[Setup]
AppId={{F022A94A-885F-4620-9730-3E5EF0086EBE}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/rezaa2544/payesh.local
AppCopyright=(c) 1405 {#AppPublisher} — MIT License
AppComments=Payesh school app — native client (no WebView, no Node.js)
SourceDir=..\..\..\..\..
DefaultDirName={localappdata}\Programs\PayeshNative
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
ShowLanguageDialog=no
Uninstallable=yes
OutputDir=native-out
OutputBaseFilename=payesh-native-setup
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
VersionInfoDescription=Payesh native client installer
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "{#Bundle}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Start Payesh"; Flags: nowait postinstall skipifsilent
