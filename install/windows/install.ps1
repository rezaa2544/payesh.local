# ═══════════════════════════════════════════════════════════════════
#  نصب‌کنندهٔ پایش-لوکال برای ویندوز  (کامل و استاندارد)
#  • Node.js را از بستهٔ همراه (runtime\node.exe) یا سیستم پیدا/نصب می‌کند
#  • برنامه را در C:\Payesh نصب می‌کند (داده‌ها هرگز پاک نمی‌شوند)
#  • اجرای خودکار هنگام روشن شدن ویندوز (وظیفهٔ زمان‌بندی، بی‌پنجره)
#  • قاعدهٔ فایروال برای شبکهٔ مدرسه
#  • آیکون دسکتاپ + منوی استارت
#  • ثبت در «افزودن یا حذف برنامه‌ها» با حذف‌کنندهٔ واقعی
#  • راه‌اندازی سامانه و باز کردن مرورگر
#  اجرا:  install.bat  (خودش دسترسی مدیر می‌گیرد)
# ═══════════════════════════════════════════════════════════════════
param(
  [int]$Port = 8080,
  [switch]$Unattended          # برای نصب‌کنندهٔ exe: بدون پرسش، بدون توقف
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$AppName     = 'پایش-لوکال'
$AppId       = 'PayeshLocal'
$Version     = '0.0.0'
$Publisher   = 'Payesh Local'
$TargetDir   = 'C:\Payesh'
$TaskName    = 'PayeshLocal'
$Firewall    = 'Payesh Local'
$SourceDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot = Split-Path -Parent $SourceDir          # ریشهٔ بستهٔ دانلودشده

function Write-Step($m) { Write-Host "`n▶ $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  ! $m" -ForegroundColor Yellow }

function Test-Admin {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  Write-Host 'درخواست دسترسی مدیر…' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Port', $Port)
  if ($Unattended) { $argList += '-Unattended' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  exit
}

Write-Host @"

╔══════════════════════════════════════════════════════╗
║        پایش-لوکال — نصب روی سیستم مدرسه              ║
╚══════════════════════════════════════════════════════╝
"@ -ForegroundColor Blue

# ── ۰) نسخه ─────────────────────────────────────────────────────────
try {
  $pkg = Join-Path $PackageRoot 'package.json'
  if (Test-Path $pkg) { $Version = (Get-Content $pkg -Raw | ConvertFrom-Json).version }
} catch { }

# ── ۱) Node.js ──────────────────────────────────────────────────────
# ترتیب: نسخهٔ همراه بسته → نسخهٔ نصب‌شده روی سیستم → نصب خودکار
Write-Step 'بررسی Node.js'
$NodeExe = $null
$Bundled = Join-Path $PackageRoot 'runtime\node.exe'
if (Test-Path $Bundled) {
  $NodeExe = $Bundled
  Write-Ok ('نسخهٔ همراه بسته استفاده می‌شود: ' + (& $Bundled -v))
}

if (-not $NodeExe) {
  $found = $null
  try { $found = (Get-Command node -ErrorAction Stop).Source } catch { $found = $null }
  if ($found) {
    $ver = (& node -v)
    $major = [int](($ver -replace '^v', '').Split('.')[0])
    if ($major -ge 22) { $NodeExe = $found; Write-Ok "Node.js سیستم: $ver" }
    else { Write-Warn2 "Node.js نصب‌شده قدیمی است ($ver)؛ نسخهٔ ۲۲+ لازم است." }
  }
}

if (-not $NodeExe) {
  Write-Step 'نصب Node.js نسخهٔ LTS'
  $ok = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
      $ok = $true
    } catch { Write-Warn2 'winget موفق نبود؛ دانلود مستقیم…' }
  }
  if (-not $ok) {
    $msi = Join-Path $env:TEMP 'node-lts.msi'
    $url = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi'
    Write-Host "  دانلود از $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $found = $null
  try { $found = (Get-Command node -ErrorAction Stop).Source } catch { $found = $null }
  if ($found) { $NodeExe = $found; Write-Ok 'Node.js نصب شد' }
  else {
    throw 'Node.js پیدا نشد. بستهٔ کامل (payesh-setup.exe) نسخهٔ همراه دارد؛ یا از nodejs.org نسخهٔ ۲۲+ را نصب کنید.'
  }
}

# ── ۲) کپی فایل‌ها ─────────────────────────────────────────────────
Write-Step "کپی برنامه در $TargetDir"
if (Test-Path (Join-Path $TargetDir 'data\payesh.sqlite')) {
  Write-Warn2 'نصب قبلی پیدا شد — پوشهٔ data (دانش‌آموزان، حضور، نمره) دست‌نخورده می‌ماند.'
}
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir 'data') | Out-Null

