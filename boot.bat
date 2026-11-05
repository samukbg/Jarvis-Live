@echo off
setlocal

rem JARVIS System Boot Script
rem Description: Centralized boot for FUI, Neural Backend, Live Avatar, and Local Engines.

echo [ JARVIS LIVE ]

rem 1. Cleanup existing processes
echo ^> Purging local ports and orphan links...
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { 11433,4000,8000,8001,7860,8080,8081,8998,8901,8010,9931 -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
rem Restart WSL so the renderer starts on a clean GPU - see clean_wsl.py.
wsl --shutdown >nul 2>&1

rem Which WSL distro has the AVTR-1 renderer (the first common name with /root/avtr-1).
rem Set JARVIS_WSL_DISTRO before running boot.bat to override. Child processes inherit it.
if not defined JARVIS_WSL_DISTRO for %%D in (Ubuntu Ubuntu-24.04 Ubuntu-22.04 Debian) do if not defined JARVIS_WSL_DISTRO if exist "\\wsl.localhost\%%D\root\avtr-1" set "JARVIS_WSL_DISTRO=%%D"

rem 2. Start RealtimeSTT Server (port 8001)
echo ^> Starting RealtimeSTT Engine (Port 8001)...
cd voice_engine\code
start /B python realtime_stt_server.py > NUL 2>&1
cd ..\..

rem 2b. Start Live Avatar Neural Renderer in WSL2 - RTX GPU, port 8000
rem Bring the renderer's WSL copy up to date with git first - code, voices, pixi env.
if defined JARVIS_WSL_DISTRO call live_avatar\sync_to_wsl.bat
if not defined JARVIS_WSL_DISTRO goto :no_renderer
if not exist streamer_win_env\Scripts\python.exe goto :no_renderer
echo ^> Starting AVTR-1 GPU Neural Renderer in WSL2 %JARVIS_WSL_DISTRO% on port 8000...
start /B streamer_win_env\Scripts\python.exe run_renderer_wsl.py > live_avatar_renderer.log 2>&1
goto :renderer_done
:no_renderer
echo ^> No AVTR-1 renderer here - needs streamer_win_env and a WSL distro with /root/avtr-1. Skipping.
:renderer_done

rem 2b2. Voice server (XTTS on this machine's GPU, port 8010) when it is installed
rem (live_avatar\voice_server\setup_voice_server.bat); another machine's streamer uses it via XTTS_URL.
if exist voice_env\Scripts\python.exe (
    echo ^> Starting Jarvis voice server on port 8010...
    start /B voice_env\Scripts\python.exe live_avatar\voice_server\server.py > voice_server.log 2>&1
)

rem 2c. Start Live Avatar WebRTC Streamer on Native Windows (Port 7860)
if not exist streamer_win_env\Scripts\python.exe goto :no_streamer
echo ^> Starting Live Avatar WebRTC Streamer on Native Windows (Port 7860)...
start /B streamer_win_env\Scripts\python.exe live_avatar\run_streamer_windows.py > live_avatar.log 2>&1
goto :streamer_done
:no_streamer
echo ^> streamer_win_env is not installed - live avatar off on this machine.
:streamer_done

rem 2d. The LFM voice (llama-server, port 9931) is started by the backend itself: backend\voice\lfmRuntime.js.

rem 3. Start Orchestration Backend (Node.js)
echo ^> Activating Neural Orchestrator (Port 4000)...
cd backend
start /B cmd /c "npm start > ..\backend.log 2>&1"
cd ..

rem 4. Start Frontend UI (Vite)
echo ^> Launching FUI Dashboard (Port 11433)...
start /B cmd /c "npm run dev > frontend.log 2>&1"

echo ------------------------------------------------
echo SYSTEM ONLINE.
echo Local FUI: http://localhost:11433
echo Press ANY KEY to shutdown all local services.
pause >nul

echo ^> Shutting down JARVIS...
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { 11433,4000,8000,8001,7860,8080,8081,8998,8901,8010,9931 -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
wsl --shutdown >nul 2>&1

echo Shutdown complete.
