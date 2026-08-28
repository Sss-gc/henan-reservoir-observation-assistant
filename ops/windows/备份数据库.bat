@echo off
chcp 65001 >nul
set "PROJECT_ROOT=%~dp0..\.."
cd /d "%PROJECT_ROOT%"
if not exist ".venv\Scripts\python.exe" (
  echo 未找到Python环境：%PROJECT_ROOT%\.venv\Scripts\python.exe
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m backend.app.tasks.database_backup backup
pause
