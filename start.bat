@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-services.ps1" -Action start
set "service_exit=%errorlevel%"
rem Hold the window open on failure when double-clicked; pass /quiet for unattended runs.
if not "%service_exit%"=="0" if /i not "%~1"=="/quiet" pause
exit /b %service_exit%
