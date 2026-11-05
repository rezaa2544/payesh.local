# ═══════════════════════════════════════════════════════════════════
#  ساخت برنامهٔ ویندوز پایش (Payesh.exe) — یک پنجرهٔ واقعی، بدون مرورگر
#  روی Windows Server 2022/10/11 و در CI اجرا می‌شود.
#  نیاز: .NET Framework 4.8 (روی همهٔ ویندوزهای ۱۰/۱۱ هست) + WebView2 SDK
#  اجرا: powershell -ExecutionPolicy Bypass -File desktop\build.ps1 [-Out <dir>]
# ═══════════════════════════════════════════════════════════════════
param(
  [string]$Out = ".build\win\desktop",
  [string]$SdkVersion = "1.0.2903.40"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($m) { Write-Host "▶ $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "  ✓ $m" -ForegroundColor Green }

# ── ۱) کامپایلر سی‌شارپ (همراه ویندوز) ──────────────────────────────
Say 'پیدا کردن csc.exe'
$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  $csc = (Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'MSBuild') -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
          Select-Object -First 1).FullName
}
if (-not $csc) { throw 'csc.exe پیدا نشد (نیاز به .NET Framework 4.8)' }
Ok $csc

# ── ۲) WebView2 SDK از NuGet ────────────────────────────────────────
Say 'دریافت WebView2 SDK'
$tmp = Join-Path $env:TEMP ('payesh-wv2-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$nupkg = Join-Path $tmp 'webview2.zip'
function Get-Nupkg([string]$ver) {
  $u = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$ver/microsoft.web.webview2.$ver.nupkg"
  Invoke-WebRequest -Uri $u -OutFile $nupkg -UseBasicParsing
}
try {
  Get-Nupkg $SdkVersion
} catch {
  Write-Host "  ↻ نسخهٔ $SdkVersion در دسترس نبود؛ آخرین نسخه گرفته می‌شود" -ForegroundColor Yellow
  $idx = Invoke-RestMethod -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json' -UseBasicParsing
  $latest = ($idx.versions | Where-Object { $_ -notmatch '-' } | Select-Object -Last 1)
  if (-not $latest) { throw 'نسخه‌ای از WebView2 SDK پیدا نشد' }
  $SdkVersion = $latest
  Get-Nupkg $SdkVersion
}
Expand-Archive -Path $nupkg -DestinationPath (Join-Path $tmp 'pkg') -Force
$pkg = Join-Path $tmp 'pkg'

# csc از .NET Framework استفاده می‌کند → همیشه پوشهٔ net45 (نه netcoreapp/net6)
$libDir = $null
foreach ($base in @('lib_manual', 'lib')) {
  foreach ($tf in @('net45', 'net462', 'net472', 'net48')) {
    $cand = Join-Path $pkg (Join-Path $base $tf)
    if ((Test-Path $cand) -and (Test-Path (Join-Path $cand 'Microsoft.Web.WebView2.Core.dll'))) { $libDir = Get-Item $cand; break }
  }
  if ($libDir) { break }
}
if (-not $libDir) { throw 'پوشهٔ net45 برای WebView2 پیدا نشد' }
$core = Join-Path $libDir.FullName 'Microsoft.Web.WebView2.Core.dll'
$winf = Join-Path $libDir.FullName 'Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path $core) -or -not (Test-Path $winf)) { throw "DLLهای WebView2 پیدا نشد در $($libDir.FullName)" }
Ok "SDK: $($libDir.Name)"

$loader = Get-ChildItem $pkg -Filter WebView2Loader.dll -Recurse |
          Where-Object { $_.FullName -match 'win-x64' } | Select-Object -First 1
if (-not $loader) { $loader = Get-ChildItem $pkg -Filter WebView2Loader.dll -Recurse | Select-Object -First 1 }
if (-not $loader) { throw 'WebView2Loader.dll پیدا نشد' }

# ── ۳) شناسنامهٔ فایل اجرایی (استاندارد مایکروسافت) ────────────────
#  هر فایل اجرایی ویندوز باید نام محصول، شرکت، نسخه و حق نشر داشته باشد؛
#  بدون این‌ها «ویژگی‌های فایل» خالی است و ویندوز برنامه را ناشناس می‌بیند.
Say 'ساختن شناسنامهٔ فایل (Version Info)'
$pkgVersion = '0.0.0'
try {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.version) { $pkgVersion = [string]$pkg.version }
} catch { }
$fileVersion = ($pkgVersion + '.0').Split('.')[0..3] -join '.'
$verSrc = Join-Path $env:TEMP ('payesh-ver-' + [Guid]::NewGuid().ToString('N') + '.cs')
$verCode = @"
using System.Reflection;
using System.Resources;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Payesh Local")]
[assembly: AssemblyDescription("Payesh Local - school management system (desktop app)")]
[assembly: AssemblyProduct("Payesh Local")]
[assembly: AssemblyCompany("Payesh Local")]
[assembly: AssemblyCopyright("(c) 1404 Payesh Local - MIT License")]
[assembly: AssemblyTrademark("Payesh Local")]
[assembly: AssemblyConfiguration("Release")]
[assembly: AssemblyVersion("$fileVersion")]
[assembly: AssemblyFileVersion("$fileVersion")]
[assembly: AssemblyInformationalVersion("$pkgVersion")]
[assembly: NeutralResourcesLanguage("fa")]
[assembly: ComVisible(false)]
"@
Set-Content -Path $verSrc -Value $verCode -Encoding UTF8
Ok "نسخهٔ $pkgVersion داخل Payesh.exe نوشته می‌شود"

