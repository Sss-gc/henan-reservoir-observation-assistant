@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHON=%~dp0.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
  echo 未找到后端 Python 环境：%PYTHON%
  pause
  exit /b 1
)

echo 正在刷新25座水库最近90天的Sentinel-2和Landsat目录……
echo 该过程需要访问官方目录，可能持续数分钟。
"%PYTHON%" -m backend.app.tasks.refresh_all_imagery --days 90 --limit-per-source 500
echo.
echo 批量刷新完成。
pause
