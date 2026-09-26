@echo off
rem Starts StreamScope Agent in the background (no console window). Log: agent\agent.log
start "" pythonw "%~dp0streamscope_agent.py"
