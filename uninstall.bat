@echo off
chcp 65001 >nul
title حذف پایش-لوکال
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\windows\uninstall.ps1" %*
