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
#if !FileExists(AddBackslash(StageDir) + "pw7.dll")
  #error pw7.dll missing in the staging folder (row 168: node.exe needs it on Windows 7/8)
#endif
#if !FileExists(AddBackslash(StageDir) + "x86\node.exe") || !FileExists(AddBackslash(StageDir) + "x86\pw7.dll")
  #error x86\node.exe / x86\pw7.dll missing in the staging folder (row 168: 32-bit Windows)
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
; Row 168: 64-bit AND 32-bit Windows 7 SP1 or newer — x64 gets the x64 node.exe, 32-bit Windows
; the win-x86 node.exe (each with its own pw7.dll for the Windows 8+ functions node 22 imports).
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=6.1sp1
OutputDir=..\..\..\native-out
OutputBaseFilename=payesh-data-service-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayName=Payesh Data Service
VersionInfoDescription=Payesh school data service (API only, for the native app)
; Row 170: the school-app setups that carry this service read its version from here
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}

[Files]
Source: "{#StageDir}\node.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: Is64BitInstallMode
Source: "{#StageDir}\pw7.dll"; DestDir: "{app}"; Flags: ignoreversion; Check: Is64BitInstallMode
Source: "{#StageDir}\x86\node.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: not Is64BitInstallMode
Source: "{#StageDir}\x86\pw7.dll"; DestDir: "{app}"; Flags: ignoreversion; Check: not Is64BitInstallMode
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
; Boot-time task (SYSTEM, no time limit, restart on failure) — registered in [Code] through the
; Task Scheduler 2.0 COM API, which exists on Windows 7 … 11 (the PowerShell ScheduledTasks module needs Windows 8+).

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN PayeshDataService"; Flags: runhidden waituntilterminated; RunOnceId: "EndTask"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -Command ""Get-WmiObject Win32_Process | Where-Object {{ $_.Name -eq 'node.exe' -and $_.ExecutablePath -like '{app}\*' } | ForEach-Object {{ [void]$_.Terminate() }"""; Flags: runhidden waituntilterminated; RunOnceId: "StopNode"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN PayeshDataService"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteTask"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=PayeshDataService"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteFirewall"

[Code]
// Row 168: the service task through Task Scheduler 2.0 (COM, Windows 7+). Same task as before:
// boot trigger, SYSTEM (service account, highest), ExecutionTimeLimit PT0S (schtasks /Create would
// stop it after 72 h), restart every minute up to 99 times; server\start.js supervises the server.
function XmlEsc(S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '&', '&amp;', True);
  StringChangeEx(Result, '<', '&lt;', True);
  StringChangeEx(Result, '>', '&gt;', True);
end;

function ServiceTaskXml(): String;
var
  App: String;
begin
  App := XmlEsc(ExpandConstant('{app}'));
  Result :=
    '<?xml version="1.0" encoding="UTF-16"?>' + #13#10 +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' +
    '<RegistrationInfo><Description>Payesh Data Service</Description></RegistrationInfo>' +
    '<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>' +
    '<Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>' +
    '<Settings>' +
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>' +
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' +
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>' +
    '<AllowHardTerminate>true</AllowHardTerminate>' +
    '<StartWhenAvailable>true</StartWhenAvailable>' +
    '<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>' +
    '<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>' +
    '<AllowStartOnDemand>true</AllowStartOnDemand>' +
    '<Enabled>true</Enabled>' +
    '<Hidden>false</Hidden>' +
    '<RunOnlyIfIdle>false</RunOnlyIfIdle>' +
    '<WakeToRun>false</WakeToRun>' +
    '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>' +
    '<Priority>7</Priority>' +
    '<RestartOnFailure><Interval>PT1M</Interval><Count>99</Count></RestartOnFailure>' +
    '</Settings>' +
    '<Actions Context="Author"><Exec><Command>"' + App + '\payesh-service.cmd"</Command><WorkingDirectory>' + App + '</WorkingDirectory></Exec></Actions>' +
    '</Task>';
end;

procedure RegisterServiceTask();
var
  Svc, Folder: Variant;
  Code: Integer;
begin
  try
    Svc := CreateOleObject('Schedule.Service');
    Svc.Connect();
    Folder := Svc.GetFolder('\');
    // 6 = TASK_CREATE_OR_UPDATE, 5 = TASK_LOGON_SERVICE_ACCOUNT. The account comes from the XML
    // principal (S-1-5-18); Pascal Script's string/Null VARIANTs are rejected by RegisterTask
    // (verified with a probe setup), so user and password stay Unassigned.
    Folder.RegisterTask('PayeshDataService', ServiceTaskXml(), 6, Unassigned, Unassigned, 5);
    Log('PayeshDataService: task registered through Task Scheduler 2.0 (COM)');
  except
    RaiseException('Payesh Data Service: the background task could not be registered (' + GetExceptionMessage() + ')');
  end;
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Run /TN PayeshDataService', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Log('PayeshDataService: schtasks /Run exit ' + IntToStr(Code));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RegisterServiceTask();
end;

// An upgrade must not fight the running service for node.exe / server\*.js.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN PayeshDataService', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq ''node.exe'' -and $_.ExecutablePath -like ''' + ExpandConstant('{app}') + '\*'' } | ForEach-Object { [void]$_.Terminate() }"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
