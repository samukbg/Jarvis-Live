@echo off
rem Used by the backend quick action restart-wsl: a clean WSL restart, then boot.bat.
cd /d "%~dp0"
wsl --shutdown
timeout /t 8 /nobreak >nul
call boot.bat
