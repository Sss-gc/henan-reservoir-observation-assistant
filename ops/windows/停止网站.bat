@echo off
chcp 65001 >nul
set "PROJECT_ROOT=%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\stop-app.ps1"
if errorlevel 1 pause
