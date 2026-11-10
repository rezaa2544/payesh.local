# ═══════════════════════════════════════════════════════════════════
#  ساخت PayeshOwner.exe — پوستهٔ ویندوز پنل مالک (ADR‑62)
#  الگو: desktop/build.ps1 اپ مدرسه، اما خروجی، شناسه و منبع کاملاً جدا.
#  اجرا (ریشهٔ مخزن):  powershell -ExecutionPolicy Bypass -File apps\owner-panel\desktop\build.ps1
#  خروجی: .build\owner\desktop\PayeshOwner.exe + DLLهای WebView2
# ═══════════════════════════════════════════════════════════════════
param(
  [string]$Out = ".build\owner\desktop",
  [string]$SdkVersion = "1.0.2903.40",
  [string]$Version = ""
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here '..\..\..')).Path
Set-Location $root

$csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'csc.exe پیدا نشد (نیاز به .NET Framework 4.8)' }
Write-Host "csc: $csc"

# WebView2 SDK با نسخهٔ ثابت و بررسی sha256 فایل دریافتی در لاگ
$tmp = Join-Path $env:TEMP ('payesh-owner-wv2-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$nupkg = Join-Path $tmp 'webview2.zip'
$u = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$SdkVersion/microsoft.web.webview2.$SdkVersion.nupkg"
Invoke-WebRequest -Uri $u -OutFile $nupkg -UseBasicParsing
Write-Host ("WebView2 SDK $SdkVersion sha256=" + (Get-FileHash $nupkg -Algorithm SHA256).Hash.ToLower())
Expand-Archive -Path $nupkg -DestinationPath (Join-Path $tmp 'pkg') -Force
$pkg = Join-Path $tmp 'pkg'
$libDir = $null
foreach ($base in @('lib_manual', 'lib')) {
  foreach ($tf in @('net45', 'net462', 'net472', 'net48')) {
    $cand = Join-Path $pkg (Join-Path $base $tf)
    if (Test-Path (Join-Path $cand 'Microsoft.Web.WebView2.Core.dll')) { $libDir = $cand; break }
  }
  if ($libDir) { break }
}
if (-not $libDir) { throw 'پوشهٔ net45 برای WebView2 پیدا نشد' }
$core = Join-Path $libDir 'Microsoft.Web.WebView2.Core.dll'
$winf = Join-Path $libDir 'Microsoft.Web.WebView2.WinForms.dll'
$loader = Get-ChildItem $pkg -Filter WebView2Loader.dll -Recurse | Where-Object { $_.FullName -match 'win-x64' } | Select-Object -First 1
if (-not $loader) { throw 'WebView2Loader.dll (win-x64) پیدا نشد' }

if (-not $Version) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
$fileVersion = (($Version + '.0.0.0').Split('.')[0..3]) -join '.'
$verSrc = Join-Path $tmp 'OwnerVersion.cs'
@"
using System.Reflection;
using System.Runtime.InteropServices;
[assembly: AssemblyTitle("Payesh Owner Panel")]
[assembly: AssemblyDescription("Payesh platform owner panel (thin WebView2 shell, ADR-62)")]
[assembly: AssemblyProduct("Payesh Owner Panel")]
[assembly: AssemblyCompany("Payesh Local")]
[assembly: AssemblyCopyright("(c) 1405 Payesh Local - MIT License")]
[assembly: AssemblyVersion("$fileVersion")]
[assembly: AssemblyFileVersion("$fileVersion")]
[assembly: AssemblyInformationalVersion("$Version")]
[assembly: ComVisible(false)]
"@ | Set-Content -Path $verSrc -Encoding UTF8

if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force -Path $Out | Out-Null }
$exe = Join-Path $Out 'PayeshOwner.exe'
$cscArgs = @(
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/warnaserror-',
  "/out:$exe",
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  "/r:$core", "/r:$winf",
  ("/win32icon:" + (Join-Path $here 'payesh-owner.ico')),
  ("/win32manifest:" + (Join-Path $here 'app.manifest')),
  $verSrc,
  (Join-Path $here 'PayeshOwner.cs')
)
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "کامپایل PayeshOwner.exe ناموفق (کد $LASTEXITCODE)" }
if (-not (Test-Path $exe)) { throw 'PayeshOwner.exe ساخته نشد' }
Copy-Item $core (Join-Path $Out 'Microsoft.Web.WebView2.Core.dll') -Force
Copy-Item $winf (Join-Path $Out 'Microsoft.Web.WebView2.WinForms.dll') -Force
Copy-Item $loader.FullName (Join-Path $Out 'WebView2Loader.dll') -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("PayeshOwner.exe {0:N0} KB — نسخهٔ {1}" -f ((Get-Item $exe).Length / 1KB), $Version)
