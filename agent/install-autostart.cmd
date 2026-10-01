@echo off
rem Sets up StreamScope Agent to start right after Windows logon (Task Scheduler; no admin needed).
rem To undo: Task Scheduler > Task Scheduler Library > "StreamScope Agent" > Delete.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
echo.
pause
