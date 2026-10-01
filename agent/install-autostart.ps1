# Starts StreamScope Agent right after you log in to Windows (current user, no admin).
# Uses Task Scheduler: unlike the Startup folder, which Windows may delay by several minutes after logon,
# a logon-triggered task starts immediately and is restarted if it stops.
# Falls back to the HKCU Run key if the task cannot be created. Removes the old Startup-folder entry.
$ErrorActionPreference = 'Stop'
$agent = Join-Path $PSScriptRoot 'streamscope_agent.py'
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { Write-Host ' [!] Nie znaleziono pythonw (Python). Zainstaluj Pythona i uruchom ponownie.'; exit 1 }
$user = "$env:USERDOMAIN\$env:USERNAME"
$name = 'StreamScope Agent'

$old = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\StreamScope Agent.cmd'
if (Test-Path $old) { Remove-Item $old -Force; Write-Host ' [OK] Usunieto stary wpis z folderu Autostart.' }

$mode = $null
try {
    $action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$agent`"" -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $name -ErrorAction SilentlyContinue
    $mode = 'task'
    Write-Host ' [OK] Autostart ustawiony w Harmonogramie zadan: agent startuje od razu po zalogowaniu.'
} catch {
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $name -Value "`"$pyw`" `"$agent`""
    $mode = 'run'
    Write-Host " [OK] Harmonogram zadan niedostepny ($($_.Exception.Message)); autostart ustawiony przez rejestr (Run)."
}

# Start it now (a second copy exits by itself if the agent already runs).
if ($mode -eq 'task') { Start-ScheduledTask -TaskName $name } else { Start-Process $pyw -ArgumentList "`"$agent`"" -WorkingDirectory $PSScriptRoot }
Start-Sleep -Seconds 4
try {
    Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/api/info -TimeoutSec 5 | Out-Null
    Write-Host ' [OK] Agent dziala: http://localhost:8765'
    Start-Process 'http://localhost:8765/'
} catch {
    Write-Host ' [!] Agent nie odpowiada. Sprawdz agent\agent.log'
}
