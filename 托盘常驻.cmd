@echo off
title Token Speed Monitor - tray
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found in PATH.
  echo Please install Node.js 22 or newer: https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM Tray icon: live tooltip, panel window, benchmark, autostart, quit.
start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\tray.ps1"
exit
