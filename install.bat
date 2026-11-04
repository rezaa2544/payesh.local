@echo off
chcp 65001 >nul
title نصب پایش-لوکال
rem ── نقطهٔ شروع نصب: فایل را دوبار کلیک کنید. خودش دسترسی مدیر می‌گیرد.
if exist "%~dp0install\windows\install.bat" (
  call "%~dp0install\windows\install.bat" %*
) else (
  echo فایل‌های نصب پیدا نشد. بسته را کامل از حالت zip خارج کنید.
  pause
)
