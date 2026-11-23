# Row 175 - first install of Payesh on Windows WITHOUT the browser download.
#
# Why: a setup.exe saved by a browser carries the "downloaded from the internet" mark
# (Zone.Identifier), and Windows SmartScreen warns about every unsigned file with that mark.
# Signing needs a paid certificate the owner does not have (owner decision, row 175). This script
# downloads the SAME release file from GitHub over TLS, checks its SHA-256 against the published
# SHA256SUMS of the same release (fail closed), and runs the per-user installer silently
# (no UAC, no admin). Later updates already come from inside the app (no setup.exe at all).
#
# Usage (PowerShell, normal user):
#   School app:  irm https://raw.githubusercontent.com/rezaa2544/payesh.local/main/install/windows/get-payesh.ps1 | iex
#   Owner panel: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/rezaa2544/payesh.local/main/install/windows/get-payesh.ps1))) -App owner
#
# ASCII only on purpose: it is executed from a string (irm | iex) and by Windows PowerShell 5.1.
param(
    [ValidateSet('school', 'owner')]
    [string]$App = 'school',
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Direct file links only (row 161): the same files the README and the downloads release link to.
$spec = @{
    school = @{ File = 'payesh-native-setup.exe'; Dir = 'PayeshNative'; Exe = 'payesh_app.exe'; Name = 'Payesh (school app)'
        Url = 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/payesh-native-setup.exe'
        Sums = 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/SHA256SUMS' }
    owner  = @{ File = 'payesh-owner-setup.exe'; Dir = 'PayeshOwner'; Exe = 'payesh_owner.exe'; Name = 'Payesh owner panel'
        Url = 'https://github.com/rezaa2544/payesh.local/releases/download/owner-continuous/payesh-owner-setup.exe'
        Sums = 'https://github.com/rezaa2544/payesh.local/releases/download/owner-continuous/SHA256SUMS' }
}[$App]
$work = Join-Path $env:TEMP ('payesh-get-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

# WebClient, not Invoke-WebRequest: IWR in Windows PowerShell 5.1 is extremely slow for a 50 MB file
# (seen on the owner's PC: no progress after 12 minutes while curl ran at ~200 KB/s). Neither writes the
# Zone.Identifier mark.
function Get-File([string]$url, [string]$out) {
    for ($i = 1; $i -le 3; $i++) {
        $wc = New-Object System.Net.WebClient
        try {
            $wc.Headers['User-Agent'] = 'payesh-get/175'
            $wc.DownloadFile($url, $out)
            return
        } catch {
            if ($i -eq 3) { throw "download failed: $url ($($_.Exception.Message))" }
            Start-Sleep -Seconds (3 * $i)
        } finally {
            $wc.Dispose()
        }
    }
}

function Get-Sha256([string]$path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($path)
    try { return (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $fs.Dispose(); $sha.Dispose() }
}

try {
    Write-Host "[payesh] $($spec.Name): downloading $($spec.Url) ..."
    $sums = Join-Path $work 'SHA256SUMS'
    $setup = Join-Path $work $spec.File
    Get-File $spec.Sums $sums
    Get-File $spec.Url $setup

    # Fail closed: the file must be listed in SHA256SUMS and match it exactly.
    $want = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
        $p = $line.Trim() -split '\s+'
        if ($p.Count -ge 2 -and ($p[1].TrimStart('*') -eq $spec.File)) { $want = $p[0].ToLowerInvariant() }
    }
    if (-not $want -or $want -notmatch '^[0-9a-f]{64}$') { throw "$($spec.File) is not listed in SHA256SUMS - not installing" }
    $got = Get-Sha256 $setup
    if ($got -ne $want) { throw "SHA-256 mismatch for $($spec.File) (got $got, want $want) - not installing" }
    Write-Host "[payesh] SHA-256 OK $got"

    # Per-user Inno Setup installer (PrivilegesRequired=lowest): no UAC, data is kept on upgrade.
    $p = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "installer exit code $($p.ExitCode)" }

    $exe = Join-Path $env:LOCALAPPDATA "Programs\$($spec.Dir)\$($spec.Exe)"
    if (-not (Test-Path -LiteralPath $exe)) { throw "installed program not found: $exe" }
    Write-Host "[payesh] INSTALL-OK $exe"
    if (-not $NoLaunch) { Start-Process -FilePath $exe | Out-Null }
} catch {
    Write-Host "[payesh] FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[payesh] Nothing was changed if the check failed. You can also download $($spec.Url) and compare it with $($spec.Sums)."
    throw
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
