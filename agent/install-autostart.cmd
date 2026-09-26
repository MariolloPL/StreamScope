@echo off
rem Makes StreamScope Agent start automatically after you log in to Windows (current user only, no admin).
rem To undo: delete "StreamScope Agent.cmd" from the Startup folder (Win+R, shell:startup).
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\StreamScope Agent.cmd" echo @start "" pythonw "%~dp0streamscope_agent.py"
echo StreamScope Agent will start after each login.
echo Starting it now...
start "" pythonw "%~dp0streamscope_agent.py"
