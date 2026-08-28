@echo off
chcp 65001 >nul
set "PROJECT_ROOT=%~dp0..\.."
cd /d "%PROJECT_ROOT%"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\start-app.ps1"
set "START_RESULT=%ERRORLEVEL%"

if not "%START_RESULT%"=="0" (
  echo.
  echo Startup failed. Keep the error message above for troubleshooting.
  pause
)
exit /b %START_RESULT%
