@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1"
set "START_RESULT=%ERRORLEVEL%"

if not "%START_RESULT%"=="0" (
  echo.
  echo Startup failed. Keep the error message above for troubleshooting.
  pause
)
exit /b %START_RESULT%
