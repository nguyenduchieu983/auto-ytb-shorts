param(
    [ValidateSet('Install', 'Remove', 'Status')][string]$Action = 'Status',
    [string]$NodePath = 'node.exe',
    [string]$RedisDistro = 'Ubuntu-22.04'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'AutoYtbShorts-Logon'
if ($Action -eq 'Remove') {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output 'Autostart removed; running API/worker are retained.'
    exit 0
}
if ($Action -eq 'Status') {
    Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
    Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
    exit 0
}
$NodePath = (Get-Command $NodePath -ErrorAction Stop).Source
if ($NodePath.Contains('"') -or $RedisDistro.Contains('"')) { throw 'Invalid argument' }
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcher = Join-Path $projectRoot 'scripts/windows-start.ps1'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -NodePath "' + $NodePath + '" -RedisDistro "' + $RedisDistro + '"'
$taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start local Redis, API and worker after user logon; logs in storage/runtime.' -Force | Select-Object TaskName, State
Write-Output 'Autostart installed for current user, 30 seconds after logon. No password stored.'
