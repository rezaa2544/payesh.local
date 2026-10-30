@echo off
chcp 65001 >nul
title نصب پایش-لوکال
echo.
echo   ┌────────────────────────────────────────────┐
echo   │        نصب سامانهٔ پایش روی این سیستم        │
echo   └────────────────────────────────────────────┘
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo   برای بستن این پنجره کلیدی بزنید.
pause >nul
