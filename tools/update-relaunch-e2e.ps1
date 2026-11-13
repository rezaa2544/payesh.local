# ردیف ۱۴۸: آزمون سرتاسری به‌روزرسانی با «برنامهٔ واقعی نصب‌شده» (پنل مالک و اپ مدرسه).
#
# همان مسیری که کاربر با لمس چراغ طی می‌کند، بدون هیچ جایگزین آزمونی:
#   ۱. ساخت بعدی = همین پوشهٔ نصب + یک فایل تازه ⇒ مانیفست «فقط تغییرات» (build 999999)
#   ۲. اجرای exe نصب‌شده با `--update-from <out> --update-now` ⇒ برنامه بررسی می‌کند، فقط همان
#      یک فایل را می‌گیرد، اسکریپت اعمال را راه می‌اندازد و خودش بسته می‌شود
#   ۳. اسکریپت پس از بسته شدن برنامه کپی و هش را بررسی می‌کند و برنامه را دوباره باز می‌کند
#   ۴. شرط قبولی: نتیجهٔ ok، بدون بازگشت، پردازهٔ اول بسته شده، پردازهٔ تازه از همان exe زنده و
#      با پنجره، و فایل تازه در پوشهٔ نصب.
# خط آخر موفق: UPDATE-RELAUNCH-OK name=<app|owner> pid=<pid> window=true
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][ValidateSet('app', 'owner')][string]$Name,
  [Parameter(Mandatory = $true)][string]$Staging,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Commit
)
$ErrorActionPreference = 'Stop'
$logAbs = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log)
function Say([string]$m) { $m | Tee-Object -FilePath $logAbs -Append | Out-Host }
$exePath = Join-Path $Dir $Exe
$exeBase = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Get-Process -Name $exeBase -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$e2e = Join-Path $env:RUNNER_TEMP "relaunch-$Name"
$next = Join-Path $e2e 'next'; $out = Join-Path $e2e 'out'
if (Test-Path $e2e) { Remove-Item $e2e -Recurse -Force }
New-Item -ItemType Directory -Force $e2e | Out-Null
Copy-Item $Dir $next -Recurse -Force
$probe = "relaunch-probe-$Name-$(Get-Random)"
Set-Content -Path (Join-Path $next 'data\relaunch-probe.txt') -Value $probe -NoNewline -Encoding ascii
node tools/owner-update-manifest.mjs --name $Name --dir $next --out $out --build 999999 --commit $Commit | Tee-Object -FilePath $logAbs -Append | Out-Host
if ($LASTEXITCODE -ne 0) { throw "relaunch e2e ($Name): manifest failed" }

$res = Join-Path $Staging '999999\result.json'
$last = Join-Path $Staging 'last-apply.json'
if (Test-Path (Join-Path $Staging '999999')) { Remove-Item (Join-Path $Staging '999999') -Recurse -Force }
if (Test-Path $last) { Remove-Item $last -Force }

$first = Start-Process -FilePath $exePath -WorkingDirectory $Dir -ArgumentList '--update-from', ('"' + $out + '"'), '--update-now' -PassThru
Say "relaunch e2e ($Name): started pid=$($first.Id) --update-from $out --update-now"

# نتیجه: یا هنوز در result.json، یا برنامهٔ تازه آن را به last-apply.json برده است
$text = $null
for ($i = 0; $i -lt 240 -and -not $text; $i++) {
  Start-Sleep -Milliseconds 750
  foreach ($f in $res, $last) {
    if (Test-Path $f) {
      try {
        $t = Get-Content $f -Raw
        if ($t -and ($t | ConvertFrom-Json).build -eq 999999) { $text = $t }
      } catch { }
    }
  }
}
$alog = Join-Path $Staging '999999\apply.log'
if (Test-Path $alog) { Get-Content $alog | ForEach-Object { Say "apply.log (relaunch-$Name): $_" } }
if (-not $text) {
  $first.Refresh()
  Say "relaunch e2e ($Name): first process exited=$($first.HasExited)"
  Get-ChildItem $Staging -Recurse -ErrorAction SilentlyContinue | ForEach-Object { Say "staging: $($_.FullName)" }
  throw "relaunch e2e ($Name): no apply result — the in-app update never finished"
}
Say "relaunch e2e ${Name}: $text"
$r = $text | ConvertFrom-Json
if (-not $r.ok -or $r.rolled_back) { throw "relaunch e2e ($Name): update did not apply: $($r.message)" }
$first.Refresh()
if (-not $first.HasExited) { throw "relaunch e2e ($Name): the app did not close itself for the update" }
if (-not ($r.relaunched_pid -gt 0)) { throw "relaunch e2e ($Name): the app was not reopened (relaunched_pid=$($r.relaunched_pid))" }
$again = Get-Process -Id $r.relaunched_pid -ErrorAction SilentlyContinue
if (-not $again) { throw "relaunch e2e ($Name): reopened pid $($r.relaunched_pid) is not running" }
if ([System.IO.Path]::GetFullPath($again.Path) -ine [System.IO.Path]::GetFullPath($exePath)) { throw "relaunch e2e ($Name): reopened process is $($again.Path), not $exePath" }
$win = $false
for ($i = 0; $i -lt 40 -and -not $win; $i++) {
  $again.Refresh()
  if ($again.HasExited) { throw "relaunch e2e ($Name): reopened app exited ($($again.ExitCode))" }
  $win = $again.MainWindowHandle -ne [IntPtr]::Zero
  if (-not $win) { Start-Sleep -Milliseconds 500 }
}
if (-not $win) { throw "relaunch e2e ($Name): reopened app has no window" }
if ((Get-Content (Join-Path $Dir 'data\relaunch-probe.txt') -Raw) -ne $probe) { throw "relaunch e2e ($Name): the new file is not in the install folder" }
$old = @(Get-ChildItem $Dir -Recurse -File -Filter '*.old-*' -ErrorAction SilentlyContinue)
Say "UPDATE-RELAUNCH-OK name=$Name pid=$($again.Id) window=true old-left=$($old.Count)"
Stop-Process -Id $again.Id -Force
Start-Sleep -Seconds 2
Remove-Item (Join-Path $Dir 'data\relaunch-probe.txt') -Force -ErrorAction SilentlyContinue
