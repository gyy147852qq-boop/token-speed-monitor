@echo off
title Token Speed Monitor Dashboard
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

echo ==========================================================
echo  Token Speed Monitor - dashboard
echo  The dashboard opens automatically in your browser.
echo  Keep this window open; press Ctrl+C here to stop it.
echo ==========================================================
echo.

node app\server.mjs

echo.
echo Dashboard stopped.
pause
