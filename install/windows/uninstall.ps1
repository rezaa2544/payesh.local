# ═══════════════════════════════════════════════════════════════════
#  حذف پایش-لوکال از ویندوز
#  • وظیفهٔ زمان‌بندی، قاعدهٔ فایروال، میان‌بر‌ها و رجیستری پاک می‌شوند
#  • پوشهٔ C:\Payesh (داده‌ها) به‌طور پیش‌فرض می‌ماند تا پشتیبان بگیرید
#    حذف کامل با  -Purge   ·  بدون پرسش با  -Silent
# ═══════════════════════════════════════════════════════════════════
param([switch]$Purge, [switch]$Silent)
$ErrorActionPreference = 'Continue'

$AppId     = 'PayeshLocal'
$TargetDir = 'C:\Payesh'
$TaskName  = 'PayeshLocal'
$Firewall  = 'Payesh Local'

function Test-Admin {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  if ($Purge) { $argList += '-Purge' }
  if ($Silent) { $argList += '-Silent' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  exit
}

Write-Host "`n▶ توقف سامانه…" -ForegroundColor Cyan
schtasks /Delete /TN $TaskName /F *> $null
try {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like '*server\index.js*' -and $_.CommandLine -like '*Payesh*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }

Write-Host '▶ پاک کردن قاعدهٔ فایروال…' -ForegroundColor Cyan
Remove-NetFirewallRule -DisplayName $Firewall -ErrorAction SilentlyContinue

Write-Host '▶ پاک کردن میان‌بر‌ها…' -ForegroundColor Cyan
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  Remove-Item (Join-Path $desktop 'پایش.url') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'پایش-لوکال') -Recurse -Force -ErrorAction SilentlyContinue
} catch { }

Write-Host '▶ پاک کردن ثبت ویندوز…' -ForegroundColor Cyan
Remove-Item ("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppId") -Recurse -Force -ErrorAction SilentlyContinue

# ── داده‌ها ──
$remove = $false
if ($Purge) { $remove = $true }
elseif (-not $Silent) {
  $ans = Read-Host 'داده‌های مدرسه (دانش‌آموزان، حضور، نمره، پشتیبان‌ها) هم پاک شوند؟ (y/N)'
  if ($ans -match '^(y|Y|بله|آره)$') { $remove = $true }
}

if ($remove) {
  if (Test-Path $TargetDir) {
    Copy-Item (Join-Path $TargetDir 'data') -Destination (Join-Path $env:TEMP 'payesh-data-last') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  (یک نسخه از داده در $env:TEMP\payesh-data-last گذاشته شد)" -ForegroundColor DarkGray
  }
  Remove-Item $TargetDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '✓ برنامه و داده‌ها حذف شدند.' -ForegroundColor Yellow
} else {
  # فقط کد حذف شود، data بماند
  $keep = @('data')
  Get-ChildItem $TargetDir -Force -ErrorAction SilentlyContinue |
    Where-Object { $keep -notcontains $_.Name } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "✓ برنامه حذف شد. داده‌ها در $TargetDir\data باقی ماند." -ForegroundColor Green
}

if (-not $Silent) {
  Write-Host "`nبرای بستن این پنجره کلیدی بزنید…" -ForegroundColor DarkGray
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