# ── ۴) کامپایل ─────────────────────────────────────────────────────
Say 'کامپایل Payesh.exe'
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force -Path $Out | Out-Null }
$exe = Join-Path $Out 'Payesh.exe'
$ico = Join-Path $root 'install\windows\payesh.ico'
$manifest = Join-Path $root 'desktop\app.manifest'
$cscArgs = @(
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
  "/out:$exe",
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll', '/r:System.Net.NetworkInformation.dll',
  "/r:$core", "/r:$winf"
)
if (Test-Path $ico) { $cscArgs += "/win32icon:$ico" }
# مانیفست: بدون درخواست دسترسی مدیر + نمایش درست در ویندوز ۱۰/۱۱
if (Test-Path $manifest) { $cscArgs += "/win32manifest:$manifest"; Ok 'مانیفست asInvoker/PerMonitorV2 پیوست شد' }
else { throw 'desktop\app.manifest پیدا نشد — بدون آن ویندوز پنجرهٔ دسترسی مدیر نشان می‌دهد' }
$cscArgs += $verSrc
$cscArgs += (Join-Path $root 'desktop\PayeshApp.cs')

& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "کامپایل ناموفق (کد $LASTEXITCODE)" }
if (-not (Test-Path $exe)) { throw 'Payesh.exe ساخته نشد' }
Ok ("Payesh.exe — {0:N0} کیلوبایت" -f ((Get-Item $exe).Length / 1KB))

Copy-Item $core (Join-Path $Out 'Microsoft.Web.WebView2.Core.dll') -Force
Copy-Item $winf (Join-Path $Out 'Microsoft.Web.WebView2.WinForms.dll') -Force
Copy-Item $loader.FullName (Join-Path $Out 'WebView2Loader.dll') -Force
Copy-Item $ico (Join-Path $Out 'payesh.ico') -Force -ErrorAction SilentlyContinue
Ok 'DLLها و آیکون کنار برنامه گذاشته شدند'

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $verSrc -Force -ErrorAction SilentlyContinue
Write-Host "`n✅ برنامهٔ ویندوز آماده است: $Out" -ForegroundColor Green
