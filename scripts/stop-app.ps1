$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Stopped = @()

foreach ($Port in @(5173, 8000)) {
    $Connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($Connection in $Connections) {
        $ProcessId = [int]$Connection.OwningProcess
        $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if (-not $ProcessInfo) { continue }
        $CommandLine = [string]$ProcessInfo.CommandLine
        $IsProjectProcess = $CommandLine.Contains($ProjectRoot) -or
            ($Port -eq 8000 -and $CommandLine.Contains("backend.app.main:app"))
        if (-not $IsProjectProcess) {
            throw "Port $Port is used by another program (PID $ProcessId); it was not stopped."
        }
        Stop-Process -Id $ProcessId -Force
        $Stopped += "port $Port / PID $ProcessId"
    }
}

if ($Stopped.Count -eq 0) {
    Write-Host "Website is already stopped."
}
else {
    Write-Host ("Stopped: " + ($Stopped -join ", "))
}
