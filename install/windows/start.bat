@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist data mkdir data
if exist runtime\node.exe (
  runtime\node.exe server\start.js
) else (
  node server\start.js
)
pause
