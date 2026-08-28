param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PythonPath = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$BundledPnpm = "C:\Users\30622\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
$BackendUrl = "http://127.0.0.1:8000/api/v1/health"
$FrontendUrl = "http://127.0.0.1:5173/"
$LogDirectory = Join-Path $ProjectRoot "backend\data"
$ApplicationLogDirectory = Join-Path $LogDirectory "logs"

function Test-HttpEndpoint {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Get-ListeningProcessId {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return $null
}

function Rotate-LaunchLog {
    param(
        [string]$Path,
        [long]$MaximumBytes = 1048576,
        [int]$Keep = 3
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -lt $MaximumBytes) { return }
    $oldest = "$Path.$Keep"
    if (Test-Path -LiteralPath $oldest) { Remove-Item -LiteralPath $oldest -Force }
    for ($index = $Keep - 1; $index -ge 1; $index--) {
        $source = "$Path.$index"
        if (Test-Path -LiteralPath $source) {
            Move-Item -LiteralPath $source -Destination "$Path.$($index + 1)" -Force
        }
    }
    Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
}

if (-not (Test-Path -LiteralPath $PythonPath)) {
    throw "Python environment not found: $PythonPath"
}

$PnpmPath = $null
if (Test-Path -LiteralPath $BundledPnpm) {
    $PnpmPath = $BundledPnpm
}
else {
    $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($pnpmCommand) { $PnpmPath = $pnpmCommand.Source }
}
if (-not $PnpmPath) {
    throw "pnpm was not found. Reinstall the project dependencies."
}

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $ApplicationLogDirectory -Force | Out-Null

$DesiredVersion = $null
$configText = Get-Content -Raw (Join-Path $ProjectRoot "backend\app\config.py")
if ($configText -match 'APP_VERSION\s*=\s*"([^"]+)"') {
    $DesiredVersion = $Matches[1]
}

$BackendReady = Test-HttpEndpoint $BackendUrl
if ($BackendReady -and $DesiredVersion) {
    try {
        $runningVersion = (Invoke-RestMethod -Uri $BackendUrl -TimeoutSec 2).version
        if ($runningVersion -ne $DesiredVersion) {
            $oldProcessId = Get-ListeningProcessId 8000
            if ($oldProcessId) {
                $oldCommand = (Get-CimInstance Win32_Process -Filter "ProcessId=$oldProcessId" -ErrorAction SilentlyContinue).CommandLine
                if ($oldCommand -like "*uvicorn*backend.app.main:app*") {
                    Write-Host "Updating backend from $runningVersion to $DesiredVersion ..."
                    Stop-Process -Id $oldProcessId -Force
                    Start-Sleep -Milliseconds 500
                    $BackendReady = $false
                }
            }
        }
    }
    catch {
        $BackendReady = $false
    }
}

if (-not $BackendReady) {
    if (Get-ListeningProcessId 8000) {
        throw "Port 8000 is already used by another application."
    }
    Write-Host "Starting backend API ..."
    $backendStdout = Join-Path $LogDirectory "server.stdout.log"
    $backendStderr = Join-Path $LogDirectory "server.stderr.log"
    Rotate-LaunchLog $backendStdout
    Rotate-LaunchLog $backendStderr
    Start-Process -FilePath $PythonPath `
        -ArgumentList @("-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8000", "--log-config", "backend/logging.local.json") `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $backendStdout `
        -RedirectStandardError $backendStderr `
        -WindowStyle Hidden | Out-Null
}
else {
    Write-Host "Backend is already running."
}

$FrontendReady = Test-HttpEndpoint $FrontendUrl
if (-not $FrontendReady) {
    if (Get-ListeningProcessId 5173) {
        throw "Port 5173 is already used by another application."
    }
    Write-Host "Starting frontend ..."
    $frontendStdout = Join-Path $LogDirectory "frontend.stdout.log"
    $frontendStderr = Join-Path $LogDirectory "frontend.stderr.log"
    Rotate-LaunchLog $frontendStdout
    Rotate-LaunchLog $frontendStderr
    $pnpmInvocation = '"{0}" dev --host 127.0.0.1' -f $PnpmPath
    Start-Process -FilePath $env:ComSpec `
        -ArgumentList @("/d", "/c", $pnpmInvocation) `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $frontendStdout `
        -RedirectStandardError $frontendStderr `
        -WindowStyle Hidden | Out-Null
}
else {
    Write-Host "Frontend is already running."
}

$deadline = (Get-Date).AddSeconds(30)
do {
    $BackendReady = Test-HttpEndpoint $BackendUrl
    $FrontendReady = Test-HttpEndpoint $FrontendUrl
    if ($BackendReady -and $FrontendReady) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

if (-not $BackendReady) {
    throw "Backend did not start within 30 seconds. See backend\data\server.stderr.log."
}
if (-not $FrontendReady) {
    throw "Frontend did not start within 30 seconds. See backend\data\frontend.stderr.log."
}

Write-Host "Application is ready at $FrontendUrl"
if (-not $NoBrowser) {
    Write-Host "Opening the web browser ..."
    Start-Process -FilePath $FrontendUrl
}
