@echo off
rem ── Payesh Data Service (row 127) ───────────────────────────────────────────
rem The school's own server on the local network — Sync v1 API ONLY for the native
rem Payesh app (PAYESH_HEADLESS=1: no web page, no browser, no WebView). Started at
rem boot by the scheduled task "PayeshDataService" (SYSTEM) that the installer creates.
rem School data stays in %ProgramData%\Payesh\data (kept on uninstall).
setlocal
set "PAYESH_HEADLESS=1"
set "PAYESH_DATA=%ProgramData%\Payesh\data"
set "PAYESH_UPDATE_AUTO=0"
set "PAYESH_UPDATE_AUTO_APPLY=0"
if not defined PORT set "PORT=8080"
if not exist "%PAYESH_DATA%" mkdir "%PAYESH_DATA%"
cd /d "%~dp0"
"%~dp0node.exe" --experimental-sqlite --disable-warning=ExperimentalWarning "%~dp0server\start.js" >> "%PAYESH_DATA%\server.log" 2>&1
