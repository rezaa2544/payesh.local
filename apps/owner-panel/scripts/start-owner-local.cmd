@echo off
rem ==================================================================
rem  Payesh owner panel - local run with one command (row 102)
rem  LOCAL TESTING ONLY - NOT PRODUCTION. Loopback only, no secrets needed.
rem  Needs Node.js 22+ and a checkout of the payesh.local repository
rem  after "npm ci". Inside the web bundle, set PAYESH_REPO to that checkout.
rem  Opens nothing to the network: http://127.0.0.1:8095
rem ==================================================================
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required: https://nodejs.org
  exit /b 1
)
set "LOCALUP=%~dp0local-up.js"
if not exist "%LOCALUP%" if defined PAYESH_REPO set "LOCALUP=%PAYESH_REPO%\apps\owner-panel\scripts\local-up.js"
if not exist "%LOCALUP%" (
  echo local-up.js not found. Set PAYESH_REPO to your payesh.local checkout, run "npm ci" there, then retry.
  exit /b 1
)
node "%LOCALUP%" %*
exit /b %errorlevel%
