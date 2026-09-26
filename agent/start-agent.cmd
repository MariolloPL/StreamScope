@echo off
rem Starts StreamScope Agent in the background (no console window) and opens StreamScope in the browser.
rem Safe to run when the agent already runs: the second copy exits. Log: agent\agent.log
start "" pythonw "%~dp0streamscope_agent.py"
timeout /t 3 /nobreak >nul
start "" http://localhost:8765/
