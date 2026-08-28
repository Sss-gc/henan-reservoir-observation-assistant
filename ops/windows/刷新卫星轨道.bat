@echo off
chcp 65001 >nul
set "PROJECT_ROOT=%~dp0..\.."
cd /d "%PROJECT_ROOT%"
set "PYTHON=%PROJECT_ROOT%\.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
  echo 未找到后端 Python 环境：%PYTHON%
  pause
  exit /b 1
)

echo 正在更新 CelesTrak OMM 并计算未来 30 天轨道几何覆盖，请稍候……
"%PYTHON%" -m backend.app.tasks.refresh_orbits --days 30
echo.
echo 刷新完成。网页重新选择水库后即可读取新结果。
pause
