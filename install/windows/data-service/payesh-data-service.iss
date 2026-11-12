; ── Payesh Data Service — optional school server for the NATIVE app (row 127) ──────────────────
; A separate, optional installer next to payesh-native-setup.exe (the native Flutter app, row 77):
;   * installs the school's own Sync v1 server (server/*.js + a pinned node.exe) as a background
;     service — a boot-time scheduled task running as SYSTEM (no time limit), no window, no tray,
;     no browser;
;   * the server runs headless (PAYESH_HEADLESS=1): it serves ONLY the API (/api/health,
;     /api/auth/*, /api/v1/pull, /api/sync, …) and answers every other path with
;     404 no_web_ui — the user interface is the native app, never a web page (D‑49);
;   * first setup is accepted only from this computer (loopback): open the Payesh app here →
;     "سرور مدرسه در همین شبکه" → 127.0.0.1;
;   * opens TCP 8080 for the private/domain firewall profiles only (school LAN, not public Wi‑Fi);
;   * ships NO web UI (client\index.html, app.js, styles) and NO WebView2 — refused at build time.
; Built by native-client.yml (job `windows`) from a staging folder:
;   ISCC /DAppVersion=x.y.z /DStageDir=<abs path> install\windows\data-service\payesh-data-service.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\..\service-stage"
#endif
#if FileExists(AddBackslash(StageDir) + "client\index.html")
  #error client\index.html (web UI) found in the staging folder — the data service ships no web UI
#endif
#if FileExists(AddBackslash(StageDir) + "client\app.js")
  #error client\app.js (web UI) found in the staging folder — the data service ships no web UI
#endif
#if FileExists(AddBackslash(StageDir) + "WebView2Loader.dll")
  #error WebView2Loader.dll found in the staging folder — no browser engine in the data service
#endif
#if !FileExists(AddBackslash(StageDir) + "node.exe")
  #error node.exe missing in the staging folder
#endif
#if !FileExists(AddBackslash(StageDir) + "server\start.js")
  #error server\start.js missing in the staging folder
#endif

[Setup]
AppId={{9B1F0C52-7D3A-4E59-A6C1-2F8E4D7B3A61}
AppName=Payesh Data Service
AppVersion={#AppVersion}
AppVerName=Payesh Data Service {#AppVersion}
AppPublisher=Payesh
DefaultDirName={autopf}\PayeshDataService
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\..\native-out
OutputBaseFilename=payesh-data-service-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayName=Payesh Data Service
VersionInfoDescription=Payesh school data service (API only, for the native app)

[Files]
Source: "{#StageDir}\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\server\*.js"; DestDir: "{app}\server"; Flags: ignoreversion
Source: "{#StageDir}\client\lib\*.js"; DestDir: "{app}\client\lib"; Flags: ignoreversion
Source: "{#StageDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\releases\manifest.json"; DestDir: "{app}\releases"; Flags: ignoreversion skipifsourcedoesntexist
Source: "payesh-service.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\Payesh\data"; Flags: uninsneveruninstall

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=PayeshDataService"; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=PayeshDataService dir=in action=allow protocol=TCP localport=8080 profile=private,domain"; Flags: runhidden waituntilterminated
; Boot-time task as SYSTEM with NO execution time limit (schtasks /Create would stop it after 72 h),
; restarted by Task Scheduler if it fails to start; server\start.js itself supervises the server.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""$a = New-ScheduledTaskAction -Execute '{app}\payesh-service.cmd' -WorkingDirectory '{app}'; $t = New-ScheduledTaskTrigger -AtStartup; $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; $p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; Register-ScheduledTask -TaskName PayeshDataService -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null; Start-ScheduledTask -TaskName PayeshDataService"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN PayeshDataService"; Flags: runhidden waituntilterminated; RunOnceId: "EndTask"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -Command ""Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{app}\*' } | Stop-Process -Force"""; Flags: runhidden waituntilterminated; RunOnceId: "StopNode"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN PayeshDataService"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteTask"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=PayeshDataService"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteFirewall"

[Code]
// An upgrade must not fight the running service for node.exe / server\*.js.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN PayeshDataService', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '\*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
