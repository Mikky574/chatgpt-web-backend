@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-services.ps1" -Action start -Transport web
if errorlevel 1 if /i not "%~1"=="/quiet" pause
