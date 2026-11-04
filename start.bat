@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist data mkdir data
if exist runtime\node.exe (
  runtime\node.exe --experimental-sqlite --disable-warning=ExperimentalWarning server\index.js
) else (
  node --experimental-sqlite --disable-warning=ExperimentalWarning server\index.js
)
pause
