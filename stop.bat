@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-services.ps1" -Action stop
rem Hold the window open on failure when double-clicked; pass /quiet for unattended runs.
if errorlevel 1 if /i not "%~1"=="/quiet" pause
