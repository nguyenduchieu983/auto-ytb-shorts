param(
    [string]$NodePath = 'node.exe',
    [string]$RedisDistro = 'Ubuntu-22.04'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimeDir = Join-Path $projectRoot 'storage/runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$startupLog = Join-Path $runtimeDir 'startup.log'
function Write-Startup([string]$Message) {
    Add-Content -LiteralPath $startupLog -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}
function Invoke-Node([string[]]$NodeArguments) {
    # Windows PowerShell 5.1 treats native stderr as an ErrorRecord.
    $ErrorActionPreference = 'Continue'
    & $NodePath @NodeArguments 2>&1 | Out-File -LiteralPath $startupLog -Append -Encoding UTF8
    return $LASTEXITCODE
}
function Find-AppProcess([string]$Entry) {
    $entryPath = Join-Path $projectRoot "dist/$Entry.js"
    $pattern = [regex]::Escape($entryPath) + '(?:"|\s|$)'
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and ($_.CommandLine.Replace('/', '\') -match $pattern)
    })
}
function Start-App([string]$Name, [string]$Entry) {
    $existing = @(Find-AppProcess $Entry)
    if ($existing.Count -gt 1) { throw "Multiple $Name processes; inspect locally before restarting" }
    if ($existing.Count -eq 1) { return $existing[0].ProcessId }
    foreach ($stream in @('stdout', 'stderr')) {
        $logPath = Join-Path $runtimeDir "$Name.$stream.log"
        if (Test-Path -LiteralPath $logPath) {
            $archiveDir = Join-Path $runtimeDir 'archive'
            New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
            Copy-Item -LiteralPath $logPath -Destination (Join-Path $archiveDir "$Name.$stream.$(Get-Date -Format yyyyMMdd-HHmmss-fff).log")
        }
    }
    $process = Start-Process -FilePath $NodePath -ArgumentList ('"' + (Join-Path $projectRoot "dist/$Entry.js") + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir "$Name.stdout.log") -RedirectStandardError (Join-Path $runtimeDir "$Name.stderr.log")
    return $process.Id
}
$startupMutex = [System.Threading.Mutex]::new($false, 'Local\AutoYtbShortsStartup')
$ownsMutex = $false
try {
    try { $ownsMutex = $startupMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    $NodePath = (Get-Command $NodePath -ErrorAction Stop).Source
    foreach ($required in @('.env', 'dist/main.js', 'dist/worker.js', 'node_modules/tsx')) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $required))) { throw "Missing $required; follow README setup/build" }
    }
    $env:REDIS_WSL_DISTRO = $RedisDistro
    Write-Startup 'Startup requested (existing processes will be reused).'
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        # Do not rewrite Redis connection settings underneath existing processes.
        $apiExisting = @(Find-AppProcess 'main')
        $workerExisting = @(Find-AppProcess 'worker')
        if ($apiExisting.Count -eq 0 -and $workerExisting.Count -eq 0) {
            if ((Invoke-Node @('--import', 'tsx', 'scripts/local-redis.ts')) -ne 0) { Write-Startup "Redis unavailable (attempt $attempt)."; Start-Sleep -Seconds 10; continue }
        }
        if ((Invoke-Node @('--import', 'tsx', 'scripts/doctor.ts')) -ne 0) { Write-Startup "Dependencies unavailable (attempt $attempt)."; Start-Sleep -Seconds 10; continue }
        $apiPid = Start-App 'api' 'main'
        $workerPid = Start-App 'worker' 'worker'
        @{ api_pid = $apiPid; worker_pid = $workerPid } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'processes.json')
        Start-Sleep -Seconds 5
        if ((Invoke-Node @('scripts/runtime-ready.cjs', [string]$apiPid, [string]$workerPid)) -eq 0) { Write-Startup "Ready: API PID $apiPid, worker PID $workerPid."; exit 0 }
        Write-Startup "Waiting for API/worker readiness (attempt $attempt)."
        Start-Sleep -Seconds 10
    }
    throw 'Startup timed out; inspect dependency and process logs.'
} catch {
    # Exceptions can contain connection strings; record only a generic failure.
    Write-Startup 'Startup failed. Inspect setup, PostgreSQL/Redis and process logs locally.'
    exit 1
} finally {
    if ($ownsMutex) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}
