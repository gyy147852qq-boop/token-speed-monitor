@echo off
title Token Speed Monitor
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

REM Starts the local server (hidden) and opens the dashboard in an app-style window.
start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\open-window.ps1"
exit
