@echo off
rem Makes StreamScope Agent start automatically after you log in to Windows (current user only, no admin).
rem To undo: delete "StreamScope Agent.cmd" from the Startup folder (Win+R, shell:startup).
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\StreamScope Agent.cmd" echo @start "" pythonw "%~dp0streamscope_agent.py"
echo.
echo  [OK] Autostart ustawiony: agent uruchomi sie sam po kazdym zalogowaniu do Windows.
echo.
rem Starting again is safe: a second copy notices the running agent and exits.
start "" pythonw "%~dp0streamscope_agent.py"
timeout /t 4 /nobreak >nul
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/api/info -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo  [OK] Agent dziala: http://localhost:8765
  start "" http://localhost:8765/
) else (
  echo  [!] Agent nie odpowiada. Sprawdz agent\agent.log
)
echo.
pause
