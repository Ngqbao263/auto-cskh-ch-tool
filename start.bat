@echo off
setlocal

cd /d %~dp0
set PLAYWRIGHT_BROWSERS_PATH=%~dp0playwright-browsers

if not exist "%~dp0logs" mkdir "%~dp0logs"
if not exist "%~dp0logs\runs" mkdir "%~dp0logs\runs"
if not exist "%~dp0logs\errors" mkdir "%~dp0logs\errors"
if not exist "%~dp0logs\uploads" mkdir "%~dp0logs\uploads"

auto-cskh.exe
pause
