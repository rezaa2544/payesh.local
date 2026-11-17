# w7-package.ps1 — makes a Windows bundle start on Windows 7 SP1 / 8 / 8.1 (row 168).
#
#   pwsh tools/win7/w7-package.ps1 -Dir <bundle folder> -Arch x64|x86 [-Ucrt] [-Smoke app.exe]
#        [-NodeSmoke] [-Log file]
#
#  1. -Ucrt: deploys the Universal C Runtime app-locally (ucrtbase.dll + api-ms-win-*.dll from the
#     Windows SDK redistributable) — Windows 7 has no UCRT unless KB2999226 is installed. Windows 10+
#     always uses its own system UCRT and ignores these copies.
#  2. Every .exe/.dll in the folder that imports a Windows 8+ function is patched by w7patch.mjs
#     (import descriptors -> pw7.dll, OS version 6.0) and pw7.dll is built for exactly those imports
#     (tools/win7/pw7shim.c, mingw-w64 gcc), then verified (--verify) and re-scanned (--scan).
#  3. pw7selftest.exe compares every Windows 7 implementation with the real Windows function on
#     this machine (and runs once more with PAYESH_W7SHIM_FORCE=1).
#  4. -Smoke: starts the real app on a hidden desktop with PAYESH_W7SHIM_FORCE=1 (all Windows 7
#     code paths) and requires it to stay alive with its Flutter window.
#     -NodeSmoke: runs the patched node.exe with the Windows 7 code paths (fs, sqlite, http, timers).
# Fails (throws) on any problem.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [ValidateSet('x64', 'x86')][string]$Arch = 'x64',
  [switch]$Ucrt,
  [string]$Smoke = '',
  [switch]$NodeSmoke,
  [string]$Log = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dir = (Resolve-Path $Dir).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("pw7-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
function Say([string]$m) {
  Write-Host $m
  if ($Log) { Add-Content -Path $Log -Value $m -Encoding UTF8 }
}
# The host's node.exe (never a function or alias: PowerShell resolves names case-insensitively,
# so a helper called "Node" calling "node" recursed until "call depth overflow" on CI).
$hostNode = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
function Invoke-W7Node([string[]]$a) {
  $o = & $hostNode @a 2>&1 | ForEach-Object { "$_" }
  $script:nodeRc = $LASTEXITCODE
  return $o
}

# ── 1. app-local UCRT ──────────────────────────────────────────────────────────────────────────
if ($Ucrt) {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Redist'
  $src = Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (Test-Path (Join-Path $_.FullName "ucrt\DLLs\$Arch\ucrtbase.dll")) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  $dlls = if ($src) { Join-Path $src.FullName "ucrt\DLLs\$Arch" } else { Join-Path $kits "ucrt\DLLs\$Arch" }
  if (-not (Test-Path (Join-Path $dlls 'ucrtbase.dll'))) { throw "UCRT redistributable ($Arch) not found under $kits" }
  $n = 0
  foreach ($f in Get-ChildItem $dlls -Filter *.dll) {
    if (-not (Test-Path (Join-Path $Dir $f.Name))) { Copy-Item $f.FullName $Dir; $n++ }
  }
  Say "W7-UCRT app-local: $n DLLs <- $dlls"
}

# ── 2. patch + build pw7.dll ───────────────────────────────────────────────────────────────────
$w7 = Join-Path $here 'w7patch.mjs'
$bins = @(Get-ChildItem $Dir -File | Where-Object { $_.Extension -in '.exe', '.dll' -and $_.Name -ne 'pw7.dll' -and $_.Name -notlike 'unins*' })
$scan = Invoke-W7Node (@($w7, '--scan') + ($bins | ForEach-Object { $_.FullName }))
$bad = @($scan | Where-Object { $_ -like 'W7-BAD*' } | ForEach-Object { ($_ -replace '^W7-BAD\s+', '') -replace '\s+\[.*$', '' })
$scan | Where-Object { $_ -like 'W7-BAD*' } | ForEach-Object { Say "  needs patch: $_" }
if (-not $bad.Count) { Say "W7-PATCH nothing to patch in $Dir" }
else {
  $def = Join-Path $work 'pw7.def'
  $o = Invoke-W7Node (@($w7, '--arch', $Arch, '--def', $def) + $bad)
  $o | ForEach-Object { Say "  $_" }
  if ($nodeRc -ne 0) { throw "w7patch failed ($nodeRc)" }
  Get-ChildItem $Dir -Filter '*.pw7.json' | Remove-Item -Force
}

# mingw-w64 gcc for the target architecture (windows-latest: C:\mingw64 + MSYS2).
function Find-Gcc([string]$arch) {
  $want = if ($arch -eq 'x64') { 'x86_64-w64-mingw32' } else { 'i686-w64-mingw32' }
  $cands = if ($arch -eq 'x64') { @('C:\msys64\mingw64\bin\gcc.exe', 'C:\mingw64\bin\gcc.exe', 'C:\ProgramData\mingw64\mingw64\bin\gcc.exe') } else { @('C:\msys64\mingw32\bin\gcc.exe') }
  $p = Get-Command gcc -ErrorAction SilentlyContinue
  if ($p) { $cands += $p.Source }
  foreach ($c in $cands) {
    if (Test-Path $c) {
      $env:PATH = (Split-Path $c) + ';' + $env:PATH
      $m = (& $c -dumpmachine 2>$null | Out-String).Trim()
      if ($m -eq $want) { return $c }
    }
  }
  $pac = 'C:\msys64\usr\bin\pacman.exe'
  if (Test-Path $pac) {
    $pkg = if ($arch -eq 'x64') { 'mingw-w64-x86_64-gcc' } else { 'mingw-w64-i686-gcc' }
    Say "  installing $pkg (MSYS2)"
    # through MSYS2's own login shell; -Sy so a stale package database on the runner cannot 404
    & 'C:\msys64\usr\bin\bash.exe' -lc "pacman -Sy --noconfirm --needed $pkg" 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "  $_" }
    $c = if ($arch -eq 'x64') { 'C:\msys64\mingw64\bin\gcc.exe' } else { 'C:\msys64\mingw32\bin\gcc.exe' }
    if (Test-Path $c) { $env:PATH = (Split-Path $c) + ';' + $env:PATH; return $c }
  }
  throw "mingw-w64 gcc ($want) not found"
}
$gcc = Find-Gcc $Arch
Say "W7-GCC $gcc ($((& $gcc -dumpversion | Out-String).Trim()))"
$cflags = @('-O2', '-Wall', '-fno-builtin', '-fno-stack-protector', '-fno-tree-loop-distribute-patterns', '-s')
$entry = if ($Arch -eq 'x64') { 'DllMain' } else { '_DllMain@12' }
$shim = Join-Path $Dir 'pw7.dll'
if ($bad.Count) {
  & $gcc @cflags -shared -nostdlib -o $shim (Join-Path $here 'pw7shim.c') $def -lkernel32 -lws2_32 "-Wl,-e,$entry" 2>&1 | Where-Object { $_ -notmatch 'array-bounds|readgsqword|readfsdword|intrin-impl|NtCurrentTeb|cc1: note|In function|In file included|from |\^' } | ForEach-Object { Say "  gcc: $_" }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $shim)) { throw 'building pw7.dll failed' }
  $o = Invoke-W7Node (@($w7, '--verify', $shim) + $bad)
  $o | ForEach-Object { Say "  $_" }
  if ($nodeRc -ne 0) { throw 'pw7.dll does not satisfy the patched imports' }
}
$all = @(Get-ChildItem $Dir -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' -and $_.Name -notlike 'unins*' } | ForEach-Object { $_.FullName })
$o = Invoke-W7Node (@($w7, '--scan') + $all)
$o | ForEach-Object { Say "  $_" }
if ($nodeRc -ne 0) { throw 'Windows 8+ imports remain after patching' }
Say "W7-SCAN-OK $($all.Count) binaries"

# ── 3. selftest (real vs Windows 7 implementation) ─────────────────────────────────────────────
if (Test-Path $shim) {
  $st = Join-Path $work 'pw7selftest.exe'
  & $gcc -Os -s -municode -o $st (Join-Path $here 'pw7selftest.c') -lws2_32 2>&1 | ForEach-Object { Say "  gcc: $_" }
  if ($LASTEXITCODE -ne 0) { throw 'building pw7selftest.exe failed' }
  Copy-Item $shim $work -Force
  $r = & $st 2>&1 | ForEach-Object { "$_" }
  $r | Where-Object { $_ -notlike 'PASS*' } | ForEach-Object { Say "  $_" }
  if (-not ($r -match '^PW7-SELFTEST-OK')) { throw 'pw7 selftest failed' }
  Say "W7-SELFTEST-OK $Arch"
}

# ── 4. smoke runs with every Windows 7 code path forced ────────────────────────────────────────
if ($Smoke -or $NodeSmoke) {
  $env:PAYESH_W7SHIM_FORCE = '1'
  $env:PAYESH_W7SHIM_LOG = Join-Path $work 'fallback.log'
  try {
    if ($Smoke) {
      $run = Join-Path $work 'pw7run.exe'
      & $gcc -Os -s -municode -o $run (Join-Path $here 'pw7run.c') 2>&1 | ForEach-Object { Say "  gcc: $_" }
      if ($LASTEXITCODE -ne 0) { throw 'building pw7run.exe failed' }
      $r = (& $run 25 (Join-Path $Dir $Smoke) 2>&1 | Out-String).Trim()
      Say "  $Smoke (Windows 7 paths forced): $r"
      if ($r -notmatch '^PW7RUN-ALIVE' -or $r -notmatch 'FLUTTER_RUNNER_WIN32_WINDOW') { throw "$Smoke did not stay up with the Windows 7 code paths" }
    }
    if ($NodeSmoke) {
      $js = Join-Path $work 'smoke.js'
      Set-Content -Path $js -Encoding ASCII -Value @'
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),cp=require('child_process');
const {DatabaseSync}=require('node:sqlite');
(async()=>{
 const t=fs.mkdtempSync(path.join(os.tmpdir(),'pw7-'));fs.writeFileSync(path.join(t,'a'),'x'.repeat(1e5));fs.copyFileSync(path.join(t,'a'),path.join(t,'b'));
 const db=new DatabaseSync(path.join(t,'t.sqlite'));db.exec('create table k(v)');db.prepare('insert into k values(?)').run(Date.now());db.close();
 const s=http.createServer((q,r)=>r.end('pong')).listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));
 const b=await (await fetch('http://127.0.0.1:'+s.address().port)).text();s.close();
 const c=cp.execFileSync(process.execPath,['-p','process.env.NODE_SKIP_PLATFORM_CHECK']).toString().trim();
 fs.rmSync(t,{recursive:true,force:true});
 if(b!=='pong'||c!=='1')throw new Error('bad '+b+' '+c);
 console.log('NODE-W7-OK',process.version,process.arch);
})().catch(e=>{console.log('NODE-W7-FAIL',e.stack);process.exit(1)});
'@
      $r = (& (Join-Path $Dir 'node.exe') --experimental-sqlite --disable-warning=ExperimentalWarning $js 2>&1 | Out-String).Trim()
      Say "  node.exe (Windows 7 paths forced): $r"
      if ($r -notmatch 'NODE-W7-OK') { throw 'patched node.exe failed with the Windows 7 code paths' }
    }
    if (Test-Path $env:PAYESH_W7SHIM_LOG) { Get-Content $env:PAYESH_W7SHIM_LOG | Sort-Object -Unique | ForEach-Object { Say "  $_" } }
  } finally {
    Remove-Item Env:PAYESH_W7SHIM_FORCE -ErrorAction SilentlyContinue
    Remove-Item Env:PAYESH_W7SHIM_LOG -ErrorAction SilentlyContinue
  }
  Say 'W7-SMOKE-OK'
}
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
Say "W7-PACKAGE-OK $Dir [$Arch]"
