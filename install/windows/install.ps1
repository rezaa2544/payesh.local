# ═══════════════════════════════════════════════════════════════════
#  نصب‌کنندهٔ پایش-لوکال برای ویندوز
#  • Node.js را بررسی/نصب می‌کند
#  • برنامه را در C:\Payesh کپی می‌کند
#  • سرویس را هنگام روشن شدن ویندوز خودکار اجرا می‌کند
#  • فایروال را برای شبکهٔ مدرسه باز می‌کند
#  • آیکون روی دسکتاپ می‌سازد و مرورگر را باز می‌کند
# ═══════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$TargetDir   = 'C:\Payesh'
$Port        = 8080
$TaskName    = 'PayeshLocal'
$SourceDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot = Split-Path -Parent $SourceDir          # ریشهٔ بستهٔ دانلودشده

function Write-Step($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  ! $msg" -ForegroundColor Yellow }

Write-Host @"
╔══════════════════════════════════════════════════════╗
║        پایش-لوکال — نصب روی سیستم مدرسه              ║
╚══════════════════════════════════════════════════════╝
"@ -ForegroundColor Blue

# ── ۱) بررسی Node.js ────────────────────────────────────────────────
Write-Step 'بررسی Node.js'
$node = $null
try { $node = (Get-Command node -ErrorAction Stop).Source } catch { $node = $null }
if ($node) {
    $ver = (& node -v)
    Write-Ok "Node.js نصب است: $ver"
    $major = [int](($ver -replace '^v','').Split('.')[0])
    if ($major -lt 22) { Write-Warn2 'نسخهٔ Node.js قدیمی است؛ نسخهٔ ۲۲ یا بالاتر لازم است.'; $node = $null }
}
if (-not $node) {
    Write-Step 'نصب Node.js نسخهٔ LTS'
    $ok = $false
    try {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
            $ok = $true
        }
    } catch { Write-Warn2 'winget در دسترس نبود؛ دانلود دستی…' }
    if (-not $ok) {
        $msi = Join-Path $env:TEMP 'node-lts.msi'
        $url = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi'
        Write-Host "  دانلود از $url"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    if (Get-Command node -ErrorAction SilentlyContinue) { Write-Ok 'Node.js نصب شد' }
    else { throw 'نصب Node.js ناموفق بود. لطفاً از nodejs.org نسخهٔ LTS را نصب و دوباره تلاش کنید.' }
}

# ── ۲) کپی فایل‌ها ─────────────────────────────────────────────────
Write-Step "کپی برنامه به $TargetDir"
if (Test-Path $TargetDir) {
    Write-Warn2 'نسخهٔ قبلی پیدا شد؛ داده‌ها در پوشهٔ data دست‌نخورده می‌مانند.'
}
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
foreach ($item in @('server','client','releases','package.json','install')) {
    $src = Join-Path $PackageRoot $item
    if (Test-Path $src) {
        Copy-Item $src -Destination $TargetDir -Recurse -Force
    }
}
Write-Ok 'فایل‌ها کپی شدند'

# ── ۳) اسکریپت اجرا ────────────────────────────────────────────────
$startBat = Join-Path $TargetDir 'start-hidden.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$TargetDir"
sh.Run "cmd /c node --experimental-sqlite --disable-warning=ExperimentalWarning server\index.js >> data\server.log 2>&1", 0, False
"@ | Set-Content -Path $startBat -Encoding UTF8

# ── ۴) اجرای خودکار هنگام روشن شدن ویندوز ──────────────────────────
Write-Step 'ثبت اجرای خودکار'
schtasks /Query /TN $TaskName *> $null
if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN $TaskName /F | Out-Null }
$action   = "wscript.exe `"$startBat`""
schtasks /Create /TN $TaskName /TR $action /SC ONLOGON /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Ok 'سرویس پایش هنگام روشن شدن ویندوز اجرا می‌شود' }
else { Write-Warn2 'ثبت اجرای خودکار ناموفق بود؛ می‌توانید بعداً start.bat را اجرا کنید.' }

# ── ۵) فایروال ────────────────────────────────────────────────────
Write-Step 'باز کردن پورت برای شبکهٔ مدرسه'
try {
    Remove-NetFirewallRule -DisplayName 'Payesh Local' -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName 'Payesh Local' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Write-Ok "پورت $Port برای دستگاه‌های شبکه باز شد"
} catch { Write-Warn2 'تنظیم فایروال نیاز به دسترسی مدیر داشت؛ دستی انجام دهید.' }

# ── ۶) آیکون دسکتاپ ───────────────────────────────────────────────
Write-Step 'ساخت آیکون دسکتاپ'
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $url = "http://localhost:$Port/"
    $lnk = Join-Path $desktop 'پایش.url'
    "[InternetShortcut]`r`nURL=$url`r`nIconFile=C:\Windows\System32\SHELL32.dll`r`nIconIndex=14`r`n" | Set-Content -Path $lnk -Encoding ASCII
    Write-Ok 'آیکون «پایش» روی دسکتاپ ساخته شد'
} catch { Write-Warn2 'ساخت آیکون ناموفق بود' }

# ── ۷) راه‌اندازی و نمایش آدرس‌ها ───────────────────────────────────
Write-Step 'راه‌اندازی سامانه'
$running = $false
try { $running = (Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -InformationLevel Quiet) } catch { $running = $false }
if (-not $running) {
    Start-Process wscript.exe -ArgumentList "`"$startBat`""
    Start-Sleep -Seconds 3
}
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress

Write-Host @"

╔══════════════════════════════════════════════════════════════╗
║                    نصب با موفقیت انجام شد                     ║
╚══════════════════════════════════════════════════════════════╝

  آدرس روی همین سیستم :  http://localhost:$Port
  آدرس در شبکهٔ مدرسه :  http://${lanIP}:$Port

  • روی این سیستم: آیکون «پایش» را در دسکتاپ باز کنید.
  • موبایل معلمان: همان آدرس شبکهٔ مدرسه را در کروم باز و
    «افزودن به صفحهٔ اصلی» را بزنید (راهنمای کامل: /install)
  • اولین ورود: صفحهٔ «راه‌اندازی» → نام مدیر و رمز PIN را تعیین کنید.
  • به‌روزرسانی: خودکار و یک‌کلیکی؛ فقط فایل‌های تغییرکرده دانلود می‌شوند.

  پوشهٔ برنامه: $TargetDir
  دادهٔ مدرسه:   $TargetDir\data\
  (برای پشتیبان‌گیری: پنل مدیر ← پشتیبان‌گیری)

"@ -ForegroundColor White

Start-Process "http://localhost:$Port/"
