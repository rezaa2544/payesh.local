# Row 173 - full Docker simulation of Payesh on one Windows PC (Docker Desktop).
#   powershell -ExecutionPolicy Bypass -File tools\sim\run-sim.ps1            # MinIO as the owner's bucket
#   powershell -ExecutionPolicy Bypass -File tools\sim\run-sim.ps1 -S3 s3-lite  # no MinIO image: tools/sim/s3-lite.js
# Builds the real repository image, starts bucket + HTTPS front + central + two school PCs on an
# INTERNAL network (no internet), runs the driver (owner panel + apps), writes
# tools\sim\out\SIM-REPORT.md + sim-result.json + compose.log and removes everything it created
# (containers, network, volumes of the project "payesh-sim" only - no other container is touched).
param(
  [ValidateSet('s3', 's3-lite')][string]$S3 = 's3',
  [switch]$Keep,
  [string]$TrustProxy = '172.16.0.0/12,192.168.0.0/16,10.0.0.0/8'
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $repo
$f = 'tools/sim/docker-compose.sim.yml'
$p = 'payesh-sim'
$prof = if ($S3 -eq 's3') { 'minio' } else { 'lite' }
$out = Join-Path $repo 'tools\sim\out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$env:SIM_S3_SERVICE = $S3
$env:SIM_TRUST_PROXY = $TrustProxy
$env:SIM_OUT_DIR = $out
$dc = @('compose', '-f', $f, '-p', $p, '--profile', $prof)
function Stamp($m) { $t = (Get-Date).ToString('HH:mm:ss'); Write-Output "[$t] $m" }

Stamp "build payesh-sim:local (repository Dockerfile)"
& docker @dc build central 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Stamp "BUILD FAILED"; exit 2 }

Stamp "up: certs, $S3, front, central, school1, school2"
$svcs = @($S3, 'front', 'central', 'school1', 'school2')
if ($S3 -eq 's3') { $svcs = @('s3', 's3-init', 'front', 'central', 'school1', 'school2') }
& docker @dc up -d @svcs 2>&1 | Select-Object -Last 12
Start-Sleep -Seconds 8
& docker @dc ps --format 'table {{.Service}}\t{{.Status}}' 2>&1

Stamp "driver (owner panel + apps) - every step is timed"
& docker @dc run --rm driver 2>&1 | ForEach-Object { $_ } | Tee-Object -FilePath (Join-Path $out 'driver.log')
$rc = $LASTEXITCODE
Stamp "driver exit $rc"

& docker @dc logs --no-color --timestamps 2>&1 | Out-File -Encoding utf8 (Join-Path $out 'compose.log')
& docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' 2>&1 | Select-String 'payesh-sim' | Out-File -Encoding utf8 (Join-Path $out 'stats.txt')
if (-not $Keep) {
  Stamp "down -v (project payesh-sim only)"
  & docker @dc --profile driver down -v --remove-orphans 2>&1 | Select-Object -Last 3
}
Stamp "report: $out\SIM-REPORT.md"
exit $rc
