@echo off
:: Check for administrative privileges
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo ==========================================================
    echo ERROR: Administrator privileges required!
    echo Please right-click this file and select 'Run as administrator'.
    echo ==========================================================
    pause
    exit /b 1
)

echo [ JARVIS - FIREWALL CONFIGURATION ]
echo ^> Adding inbound firewall rule for Jarvis Python WebRTC Streamer...
netsh advfirewall firewall delete rule name="Jarvis Live Avatar Streamer" >nul 2>&1
netsh advfirewall firewall add rule name="Jarvis Live Avatar Streamer" dir=in action=allow program="%~dp0streamer_win_env\Scripts\python.exe" enable=yes profile=any

echo ^> Adding inbound firewall rule for WebRTC UDP Media Traffic...
netsh advfirewall firewall delete rule name="Jarvis WebRTC UDP" >nul 2>&1
netsh advfirewall firewall add rule name="Jarvis WebRTC UDP" dir=in action=allow protocol=UDP localport=1024-65535 enable=yes profile=any

echo ----------------------------------------------------------
echo SUCCESS: Windows Firewall configured for remote Live Avatar WebRTC!
echo.
pause
