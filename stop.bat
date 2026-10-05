@echo off
setlocal

echo [ JARVIS - CLEAN SHUTDOWN ]
echo ^> Terminating Windows processes on ports (11433, 4000, 8000, 8001, 7860, 8080, 8081, 8998, 8901)...
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { 11433,4000,8000,8001,7860,8080,8081,8998,8901 -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

echo ^> Terminating WSL2 background processes...
wsl --shutdown >nul 2>&1

echo ------------------------------------------------
echo All JARVIS services stopped cleanly.
echo.