$items = @('client', 'server', 'hub', 'docs', 'install', 'releases',
           'package.json', 'README.md', 'start.bat', 'start.sh', 'install.bat', 'uninstall.bat')
foreach ($item in $items) {
  $src = Join-Path $PackageRoot $item
  if (Test-Path $src) { Copy-Item $src -Destination $TargetDir -Recurse -Force }
}

# Node همراه → داخل برنامه
New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir 'runtime') | Out-Null
if (Test-Path $Bundled) {
  Copy-Item $Bundled -Destination (Join-Path $TargetDir 'runtime\node.exe') -Force
  $NodeExe = Join-Path $TargetDir 'runtime\node.exe'
}
Write-Ok 'فایل‌ها کپی شدند'

# ── ۳) اسکریپت اجرای بی‌پنجره ──────────────────────────────────────
$startHidden = Join-Path $TargetDir 'start-hidden.vbs'
$shippedVbs  = Join-Path $SourceDir 'start-hidden.vbs'
if (Test-Path $shippedVbs) {
  Copy-Item $shippedVbs -Destination $startHidden -Force     # مسیر خودش را پیدا می‌کند
} else {
  $logFile = Join-Path $TargetDir 'data\server.log'
  $vbs = "Set sh = CreateObject(""WScript.Shell"")" + "`r`n" +
         "sh.CurrentDirectory = ""$TargetDir""" + "`r`n" +
         "sh.Run """"""$NodeExe"""""" --experimental-sqlite --disable-warning=ExperimentalWarning """"""$TargetDir\server\index.js"""""" >> """"""$logFile"""""" 2>&1"", 0, False" + "`r`n"
  Set-Content -Path $startHidden -Value $vbs -Encoding UTF8
}

# ── ۴) اجرای خودکار هنگام ورود ─────────────────────────────────────
Write-Step 'ثبت اجرای خودکار'
try {
  schtasks /Query /TN $TaskName *> $null
  if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN $TaskName /F *> $null }
  $action = "wscript.exe `"$startHidden`""
  schtasks /Create /TN $TaskName /TR $action /SC ONLOGON /RL HIGHEST /F *> $null
  if ($LASTEXITCODE -eq 0) { Write-Ok 'هنگام روشن شدن ویندوز خودکار اجرا می‌شود' }
  else { Write-Warn2 'ثبت وظیفهٔ زمان‌بندی ناموفق بود (start.bat دستی هم کار می‌کند).' }
} catch { Write-Warn2 'ثبت اجرای خودکار ناموفق بود.' }

# ── ۵) فایروال ─────────────────────────────────────────────────────
Write-Step 'باز کردن درگاه برای شبکهٔ مدرسه'
try {
  Remove-NetFirewallRule -DisplayName $Firewall -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $Firewall -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any *> $null
  Write-Ok "درگاه $Port باز شد"
} catch { Write-Warn2 'تنظیم فایروال ناموفق بود؛ دستی انجام دهید.' }

# ── ۶) میان‌بر‌ها ──────────────────────────────────────────────────
Write-Step 'ساخت میان‌بر‌ها'
$url = "http://localhost:$Port/"
try {
  $shell = New-Object -ComObject WScript.Shell
  $icon = Join-Path $TargetDir 'client\icons\icon-192.png'
  $iconFile = 'C:\Windows\System32\SHELL32.dll'; $iconIndex = 14

  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = $shell.CreateShortcut((Join-Path $desktop 'پایش.url'))
  $lnk.TargetPath = $url
  $lnk.Save()

  # آیتم واقعی در منوی استارت (مثل هر برنامهٔ نصب‌شده)
  $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'پایش-لوکال'
  New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
  $sm = $shell.CreateShortcut((Join-Path $startMenu 'پایش.lnk'))
  $sm.TargetPath = 'explorer.exe'; $sm.Arguments = $url
  $sm.IconLocation = "$iconFile,$iconIndex"
  $sm.Description = 'سامانهٔ مدیریت مدرسه — پایش-لوکال'
  $sm.Save()
  $un = $shell.CreateShortcut((Join-Path $startMenu 'حذف پایش.lnk'))
  $un.TargetPath = 'powershell.exe'
  $un.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$TargetDir\uninstall.ps1`""
  $un.IconLocation = "$iconFile,31"
  $un.Save()
  Write-Ok 'آیکون دسکتاپ و منوی استارت ساخته شد'
} catch { Write-Warn2 'ساخت میان‌بر ناموفق بود.' }

# ── ۷) ثبت در «افزودن یا حذف برنامه‌ها» ───────────────────────────
Write-Step 'ثبت در فهرست برنامه‌های ویندوز'
try {
  $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppId"
  New-Item -Path $key -Force | Out-Null
  $size = 0
  try {
    $size = [int](((Get-ChildItem $TargetDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1KB)
  } catch { $size = 0 }
  Set-ItemProperty -Path $key -Name 'DisplayName'     -Value $AppName
  Set-ItemProperty -Path $key -Name 'DisplayVersion'  -Value $Version
  Set-ItemProperty -Path $key -Name 'Publisher'       -Value $Publisher
  Set-ItemProperty -Path $key -Name 'InstallLocation' -Value $TargetDir
  Set-ItemProperty -Path $key -Name 'DisplayIcon'     -Value 'C:\Windows\System32\SHELL32.dll,14'
  Set-ItemProperty -Path $key -Name 'EstimatedSize'   -Value $size
  Set-ItemProperty -Path $key -Name 'NoModify'        -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name 'NoRepair'        -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name 'UninstallString' -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $TargetDir + '\uninstall.ps1"')
  Set-ItemProperty -Path $key -Name 'QuietUninstallString' -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $TargetDir + '\uninstall.ps1" -Silent')
  Write-Ok 'در «برنامه‌ها و ویژگی‌ها» دیده می‌شود و حذف‌کردن دارد'
} catch { Write-Warn2 'ثبت در فهرست برنامه‌ها ناموفق بود.' }

# ── ۸) راه‌اندازی ──────────────────────────────────────────────────
Write-Step 'راه‌اندازی سامانه'
$running = $false
try { $running = (Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { $running = $false }
if (-not $running) {
  Start-Process wscript.exe -ArgumentList "`"$startHidden`""
  for ($i = 0; $i -lt 40 -and -not $running; $i++) {
    Start-Sleep -Milliseconds 500
    try { $running = (Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { }
  }
}
if ($running) { Write-Ok "سامانه روی درگاه $Port بالا آمد" }
else { Write-Warn2 'سامانه هنوز پاسخ نمی‌دهد — یک دقیقه بعد آیکون «پایش» را باز کنید.' }

$lanIP = ''
try {
  $lanIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress
} catch { }

Write-Host @"

╔══════════════════════════════════════════════════════════════╗
║                    نصب با موفقیت انجام شد                     ║
╚══════════════════════════════════════════════════════════════╝

  نسخه            :  $Version
  پوشهٔ برنامه     :  $TargetDir
  دادهٔ مدرسه       :  $TargetDir\data\
  آدرس همین سیستم :  http://localhost:$Port
  آدرس شبکهٔ مدرسه :  http://${lanIP}:$Port

  • روی این سیستم: آیکون «پایش» در دسکتاپ یا منوی استارت.
  • موبایل معلمان/اولیا: آدرس عمومی (تونل) را باز کنید؛ راهنما: /install
  • اولین ورود: صفحهٔ «راه‌اندازی» → نام مدیر و PIN.
  • به‌روزرسانی: پنل مدیر ← سیستم ← «بررسی آپدیت» (فقط فایل‌های تغییرکرده).
  • حذف: «برنامه‌ها و ویژگی‌ها» ← پایش-لوکال.

"@ -ForegroundColor White

try { Start-Process $url } catch { }

if (-not $Unattended) {
  Write-Host 'برای بستن این پنجره کلیدی بزنید…' -ForegroundColor DarkGray
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
