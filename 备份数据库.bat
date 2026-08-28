@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 未找到Python环境：.venv\Scripts\python.exe
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m backend.app.tasks.database_backup backup
pause
