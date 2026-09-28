param(
    [switch]$Supervise,
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [ValidateRange(0, 10)][int]$MaxRestarts = 3
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$env:PORT = [string]$Port
$restartCount = 0
Push-Location -LiteralPath $projectDirectory
try {
    do {
        & $nodeExecutable (Join-Path $projectDirectory 'server.js')
        $serviceExitCode = $LASTEXITCODE
        if (-not $Supervise -or $serviceExitCode -eq 0 -or $restartCount -ge $MaxRestarts) {
            exit $serviceExitCode
        }
        $restartCount += 1
        $delaySeconds = [Math]::Min(30, [Math]::Pow(2, $restartCount))
        Write-Warning "Service exited ($serviceExitCode). Restart $restartCount/$MaxRestarts in $delaySeconds seconds. Press Ctrl+C to stop."
        Start-Sleep -Seconds $delaySeconds
    } while ($restartCount -le $MaxRestarts)
} finally {
    Pop-Location
}
