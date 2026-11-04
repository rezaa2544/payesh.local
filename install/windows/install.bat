@echo off
chcp 65001 >nul
title نصب پایش-لوکال
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
