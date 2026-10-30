@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist data mkdir data
node --experimental-sqlite --disable-warning=ExperimentalWarning server\index.js
pause
