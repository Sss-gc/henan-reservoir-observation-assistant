$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonExe = 'C:\Users\30622\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:PYTHONPATH = Join-Path $ProjectRoot '.tools\python'
& $PythonExe (Join-Path $PSScriptRoot 'prepare_spatial_data.py')
